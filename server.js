/**
 * SPX COMMAND v9 — Fully Self-Contained
 * ─────────────────────────────────────────────────────────────────────────────
 * No TradingView dependency. Uses Alpaca live data for all signals.
 *
 * SIGNAL ENGINE:
 *   - Fetches SPY 5-min bars from Alpaca every 5 minutes
 *   - Calculates ORB (9:30-9:45 AM ET, 15-min range)
 *   - Calculates VWAP, RSI(14), EMA(9/21)
 *   - MODERATE mode: ORB + VWAP + RSI must agree
 *   - STRICT mode:   ORB + VWAP + RSI + EMA must agree
 *   - GEX filter: blocks signals at walls, sets TP targets
 *
 * EXIT STRATEGY:
 *   Price monitor (30s) + DELETE /v2/positions — no sell orders
 *
 * DATABASE:
 *   SQLite on /data/spx_command.db (Railway Volume)
 *   Tables: signals, trades, gex_snapshots
 *
 * ENV VARIABLES:
 *   ALPACA_KEY, ALPACA_SECRET, ALPACA_BASE_URL
 *   ACCOUNT_SIZE, RISK_DOLLARS, RISK_PER_TRADE
 *   MAX_DAILY_LOSS, PREMIUM_STOP_PCT
 *   TP1_MULTIPLIER, TP1_FIXED_MOVE
 *   GEX_BUFFER, SIGNAL_MODE (MODERATE or STRICT)
 *   PORT
 */

"use strict";
require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const fs      = require("fs");
const path    = require("path");

// ── Config ────────────────────────────────────────────────────────────────────
const ALPACA_KEY       = process.env.ALPACA_KEY       || "";
const ALPACA_SECRET    = process.env.ALPACA_SECRET    || "";
const ALPACA_BASE      = (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets").replace(/\/$/, "");
const ALPACA_DATA      = "https://data.alpaca.markets";
const ACCOUNT_SIZE     = parseFloat(process.env.ACCOUNT_SIZE     || "100000");
const RISK_DOLLARS     = parseFloat(process.env.RISK_DOLLARS     || "2000");
const RISK_PER_TRADE   = parseFloat(process.env.RISK_PER_TRADE   || "0.02");
const MAX_DAILY_LOSS   = parseFloat(process.env.MAX_DAILY_LOSS   || "0.06");
const PREMIUM_STOP_PCT = parseFloat(process.env.PREMIUM_STOP_PCT || "0.25");
const TP1_MULTIPLIER   = parseFloat(process.env.TP1_MULTIPLIER   || "3.0");
const TP1_FIXED_MOVE   = parseFloat(process.env.TP1_FIXED_MOVE   || "0");
const GEX_BUFFER       = parseFloat(process.env.GEX_BUFFER       || "1.0");
const SIGNAL_MODE      = (process.env.SIGNAL_MODE || "MODERATE").toUpperCase().split(" ")[0]; // MODERATE or STRICT
const PORT             = parseInt(process.env.PORT               || "3001");
const IS_PAPER         = ALPACA_BASE.includes("paper");
const ORB_MINUTES      = 15; // 9:30–9:45 ET
const MAX_TRADES_DAY   = parseInt(process.env.MAX_TRADES_DAY || "3");

function getRiskBudget() { return RISK_DOLLARS > 0 ? RISK_DOLLARS : ACCOUNT_SIZE * RISK_PER_TRADE; }
function calcContracts(p) { return !p||p<=0 ? 1 : Math.max(1, Math.floor(getRiskBudget()/(p*100))); }
function calcTP1(entry, delta) {
  if (TP1_FIXED_MOVE > 0) return parseFloat((entry + TP1_FIXED_MOVE*(delta||0.35)).toFixed(2));
  return parseFloat((entry * TP1_MULTIPLIER).toFixed(2));
}

// ── State ─────────────────────────────────────────────────────────────────────
let sessionPnL      = 0;
let dailyLoss       = 0;
let signalHistory   = [];
let sseClients      = [];
let logHistory      = [];
let gexCache        = null;
let gexCacheTime    = 0;
let gexFired        = new Set();
let gexLastDate     = "";
let orbState        = null;   // { high, low, built, date }
let lastBarTime     = null;   // last processed 5-min bar timestamp
let scanActive      = false;
let tradesDay       = 0;
const MAX_LOGS      = 500;
const GEX_SCHEDULE  = [{h:9,m:25},{h:10,m:30},{h:12,m:0},{h:14,m:0}];

// ── SQLite Database ───────────────────────────────────────────────────────────
const DB_DIR  = fs.existsSync("/data") ? "/data" : __dirname;
const DB_FILE = path.join(DB_DIR, "spx_command.db");

// ── JSON-based database (no native deps, persists to /data) ──────────────────
// Stores trades, signals, gex_snapshots as JSON files
// Compatible with Railway Volume — no SQLite compilation needed

function loadDB(table) {
  const file = path.join(DB_DIR, table+".json");
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file,"utf8"));
  } catch(e) { log("DB ERR","Load "+table+": "+e.message); }
  return [];
}

function saveDB(table, rows) {
  const file = path.join(DB_DIR, table+".json");
  try { fs.writeFileSync(file, JSON.stringify(rows, null, 2)); } catch(e) { log("DB ERR","Save "+table+": "+e.message); }
}

function insertDB(table, row) {
  const rows = loadDB(table);
  row.id = rows.length > 0 ? rows[rows.length-1].id + 1 : 1;
  rows.push(row);
  saveDB(table, rows);
  return row;
}

function initDB() {
  // Ensure DB dir exists
  if (!fs.existsSync(DB_DIR)) { try { fs.mkdirSync(DB_DIR, {recursive:true}); } catch(_){} }
  // Create empty tables if missing
  ["signals","trades","gex_snapshots"].forEach(t => {
    const file = path.join(DB_DIR, t+".json");
    if (!fs.existsSync(file)) saveDB(t, []);
  });
  log("DB", "JSON database initialized at "+DB_DIR);
}

// Shim for compatibility
const db = true; // always "connected"
function dbRun(sql, params) { return null; } // not used — insertDB used directly
function dbAll(sql, params) { return []; }   // not used — loadDB used directly

function saveSignalToDB(sig, indicators, fired, blockedReason) {
  try {
    return insertDB("signals", {
      timestamp:      new Date().toISOString(),
      date:           new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"}),
      time:           new Date().toLocaleTimeString("en-US",{hour12:false,timeZone:"America/New_York"}),
      direction:      sig.direction,
      spy_price:      sig.spyEntry,
      orb_high:       indicators.orbHigh||null,
      orb_low:        indicators.orbLow||null,
      vwap:           indicators.vwap||null,
      rsi:            indicators.rsi||null,
      ema9:           indicators.ema9||null,
      ema21:          indicators.ema21||null,
      gex_regime:     gexCache?.regime||null,
      gex_flip:       gexCache?.gammaFlip||null,
      nearest_wall:   sig.gexTarget||null,
      signal_strength:sig.strength||null,
      signal_mode:    SIGNAL_MODE,
      fired:          fired?1:0,
      blocked_reason: blockedReason||null,
    });
  } catch(e) { log("DB ERR","saveSignalToDB: "+e.message); return null; }
}

function saveTradeToDB(trade, signalDbId, indicators) {
  try {
    const pnlPct = trade.closePnl&&trade.totalCost
      ? parseFloat(((trade.closePnl/trade.totalCost)*100).toFixed(1)) : null;
    return insertDB("trades", {
      signal_id:      signalDbId||null,
      timestamp:      new Date().toISOString(),
      date:           new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"}),
      time:           new Date().toLocaleTimeString("en-US",{hour12:false,timeZone:"America/New_York"}),
      bot:            "SPX-COMMAND-v9",
      symbol:         trade.optionSymbol,
      direction:      trade.direction,
      right_type:     trade.right,
      strike:         trade.strike,
      expiry:         trade.expiry,
      contracts:      trade.contracts,
      fill_price:     trade.fillPrice,
      total_cost:     trade.totalCost,
      stop_price:     trade.stopPrice,
      tp1_price:      trade.tp1Price,
      close_price:    trade.closePrice||null,
      close_reason:   trade.closeReason||null,
      max_price:      trade.maxPrice!=null?trade.maxPrice:null,
      min_price:      trade.minPrice!=null?trade.minPrice:null,
      max_pnl_pct:    trade.maxPnlPct!=null?trade.maxPnlPct:null,
      min_pnl_pct:    trade.minPnlPct!=null?trade.minPnlPct:null,
      pnl:            trade.closePnl||null,
      pnl_pct:        pnlPct,
      duration_min:   trade.durationMin||null,
      outcome:        trade.outcome||null,
      gex_regime:     gexCache?.regime||null,
      gex_flip:       gexCache?.gammaFlip||null,
      orb_high:       indicators?.orbHigh||null,
      orb_low:        indicators?.orbLow||null,
      vwap_at_entry:  indicators?.vwap||null,
      rsi_at_entry:   indicators?.rsi||null,
      ema9_at_entry:  indicators?.ema9||null,
      ema21_at_entry: indicators?.ema21||null,
      tp1_mode:       TP1_FIXED_MOVE>0?"fixed-$"+TP1_FIXED_MOVE:TP1_MULTIPLIER+"x",
      risk_budget:    getRiskBudget(),
      signal_mode:    SIGNAL_MODE,
    });
  } catch(e) { log("DB ERR","saveTradeToDB: "+e.message); return null; }
}

function saveGEXSnapshot(g) {
  try {
    insertDB("gex_snapshots", {
      timestamp:   new Date().toISOString(),
      spot_price:  g.spotPrice,
      net_gex:     g.netGex,
      regime:      g.regime,
      gamma_flip:  g.gammaFlip,
      call_wall_1: g.callWalls?.[0]?.price||null,
      call_wall_2: g.callWalls?.[1]?.price||null,
      call_wall_3: g.callWalls?.[2]?.price||null,
      put_wall_1:  g.putWalls?.[0]?.price||null,
      put_wall_2:  g.putWalls?.[1]?.price||null,
      put_wall_3:  g.putWalls?.[2]?.price||null,
    });
  } catch(e) { log("DB ERR","saveGEXSnapshot: "+e.message); }
}

// ── Logging ───────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const t = new Date().toLocaleTimeString("en-US",{hour12:false,timeZone:"America/New_York"});
  const e = {type:"log",time:t,tag,msg};
  console.log("["+t+" ET] ["+tag+"] "+msg);
  logHistory.push(e);
  if (logHistory.length>MAX_LOGS) logHistory.shift();
  broadcast(e);
}

/**
 * Recursively strip non-serializable / internal fields before broadcasting.
 * Specifically targets signal._monitorInterval (a live setInterval Timeout handle)
 * which previously caused "Converting circular structure to JSON" on EVERY
 * broadcast that carried a signal object — silently breaking the dashboard
 * and flooding Railway logs with ~1 crash per 4 seconds all session.
 */
function sanitizeForBroadcast(obj, seen) {
  seen = seen || new WeakSet();
  if (obj === null || typeof obj !== "object") return obj;
  if (seen.has(obj)) return undefined; // break circular refs defensively
  seen.add(obj);

  if (Array.isArray(obj)) {
    return obj.map(v => sanitizeForBroadcast(v, seen));
  }

  const out = {};
  for (const key of Object.keys(obj)) {
    if (key.startsWith("_")) continue; // drop _monitorInterval, _dbId-style internals
    const val = obj[key];
    // Timeout/Interval handles are objects with no enumerable own props that matter to us —
    // detect by duck-typing (has _idleTimeout / _onTimeout, Node's internal Timeout shape)
    if (val && typeof val === "object" && ("_idleTimeout" in val || "_onTimeout" in val)) continue;
    if (typeof val === "function") continue;
    out[key] = (val && typeof val === "object") ? sanitizeForBroadcast(val, seen) : val;
  }
  return out;
}

function broadcast(p) {
  try {
    const safe = sanitizeForBroadcast(p);
    const d = "data: "+JSON.stringify(safe)+"\n\n";
    sseClients.forEach(c=>{ try{c.write(d);}catch(_){} });
  } catch(e) {
    // Use console.error directly, NOT log() — log() calls broadcast(), which would recurse
    console.error("[BROADCAST ERR] "+e.message);
  }
}

// ── Alpaca helpers ─────────────────────────────────────────────────────────────
function aH() {
  return {"APCA-API-KEY-ID":ALPACA_KEY,"APCA-API-SECRET-KEY":ALPACA_SECRET,
    "Content-Type":"application/json","Accept":"application/json"};
}
async function aGet(p, base) {
  const r = await fetch((base||ALPACA_BASE)+p,{headers:aH()});
  if (!r.ok){const e=await r.text();throw new Error("GET "+p+" "+r.status+": "+e);}
  return r.json();
}
async function aPost(p, body) {
  const r = await fetch(ALPACA_BASE+p,{method:"POST",headers:aH(),body:JSON.stringify(body)});
  if (!r.ok){const e=await r.text();throw new Error("POST "+p+" "+r.status+": "+e);}
  return r.json();
}
async function aDel(p) {
  const r = await fetch(ALPACA_BASE+p,{method:"DELETE",headers:aH()});
  return {ok:r.ok,status:r.status,data:r.ok?await r.json().catch(()=>({})):await r.text()};
}

// ── Market data ───────────────────────────────────────────────────────────────
/**
 * Fetch SPY 5-minute bars for today from Alpaca
 * Returns array of { t, o, h, l, c, v } sorted oldest first
 */
async function getSPYBars() {
  try {
    const now    = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const today  = now.toISOString().slice(0,10);
    const start  = today+"T09:30:00-04:00";
    const url    = ALPACA_DATA+"/v2/stocks/SPY/bars?timeframe=5Min&start="+
                   encodeURIComponent(start)+"&limit=100&feed=iex";
    const r      = await fetch(url,{headers:aH()});
    if (!r.ok) { log("DATA ERR","Bars "+r.status); return []; }
    const data   = await r.json();
    return (data.bars||[]).sort((a,b)=>new Date(a.t)-new Date(b.t));
  } catch(e) { log("DATA ERR","getSPYBars: "+e.message); return []; }
}

async function getSPYQuote() {
  try {
    const r = await fetch(ALPACA_DATA+"/v2/stocks/SPY/quotes/latest",{headers:aH()});
    if (!r.ok) return null;
    const d = await r.json();
    const q = d.quote||{};
    const p = parseFloat(q.ap||q.bp||0);
    return p>0?p:null;
  } catch(_) { return null; }
}

// ── Technical Indicators ──────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k   = 2/(period+1);
  let   ema = closes.slice(0,period).reduce((a,b)=>a+b,0)/period;
  for (let i=period; i<closes.length; i++) ema = closes[i]*k + ema*(1-k);
  return parseFloat(ema.toFixed(4));
}

function calcRSI(closes, period=14) {
  if (closes.length < period+1) return null;
  let gains=0, losses=0;
  for (let i=1; i<=period; i++) {
    const d = closes[i]-closes[i-1];
    if (d>0) gains+=d; else losses-=d;
  }
  let ag=gains/period, al=losses/period;
  for (let i=period+1; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag = (ag*(period-1)+(d>0?d:0))/period;
    al = (al*(period-1)+(d<0?-d:0))/period;
  }
  return al===0 ? 100 : parseFloat((100-100/(1+ag/al)).toFixed(2));
}

function calcVWAP(bars) {
  if (!bars.length) return null;
  let cumPV=0, cumV=0;
  for (const b of bars) {
    const tp = (b.h+b.l+b.c)/3;
    cumPV += tp*b.v;
    cumV  += b.v;
  }
  return cumV>0 ? parseFloat((cumPV/cumV).toFixed(4)) : null;
}

/**
 * Build ORB from first ORB_MINUTES of bars
 * Returns { high, low, built } or null
 */
function buildORB(bars) {
  const etDate = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const today  = etDate.toISOString().slice(0,10);

  // Reset ORB on new day
  if (!orbState || orbState.date !== today) {
    orbState = { high:null, low:null, built:false, date:today };
  }

  if (orbState.built) return orbState;

  // ORB bars: 9:30 to 9:30+ORB_MINUTES
  const orbEnd = new Date(today+"T09:30:00-04:00");
  orbEnd.setMinutes(orbEnd.getMinutes()+ORB_MINUTES);

  const orbBars = bars.filter(b=>{
    const bt = new Date(b.t);
    return bt >= new Date(today+"T09:30:00-04:00") && bt < orbEnd;
  });

  if (orbBars.length < 3) return null; // need at least 3 bars to confirm ORB

  orbState.high  = parseFloat(Math.max(...orbBars.map(b=>b.h)).toFixed(2));
  orbState.low   = parseFloat(Math.min(...orbBars.map(b=>b.l)).toFixed(2));
  orbState.built = true;

  log("ORB","Built ✓ | High: $"+orbState.high+" | Low: $"+orbState.low+
    " | Range: $"+( orbState.high-orbState.low).toFixed(2));
  broadcast({type:"orb_update",...orbState});
  return orbState;
}

/**
 * Run full indicator suite on current bars
 * Returns { price, orbHigh, orbLow, vwap, rsi, ema9, ema21, orbBreak, direction }
 */
function calcIndicators(bars, currentPrice) {
  if (!bars.length) return null;
  const closes = bars.map(b=>b.c);
  const orb    = orbState?.built ? orbState : null;
  const vwap   = calcVWAP(bars);
  const rsi    = calcRSI(closes);
  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const price  = currentPrice || closes[closes.length-1];

  // ORB breakout direction
  let orbBreak = null;
  if (orb) {
    if (price > orb.high) orbBreak = "LONG";
    if (price < orb.low)  orbBreak = "SHORT";
  }

  return { price, orbHigh:orb?.high||null, orbLow:orb?.low||null,
    vwap, rsi, ema9, ema21, orbBreak };
}

/**
 * Evaluate signal based on SIGNAL_MODE
 * MODERATE: ORB + VWAP + RSI
 * STRICT:   ORB + VWAP + RSI + EMA
 * Returns { fire, direction, strength, reason, failed }
 */
function evaluateSignal(ind) {
  if (!ind || !ind.orbBreak) return {fire:false,reason:"No ORB breakout"};
  if (!ind.vwap)             return {fire:false,reason:"No VWAP"};
  if (!ind.rsi)              return {fire:false,reason:"No RSI"};

  const dir   = ind.orbBreak;
  const isLong = dir==="LONG";
  const failed = [];
  const passed = [];

  // ORB — already confirmed by orbBreak
  passed.push("ORB "+dir);

  // VWAP
  if (isLong  && ind.price > ind.vwap) passed.push("VWAP above");
  else if (!isLong && ind.price < ind.vwap) passed.push("VWAP below");
  else failed.push("VWAP "+( isLong ? "price below VWAP" : "price above VWAP"));

  // RSI — avoid extremes
  const rsiOk = isLong ? ind.rsi<75&&ind.rsi>40 : ind.rsi>25&&ind.rsi<60;
  if (rsiOk) passed.push("RSI "+ind.rsi);
  else failed.push("RSI "+ind.rsi+" ("+(isLong?"overbought >75 or weak <40":"oversold <25 or weak >60")+")");

  // EMA (STRICT mode only)
  if (SIGNAL_MODE==="STRICT") {
    if (!ind.ema9||!ind.ema21) {
      failed.push("EMA unavailable");
    } else {
      const emaOk = isLong ? ind.ema9>ind.ema21 : ind.ema9<ind.ema21;
      if (emaOk) passed.push("EMA9 "+(isLong?"above":"below")+" EMA21");
      else failed.push("EMA9 "+(isLong?"below EMA21 (bearish)":"above EMA21 (bullish)"));
    }
  }

  const required = SIGNAL_MODE==="STRICT" ? 4 : 3;
  const fire     = failed.length===0 && passed.length>=required;

  const strength = fire ? (passed.length===required ? "MODERATE" : "STRONG") : "WEAK";
  const reason   = fire
    ? "✓ "+passed.join(" | ")
    : "✗ Failed: "+failed.join(", ")+" | Passed: "+passed.join(", ");

  return {fire, direction:dir, strength, reason, passed, failed};
}

// ── GEX (using real greeks via OPRA feed — Algo Trader Plus) ──────────────────
const OPTIONS_FEED = process.env.OPTIONS_FEED || "opra"; // "opra" (paid, real greeks) or "indicative" (free, no greeks)
let fullChainCache = null; // full chain with greeks, refreshed alongside GEX — used by strike selector

async function calcGEX() {
  try {
    log("GEX","Calculating from Alpaca chain ("+OPTIONS_FEED+" feed)...");
    const spot = await getSPYQuote();
    if (!spot) { log("GEX ERR","No SPY spot"); return null; }
    log("GEX","SPY: $"+spot.toFixed(2));

    const d   = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const exp = d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");

    // Fetch option chain with greeks directly — correct endpoint per Alpaca docs:
    // GET /v1beta1/options/snapshots/{underlying_symbol}?feed=opra&expiration_date=YYYY-MM-DD
    const contracts = [];
    let chainNext = null;
    do {
      let url = ALPACA_DATA+"/v1beta1/options/snapshots/SPY?feed="+OPTIONS_FEED+"&limit=1000"+
        "&expiration_date="+exp;
      if (chainNext) url += "&page_token="+chainNext;
      const r = await fetch(url, {headers:aH()});
      if (!r.ok) {
        const errTxt = await r.text();
        log("GEX ERR","Chain "+r.status+": "+errTxt);
        if (OPTIONS_FEED==="opra" && r.status===403) {
          log("GEX","OPRA feed forbidden — falling back to indicative (no greeks)");
        }
        break;
      }
      const data = await r.json();
      const snaps = data.snapshots||{};
      for (const [sym,snap] of Object.entries(snaps)) contracts.push({symbol:sym,...snap});
      chainNext = data.next_page_token||null;
    } while(chainNext);

    if (!contracts.length) { log("GEX ERR","No contracts returned for "+exp); return null; }

    // Confirm we have real greeks (opra feed) vs not (indicative feed)
    const sample = contracts.find(c=>c.greeks && c.greeks.gamma);
    const hasRealGreeks = !!sample;
    log("GEX", hasRealGreeks
      ? "✓ Real greeks present (OPRA) — sample gamma: "+sample.greeks.gamma
      : "⚠ No greeks in response — using OI×proxy fallback");

    // Cache full chain (with greeks) for strike selection later
    fullChainCache = { contracts, spot, expiry:exp, updatedAt:new Date().toISOString() };

    const strikeMap={};
    let parsed=0, skipped=0, oiAvailableCount=0;

    for (const c of contracts) {
      const sym = c.symbol||"";
      if (sym.length<21) continue;
      const right  = sym[12];
      const strike = parseFloat(sym.slice(13,21))/1000;
      let   oi      = parseFloat(c.openInterest||0);
      let   gamma  = parseFloat((c.greeks||{}).gamma||0);

      if (!strike) continue;
      if (oi > 0) oiAvailableCount++;

      // Fallback gamma proxy only if real greeks unavailable
      if (!gamma) {
        const dist  = Math.abs(strike - spot);
        const sigma = spot * 0.02;
        gamma = (1/(sigma*Math.sqrt(2*Math.PI))) * Math.exp(-0.5*Math.pow(dist/sigma,2));
      }

      // FIX: Alpaca's options snapshots endpoint does not return openInterest at all
      // (confirmed empirically — every contract had oi=0, so the old `if(!oi) continue`
      // line silently discarded ALL contracts every single time, producing "No GEX data"
      // on every run regardless of feed tier). When OI is genuinely missing, fall back to
      // a flat assumed weight of 1 so relative GEX between strikes (driven by gamma) still
      // produces a usable wall ranking, rather than zeroing out the whole calculation.
      if (!oi) oi = 1;

      const gex = gamma * oi * 100 * spot;
      if (!strikeMap[strike]) strikeMap[strike]={call:0,put:0};
      if (right==="C") strikeMap[strike].call += gex;
      if (right==="P") strikeMap[strike].put  -= gex;
      parsed++;
    }
    log("GEX","Parsed: "+parsed+" | OI available on "+oiAvailableCount+"/"+contracts.length+" contracts (0 expected — Alpaca snapshots endpoint doesn't return OI) | Real greeks: "+hasRealGreeks);


    const strikes=Object.keys(strikeMap).map(Number).sort((a,b)=>a-b);
    if(!strikes.length){log("GEX ERR","No GEX data");return null;}

    let net=0,cum=0,flip=spot;
    const levels=strikes.map(s=>{const n=strikeMap[s].call+strikeMap[s].put;net+=n;return{strike:s,...strikeMap[s],net:n};});
    for(const l of levels){const p=cum;cum+=l.net;if((p<0&&cum>=0)||(p>=0&&cum<0)){flip=l.strike;break;}}

    const callWalls=levels.filter(l=>l.strike>spot&&l.call>0).sort((a,b)=>b.call-a.call).slice(0,5).map(l=>({price:l.strike,gex:Math.round(l.call)}));
    const putWalls =levels.filter(l=>l.strike<spot&&l.put<0).sort((a,b)=>a.put-b.put).slice(0,5).map(l=>({price:l.strike,gex:Math.round(Math.abs(l.put))}));

    const result={callWalls,putWalls,gammaFlip:parseFloat(flip.toFixed(2)),
      netGex:Math.round(net),regime:net>=0?"positive":"negative",
      spotPrice:spot,updatedAt:new Date().toISOString(),hasRealGreeks};

    log("GEX","✓ Regime:"+result.regime+" | Flip:$"+result.gammaFlip+
      " | Calls:"+callWalls.slice(0,3).map(w=>"$"+w.price).join(","));
    broadcast({type:"gex_update",...result});
    saveGEXSnapshot(result);
    return result;
  } catch(e){log("GEX ERR","calcGEX: "+e.message);return null;}
}

async function getGEX(force) {
  const now=Date.now();
  const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
  if(today!==gexLastDate){gexFired=new Set();gexLastDate=today;gexCache=null;gexCacheTime=0;}
  if(!force&&gexCache&&(now-gexCacheTime)<7200000) return gexCache;
  const r=await calcGEX();
  if(r){gexCache=r;gexCacheTime=now;}
  return gexCache;
}

function applyGEX(direction, entry) {
  if(!gexCache) return {allowed:true,reason:"No GEX",tp1:entry*(direction==="LONG"?1.005:0.995),tp2:entry*(direction==="LONG"?1.01:0.99),target:null};
  if(direction==="LONG"){
    const walls=(gexCache.callWalls||[]).filter(w=>w.price>entry+GEX_BUFFER).sort((a,b)=>a.price-b.price);
    if(!walls.length) return {allowed:true,reason:"No call wall above",tp1:entry+2,tp2:entry+4,target:null};
    if(walls[0].price-entry<GEX_BUFFER) return {allowed:false,reason:"LONG blocked — at call wall $"+walls[0].price,tp1:walls[0].price,tp2:walls[0].price,target:walls[0].price};
    return {allowed:true,reason:"LONG → call wall $"+walls[0].price,tp1:walls[0].price,tp2:(walls[1]||walls[0]).price,target:walls[0].price};
  }
  if(direction==="SHORT"){
    const walls=(gexCache.putWalls||[]).filter(w=>w.price<entry-GEX_BUFFER).sort((a,b)=>b.price-a.price);
    if(!walls.length) return {allowed:true,reason:"No put wall below",tp1:entry-2,tp2:entry-4,target:null};
    if(entry-walls[0].price<GEX_BUFFER) return {allowed:false,reason:"SHORT blocked — at put wall $"+walls[0].price,tp1:walls[0].price,tp2:walls[0].price,target:walls[0].price};
    return {allowed:true,reason:"SHORT → put wall $"+walls[0].price,tp1:walls[0].price,tp2:(walls[1]||walls[0]).price,target:walls[0].price};
  }
  return {allowed:true,reason:"No GEX filter",tp1:entry,tp2:entry,target:null};
}

// ── Strike selection (greeks-optimized when real data available) ─────────────
/**
 * Score each candidate strike between ATM and the GEX target by:
 *   payoff_score = estimated_gain_at_target / premium_cost
 * estimated_gain_at_target ≈ delta × (target - entry) + 0.5 × gamma × (target-entry)²
 * (delta-gamma approximation of option price change for a move to target)
 *
 * Filters out strikes with abnormally high IV relative to the chain median
 * (overpriced contracts give worse R:R even if direction is correct).
 *
 * Falls back to the old OTM-by-distance heuristic if real greeks aren't cached.
 */
function selectStrike(price, direction, target) {
  const atm = Math.round(price);

  // No GEX cache at all → pure ATM fallback
  if (!gexCache) return {strike:atm,reason:"ATM (no GEX)",delta:0.50,otm:0};

  const isPos = gexCache.regime==="positive";
  const haveChain = fullChainCache && fullChainCache.contracts && gexCache.hasRealGreeks;

  // ── Greeks-optimized path ────────────────────────────────────────────────
  if (haveChain && target) {
    const right = direction==="LONG" ? "C" : "P";
    const move  = target - price; // signed distance to target

    // Build candidate list: contracts of the right type between ATM and target
    const candidates = [];
    for (const c of fullChainCache.contracts) {
      const sym = c.symbol||"";
      if (sym.length<21 || sym[12]!==right) continue;
      const strike = parseFloat(sym.slice(13,21))/1000;
      const inRange = direction==="LONG" ? (strike>=atm-1 && strike<=target) : (strike<=atm+1 && strike>=target);
      if (!inRange) continue;

      const greeks = c.greeks||{};
      const delta  = Math.abs(parseFloat(greeks.delta||0));
      const gamma  = parseFloat(greeks.gamma||0);
      const iv     = parseFloat(greeks.impliedVolatility||greeks.iv||0);
      const mid    = ((parseFloat(c.latestQuote?.bp||0)+parseFloat(c.latestQuote?.ap||0))/2)||0;

      if (!delta || !mid || mid<=0) continue;
      candidates.push({strike, delta, gamma, iv, mid, symbol:sym});
    }

    if (candidates.length) {
      const ivs = candidates.map(c=>c.iv).filter(v=>v>0).sort((a,b)=>a-b);
      const medianIV = ivs.length ? ivs[Math.floor(ivs.length/2)] : 0;

      const scored = candidates.map(c => {
        // Delta-gamma approximation of option price change to target
        const estMove = c.delta*Math.abs(move) + 0.5*c.gamma*Math.pow(move,2);
        const payoffScore = estMove / c.mid; // bigger = better R:R per $ paid
        const ivPenalty = medianIV>0 && c.iv > medianIV*1.3 ? 0.6 : 1.0; // discount overpriced IV
        return {...c, score: payoffScore*ivPenalty};
      }).sort((a,b)=>b.score-a.score);

      const best = scored[0];
      if (best) {
        return {
          strike: best.strike,
          reason: "Greeks-optimized: δ"+best.delta.toFixed(2)+" γ"+best.gamma.toFixed(4)+
                   " IV"+(best.iv*100).toFixed(0)+"% → best payoff/cost toward $"+target.toFixed(2),
          delta: best.delta,
          gamma: best.gamma,
          impliedVol: best.iv,
          otm: Math.abs(best.strike-atm),
          method: "greeks",
        };
      }
    }
    log("STRIKE","No valid greeks-scored candidates — falling back to heuristic");
  }

  // ── Heuristic fallback (no real greeks, or no candidates found) ─────────
  if(direction==="LONG"){
    const walls=(gexCache.callWalls||[]).filter(w=>w.price>price).sort((a,b)=>a.price-b.price);
    if(!walls.length) return {strike:atm+1,reason:"OTM+1",delta:0.45,otm:1,method:"heuristic"};
    const dist=walls[0].price-price, otm=Math.min(5,Math.max(1,Math.round(dist*(isPos?0.30:0.15))));
    return {strike:Math.min(Math.round(atm+otm),Math.round(walls[0].price-1)),reason:(isPos?"pos":"neg")+" GEX → "+otm+" OTM toward $"+walls[0].price,delta:Math.max(0.15,0.50-otm*0.08),otm,method:"heuristic"};
  }
  if(direction==="SHORT"){
    const walls=(gexCache.putWalls||[]).filter(w=>w.price<price).sort((a,b)=>b.price-a.price);
    if(!walls.length) return {strike:atm-1,reason:"OTM+1",delta:0.45,otm:1,method:"heuristic"};
    const dist=price-walls[0].price, otm=Math.min(5,Math.max(1,Math.round(dist*(isPos?0.30:0.15))));
    return {strike:Math.max(Math.round(atm-otm),Math.round(walls[0].price+1)),reason:(isPos?"pos":"neg")+" GEX → "+otm+" OTM toward $"+walls[0].price,delta:Math.max(0.15,0.50-otm*0.08),otm,method:"heuristic"};
  }
  return {strike:atm,reason:"ATM fallback",delta:0.50,otm:0,method:"heuristic"};
}

// ── OCC helpers ───────────────────────────────────────────────────────────────
function buildSymbol(strike,right,date) {
  const yy=String(date.getFullYear()).slice(2),mm=String(date.getMonth()+1).padStart(2,"0"),dd=String(date.getDate()).padStart(2,"0");
  return "SPY"+yy+mm+dd+right+String(Math.round(strike*1000)).padStart(8,"0");
}
function getETDate(){return new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));}
function getExpiry(){const d=getETDate();return d.getFullYear()+String(d.getMonth()+1).padStart(2,"0")+String(d.getDate()).padStart(2,"0");}

async function getMidPrice(symbol){
  try{
    const r=await fetch(ALPACA_DATA+"/v1beta1/options/snapshots?symbols="+symbol,{headers:aH()});
    if(!r.ok) return null;
    const d=await r.json(), s=(d.snapshots||{})[symbol];
    if(!s||!s.latestQuote) return null;
    const bid=parseFloat(s.latestQuote.bp||0),ask=parseFloat(s.latestQuote.ap||0);
    return bid>0&&ask>0 ? parseFloat(((bid+ask)/2).toFixed(2)) : null;
  }catch(_){return null;}
}

// ── Position close ────────────────────────────────────────────────────────────
async function closePosition(symbol){
  return await aDel("/v2/positions/"+encodeURIComponent(symbol));
}

// ── Price monitor ─────────────────────────────────────────────────────────────
function startMonitor(signal, indicators) {
  log("MONITOR","Watching "+signal.optionSymbol+" | stop $"+signal.stopPrice+" | tp1 $"+signal.tp1Price+" | poll: 60s");
  const entryTime=Date.now();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5; // ~5 minutes of failures before giving up and flagging

  const iv=setInterval(async()=>{
    if(!["FILLED"].includes(signal.status)){clearInterval(iv);return;}
    try{
      const pos=await aGet("/v2/positions/"+encodeURIComponent(signal.optionSymbol));
      consecutiveErrors = 0; // reset on any successful poll
      const price=parseFloat(pos.current_price||0);
      if(!price) return;
      const entry=signal.fillPrice||signal.midPrice;
      const pct=((price-entry)/entry*100).toFixed(1);

      // Track max/min price seen while position is open (for dashboard + journal)
      signal.maxPrice = signal.maxPrice!=null ? Math.max(signal.maxPrice, price) : price;
      signal.minPrice = signal.minPrice!=null ? Math.min(signal.minPrice, price) : price;
      signal.maxPnlPct = signal.maxPrice!=null ? parseFloat((((signal.maxPrice-entry)/entry)*100).toFixed(1)) : null;
      signal.minPnlPct = signal.minPrice!=null ? parseFloat((((signal.minPrice-entry)/entry)*100).toFixed(1)) : null;

      log("MONITOR",signal.optionSymbol+" $"+price+" | P&L "+pct+"% | stop $"+signal.stopPrice+" | tp1 $"+signal.tp1Price+" | max $"+signal.maxPrice+" | min $"+signal.minPrice);
      broadcast({type:"signal_update",id:signal.id,currentPrice:price,maxPrice:signal.maxPrice,minPrice:signal.minPrice,maxPnlPct:signal.maxPnlPct,minPnlPct:signal.minPnlPct});

      if(price>=signal.tp1Price){
        clearInterval(iv);
        log("TP1","Hit $"+price+" >= $"+signal.tp1Price);
        await closePosition(signal.optionSymbol);
        const pnl=(price-entry)*100*signal.contracts;
        signal.status="TP1_HIT"; signal.closePnl=pnl; signal.closePrice=price;
        signal.closeReason="TP1_HIT"; signal.durationMin=((Date.now()-entryTime)/60000).toFixed(1);
        signal.outcome="WIN";
        sessionPnL+=pnl;
        broadcast({type:"signal_update",id:signal.id,status:"TP1_HIT",pnl});
        saveTradeToDB(signal,signal._dbId,indicators);
        return;
      }
      if(price<=signal.stopPrice){
        clearInterval(iv);
        log("STOP","Hit $"+price+" <= $"+signal.stopPrice);
        await closePosition(signal.optionSymbol);
        const pnl=(price-entry)*100*signal.contracts;
        signal.status="STOPPED"; signal.closePnl=pnl; signal.closePrice=price;
        signal.closeReason="STOP_HIT"; signal.durationMin=((Date.now()-entryTime)/60000).toFixed(1);
        signal.outcome=pnl>=0?"WIN":"LOSS";
        sessionPnL+=pnl; dailyLoss+=Math.abs(Math.min(0,pnl));
        broadcast({type:"signal_update",id:signal.id,status:"STOPPED",pnl});
        saveTradeToDB(signal,signal._dbId,indicators);
        return;
      }
    }catch(e){
      if(e.message.includes("404")||e.message.includes("40410000")){
        clearInterval(iv);
        log("MONITOR",signal.optionSymbol+" expired/closed");
        signal.status="EOD_CLOSED"; signal.closeReason="EXPIRED";
        signal.durationMin=((Date.now()-entryTime)/60000).toFixed(1);
        signal.outcome="LOSS";
        broadcast({type:"signal_update",id:signal.id,status:"EOD_CLOSED"});
        saveTradeToDB(signal,signal._dbId,indicators);
        return;
      }
      // FIX: previously any non-404 error was silently swallowed here, which could
      // leave a position monitored-in-name-only forever with zero trace in the logs.
      consecutiveErrors++;
      log("MONITOR ERR", signal.optionSymbol+" poll failed ("+consecutiveErrors+"/"+MAX_CONSECUTIVE_ERRORS+"): "+e.message);
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        clearInterval(iv);
        log("MONITOR ERR", signal.optionSymbol+" — "+MAX_CONSECUTIVE_ERRORS+" consecutive poll failures, giving up. POSITION MAY STILL BE OPEN — CHECK ALPACA MANUALLY.");
        signal.status = "MONITOR_FAILED";
        broadcast({type:"signal_update",id:signal.id,status:"MONITOR_FAILED"});
      }
    }
  },60000); // 60s = 1 minute poll, per request (was 30s)
  signal._monitorInterval=iv;
}


// ── Execute trade ─────────────────────────────────────────────────────────────
async function executeTrade(direction, price, indicators, gexResult) {
  if(!ALPACA_KEY||!ALPACA_SECRET){log("ERROR","No Alpaca keys");return;}
  if(tradesDay>=MAX_TRADES_DAY){log("GUARD","Max "+MAX_TRADES_DAY+" trades/day reached");return;}
  if(dailyLoss>=ACCOUNT_SIZE*MAX_DAILY_LOSS){log("GUARD","Daily loss limit reached");return;}

  const right = direction==="LONG"?"C":"P";
  const date  = getETDate();
  const si    = selectStrike(price, direction, gexResult?.target);

  const sig = {
    id:          Date.now(),
    time:        new Date().toLocaleTimeString("en-US",{hour12:false,timeZone:"America/New_York"}),
    symbol:      "SPY", direction, right,
    spyEntry:    price, strike:si.strike,
    strikeReason:si.reason, estimatedDelta:si.delta,
    estimatedGamma:si.gamma||null, impliedVol:si.impliedVol||null,
    strikeMethod:si.method||"heuristic",
    stop:        indicators.orbLow,
    tp1:         gexResult.tp1, tp2:gexResult.tp2,
    gexTarget:   gexResult.target, gexReason:gexResult.reason,
    expiry:      getExpiry(), riskBudget:getRiskBudget(),
    contracts:null, midPrice:null, totalCost:null,
    fillPrice:null, stopPrice:null, tp1Price:null,
    optionSymbol:null, closePnl:null,
    closePrice:null, closeReason:null,
    durationMin:null, outcome:null,
    trigger:"Internal Signal Engine",
    confidence:indicators.strength||"MEDIUM",
    status:"PENDING",
    indicators: {...indicators},
    gexSnapshot: gexCache?{callWalls:(gexCache.callWalls||[]).slice(0,3),putWalls:(gexCache.putWalls||[]).slice(0,3),gammaFlip:gexCache.gammaFlip,regime:gexCache.regime}:null,
  };

  signalHistory.unshift(sig);
  broadcast({type:"new_signal",signal:sig});
  log("SIGNAL",direction+" SPY $"+price+" | strike $"+si.strike+" | "+gexResult.reason);

  // Save to DB
  const dbResult = saveSignalToDB(sig, indicators, true, null);
  sig._dbId = dbResult?.lastInsertRowid||null;

  sig.status="EXECUTING";
  broadcast({type:"signal_update",id:sig.id,status:"EXECUTING"});

  try{
    const symbol = buildSymbol(si.strike, right, date);
    if(!/^SPY\d{6}[CP]\d{8}$/.test(symbol)) throw new Error("SAFETY: Bad OCC symbol: "+symbol);
    sig.optionSymbol = symbol;

    let mid = await getMidPrice(symbol);
    if(!mid||mid<0.05||mid>50){
      const atm = buildSymbol(Math.round(price),right,date);
      mid = await getMidPrice(atm);
      if(!mid) throw new Error("No valid option price — market closed?");
      sig.optionSymbol=atm; sig.strike=Math.round(price); sig.strikeReason="ATM fallback";
    }

    const contracts=calcContracts(mid);
    const totalCost=parseFloat((mid*100*contracts).toFixed(2));
    if(contracts>50)               throw new Error("SAFETY: "+contracts+" contracts > 50");
    if(totalCost>ACCOUNT_SIZE*0.10) throw new Error("SAFETY: $"+totalCost+" > 10% of account");

    log("SAFETY","Guards passed — "+sig.optionSymbol+" x"+contracts+" @ $"+mid+" = $"+totalCost);

    const order=await aPost("/v2/orders",{
      symbol:sig.optionSymbol, qty:String(contracts),
      side:"buy", type:"limit", limit_price:String(mid),
      time_in_force:"day", client_order_id:"spxcmd_"+sig.id,
    });

    sig.contracts=contracts; sig.midPrice=mid; sig.totalCost=totalCost;
    sig.status="SENT";
    broadcast({type:"signal_update",id:sig.id,status:"SENT",optionSymbol:sig.optionSymbol,contracts,midPrice:mid,totalCost});
    log("ALPACA","Order: "+order.id+" | "+sig.optionSymbol+" x"+contracts+" @ $"+mid);

    const filled=await pollFill(order.id,60000);
    if(!filled){log("ORDER","Unfilled after 60s");sig.status="PENDING";return;}

    sig.fillPrice=parseFloat(filled.filled_avg_price||mid);
    const stop=parseFloat((sig.fillPrice*(1-PREMIUM_STOP_PCT)).toFixed(2));
    const tp1=calcTP1(sig.fillPrice,si.delta);
    sig.stopPrice=stop; sig.tp1Price=tp1; sig.status="FILLED";
    tradesDay++;

    broadcast({type:"signal_update",id:sig.id,status:"FILLED",fillPrice:sig.fillPrice,stopPrice:stop,tp1Price:tp1});
    log("FILL","Filled @ $"+sig.fillPrice+" | stop $"+stop+" | tp1 $"+tp1+" | R:R "+((tp1-sig.fillPrice)/(sig.fillPrice-stop)).toFixed(1)+":1");
    log("EXIT","Price monitor active — exits via DELETE /v2/positions (no sell orders)");

    startMonitor(sig, indicators);
  }catch(e){
    sig.status="PENDING";
    broadcast({type:"signal_update",id:sig.id,status:"PENDING"});
    log("ERROR","Execute failed: "+e.message);
  }
}

async function pollFill(orderId,maxMs){
  const start=Date.now();
  while(Date.now()-start<maxMs){
    const o=await aGet("/v2/orders/"+orderId);
    if(o.status==="filled") return o;
    if(["cancelled","expired","rejected"].includes(o.status)) throw new Error("Order "+o.status);
    await new Promise(r=>setTimeout(r,2000));
  }
  return null;
}

// ── Signal Engine ─────────────────────────────────────────────────────────────
let lastSignalBar = null; // prevent duplicate signals on same bar

async function runSignalEngine() {
  if(scanActive) return;
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(),m=now.getMinutes();

  // Only run during market hours, after ORB period
  if(!((h>9||(h===9&&m>=45))&&h<15||(h===15&&m<=44))) return;

  scanActive=true;
  try{
    const bars=await getSPYBars();
    if(!bars.length){scanActive=false;return;}

    // Build ORB if not built yet
    buildORB(bars);
    if(!orbState?.built){log("SCAN","ORB not built yet — waiting");scanActive=false;return;}

    // Get latest bar
    const latestBar=bars[bars.length-1];
    if(lastBarTime===latestBar.t){scanActive=false;return;} // already processed this bar
    lastBarTime=latestBar.t;

    // Get live quote
    const currentPrice=await getSPYQuote()||latestBar.c;
    const ind=calcIndicators(bars,currentPrice);
    if(!ind){scanActive=false;return;}

    // Check if already in a trade
    const activeTrades=signalHistory.filter(s=>["FILLED","SENT","EXECUTING"].includes(s.status));
    if(activeTrades.length>0){
      log("SCAN","Bar "+latestBar.t.slice(11,16)+" | SPY $"+currentPrice.toFixed(2)+" | Position open — skipping");
      scanActive=false;return;
    }

    log("SCAN","Bar "+latestBar.t.slice(11,16)+
      " | SPY $"+currentPrice.toFixed(2)+
      " | VWAP $"+(ind.vwap||0).toFixed(2)+
      " | RSI "+(ind.rsi||0)+
      " | ORB H:$"+ind.orbHigh+" L:$"+ind.orbLow+
      " | Break: "+(ind.orbBreak||"none")+
      " | Mode: "+SIGNAL_MODE);

    // Evaluate signal
    const eval_result=evaluateSignal({...ind,strength:null});

    if(!eval_result.fire){
      log("SCAN","No signal — "+eval_result.reason);
      // Still save to DB for analysis
      saveSignalToDB({direction:ind.orbBreak||"NONE",spyEntry:currentPrice,gexTarget:null,strength:"WEAK"},{...ind},false,eval_result.reason);
      scanActive=false;return;
    }

    // Apply GEX filter
    const gexResult=applyGEX(eval_result.direction,currentPrice);
    if(!gexResult.allowed){
      log("GEX","Signal BLOCKED — "+gexResult.reason);
      saveSignalToDB({direction:eval_result.direction,spyEntry:currentPrice,gexTarget:gexResult.target,strength:eval_result.strength},{...ind},false,"GEX: "+gexResult.reason);
      scanActive=false;return;
    }

    log("SIGNAL","FIRED ✓ | "+eval_result.direction+" | "+eval_result.reason+" | GEX: "+gexResult.reason);
    broadcast({type:"signal_fired",direction:eval_result.direction,price:currentPrice,reason:eval_result.reason});

    await executeTrade(eval_result.direction, currentPrice, {...ind,strength:eval_result.strength}, gexResult);

  }catch(e){ log("SCAN ERR","runSignalEngine: "+e.message); }
  scanActive=false;
}

// ── EOD force close ───────────────────────────────────────────────────────────
async function forceCloseAll(){
  const active=signalHistory.filter(s=>["FILLED","SENT"].includes(s.status));
  if(!active.length){log("EOD","No open positions");return;}
  log("EOD","Force closing "+active.length+" position(s)");
  for(const sig of active){
    if(sig._monitorInterval) clearInterval(sig._monitorInterval);
    try{
      const r=await closePosition(sig.optionSymbol);
      log("EOD","Closed "+sig.optionSymbol+" → "+r.status);
      if(r.ok){
        sig.status="EOD_CLOSED"; sig.closeReason="EOD_FORCE_CLOSE"; sig.outcome="UNKNOWN";
        broadcast({type:"signal_update",id:sig.id,status:"EOD_CLOSED"});
        saveTradeToDB(sig,sig._dbId,sig.indicators||{});
      }
    }catch(e){log("EOD ERR",sig.optionSymbol+": "+e.message);}
  }
}

// ── Account check ─────────────────────────────────────────────────────────────
async function checkAccount(){
  if(!ALPACA_KEY||!ALPACA_SECRET){log("WARN","No Alpaca keys");return;}
  try{
    const a=await aGet("/v2/account");
    log("ALPACA","Connected — "+(IS_PAPER?"PAPER":"LIVE")+
      " | Balance: $"+parseFloat(a.portfolio_value).toLocaleString()+
      " | Options: Level "+(a.options_approved_level||"?"));
    broadcast({type:"alpaca_status",connected:true,paper:IS_PAPER,balance:a.portfolio_value});
  }catch(e){log("ALPACA ERR",e.message);broadcast({type:"alpaca_status",connected:false});}
}

// ── Express ───────────────────────────────────────────────────────────────────
const app=express();
app.use(cors({origin:"*",methods:["GET","POST","DELETE","OPTIONS"],allowedHeaders:["Content-Type"]}));
app.options("*",cors());
app.use(express.json());

app.get("/",(req,res)=>res.json({
  service:"SPX COMMAND",version:"10.1-monitor-broadcast-fix",status:"running",
  mode:IS_PAPER?"PAPER":"LIVE",signalMode:SIGNAL_MODE,
  exitStrategy:"price-monitor + DELETE /v2/positions",
  noTradingViewRequired:true,
}));

app.get("/dashboard",(req,res)=>{
  const f=path.join(__dirname,"dashboard.html");
  if(fs.existsSync(f)) res.sendFile(f);
  else res.status(404).send("Upload dashboard.html");
});

app.get("/events",(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.setHeader("Access-Control-Allow-Origin","*");
  res.flushHeaders();
  sseClients.push(res);
  res.write("data: "+JSON.stringify({
    type:"init",sessionPnL,dailyLoss,signals:signalHistory,
    gex:gexCache,expiry:getExpiry(),riskBudget:getRiskBudget(),
    logs:logHistory,orb:orbState,signalMode:SIGNAL_MODE,
  })+"\n\n");
  const ping=setInterval(()=>{try{res.write(": ping\n\n");}catch(_){clearInterval(ping);}},30000);
  req.on("close",()=>{clearInterval(ping);sseClients=sseClients.filter(c=>c!==res);});
});

app.get("/gex",async(req,res)=>{
  if(req.query.refresh==="true"){const g=await getGEX(true);return res.json(g||{error:"GEX unavailable"});}
  res.json(gexCache||{error:"Not calculated yet",hint:"?refresh=true"});
});

// Manual webhook still supported (for testing)
app.post("/webhook",async(req,res)=>{
  const raw=req.body;
  log("WEBHOOK","Manual signal: "+JSON.stringify(raw));
  const entry=parseFloat(raw.entry||0);
  const dir=(raw.direction||"LONG").toUpperCase();
  if(!entry) return res.status(400).json({error:"entry required"});
  const gexResult=applyGEX(dir,entry);
  if(!gexResult.allowed) return res.json({status:"blocked",reason:gexResult.reason});
  const ind={orbHigh:entry+1,orbLow:entry-1,vwap:entry,rsi:50,ema9:entry,ema21:entry,orbBreak:dir,strength:"MANUAL"};
  await executeTrade(dir,entry,ind,gexResult);
  res.json({status:"received"});
});

app.post("/cancel/:id",async(req,res)=>{
  const id=parseInt(req.params.id);
  const sig=signalHistory.find(s=>s.id===id);
  if(!sig) return res.status(404).json({error:"Not found"});
  if(sig._monitorInterval) clearInterval(sig._monitorInterval);
  if(sig.optionSymbol&&["FILLED","SENT"].includes(sig.status)){
    try{await closePosition(sig.optionSymbol);}catch(_){}
  }
  sig.status="CANCELLED";
  broadcast({type:"signal_update",id,status:"CANCELLED"});
  res.json({status:"cancelled"});
});

app.post("/closeall",async(req,res)=>{await forceCloseAll();res.json({status:"done"});});

app.post("/closeposition/:symbol",async(req,res)=>{
  const r=await closePosition(req.params.symbol);
  log("MANUAL","Closed "+req.params.symbol+" → "+r.status);
  res.json({status:r.ok?"closed":"failed",result:r.data});
});

// DB query endpoints for data mining
app.get("/db/trades",(req,res)=>{
  const limit=parseInt(req.query.limit||"100");
  const rows=dbAll("SELECT * FROM trades ORDER BY id DESC LIMIT ?",[ limit]);
  res.json({count:rows.length,trades:rows});
});

app.get("/db/signals",(req,res)=>{
  const limit=parseInt(req.query.limit||"100");
  const rows=dbAll("SELECT * FROM signals ORDER BY id DESC LIMIT ?",[limit]);
  res.json({count:rows.length,signals:rows});
});

app.get("/db/gex",(req,res)=>{
  const rows=dbAll("SELECT * FROM gex_snapshots ORDER BY id DESC LIMIT 50",[]);
  res.json({count:rows.length,snapshots:rows});
});

app.get("/db/stats",(req,res)=>{
  const stats=dbAll(`
    SELECT
      COUNT(*) as total_trades,
      SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) as losses,
      ROUND(AVG(CASE WHEN outcome='WIN' THEN pnl END),2) as avg_win,
      ROUND(AVG(CASE WHEN outcome='LOSS' THEN pnl END),2) as avg_loss,
      ROUND(SUM(pnl),2) as total_pnl,
      ROUND(AVG(pnl_pct),2) as avg_pnl_pct,
      ROUND(AVG(duration_min),1) as avg_duration_min,
      MAX(pnl) as best_trade,
      MIN(pnl) as worst_trade
    FROM trades WHERE close_reason IS NOT NULL
  `,[]);
  const byMode=dbAll("SELECT signal_mode,outcome,COUNT(*) as count FROM trades GROUP BY signal_mode,outcome",[]);
  const byReason=dbAll("SELECT close_reason,COUNT(*) as count,ROUND(SUM(pnl),2) as total_pnl FROM trades GROUP BY close_reason",[]);
  res.json({stats:stats[0]||{},byMode,byReason});
});

app.get("/db/export",(req,res)=>{
  const trades=dbAll("SELECT * FROM trades ORDER BY id DESC",[]);
  if(!trades.length) return res.json({error:"No trades"});
  const h=Object.keys(trades[0]).join(",");
  const r=trades.map(t=>Object.values(t).map(v=>typeof v==="string"&&v.includes(",")?"\""+v+"\"":v||"").join(",")).join("\n");
  res.setHeader("Content-Type","text/csv");
  res.setHeader("Content-Disposition","attachment;filename=spx_trades.csv");
  res.send(h+"\n"+r);
});

app.get("/status",(req,res)=>{
  const allTrades=loadDB("trades").filter(t=>t.close_reason);
  const wins=allTrades.filter(t=>t.outcome==="WIN");
  const s={t:allTrades.length,w:wins.length,p:parseFloat(allTrades.reduce((a,t)=>a+(t.pnl||0),0).toFixed(2))};
  res.json({
    version:"10.1-monitor-broadcast-fix", mode:IS_PAPER?"PAPER":"LIVE",
    signalMode:SIGNAL_MODE, noTradingView:true,
    exitStrategy:"price-monitor + DELETE /v2/positions",
    riskBudget:"$"+getRiskBudget(),
    optionsFeed:OPTIONS_FEED,
    realGreeks:gexCache?.hasRealGreeks||false,
    tp1Config:{mode:TP1_FIXED_MOVE>0?"fixed":"multiplier",value:TP1_FIXED_MOVE>0?"$"+TP1_FIXED_MOVE:TP1_MULTIPLIER+"x"},
    sessionPnL:sessionPnL.toFixed(2), dailyLoss:dailyLoss.toFixed(2),
    dailyLossLimit:(ACCOUNT_SIZE*MAX_DAILY_LOSS).toFixed(2),
    tradesDay:tradesDay+"/"+MAX_TRADES_DAY,
    orb:orbState,
    gex:gexCache?{regime:gexCache.regime,gammaFlip:gexCache.gammaFlip,callWalls:(gexCache.callWalls||[]).slice(0,3).map(w=>"$"+w.price),putWalls:(gexCache.putWalls||[]).slice(0,3).map(w=>"$"+w.price)}:null,
    signals:{today:signalHistory.length,active:signalHistory.filter(s=>["FILLED","SENT"].includes(s.status)).length},
    db:{totalTrades:s.t||0,wins:s.w||0,totalPnL:s.p||0,winRate:s.t>0?((s.w/s.t)*100).toFixed(1)+"%":"—"},
  });
});

// ── Schedulers ────────────────────────────────────────────────────────────────

// Signal engine: runs on 5-min bar close (every minute, fires when new bar available)
setInterval(async()=>{
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(),m=now.getMinutes();
  // 5-min bars close at :00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55
  if(m%5===0){
    await runSignalEngine();
  }
  // Reset daily counters at market open
  if(h===9&&m===30) {
    tradesDay=0; sessionPnL=0; dailyLoss=0;
    orbState=null; lastBarTime=null;
    log("DAY","New trading day — counters reset");
  }
},60000);

// GEX scheduler
setInterval(async()=>{
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(),m=now.getMinutes();
  const today=now.toLocaleDateString("en-CA");
  if(!((h>9||(h===9&&m>=25))&&h<16)) return;
  const key=today+"_"+h+"_"+m;
  if(GEX_SCHEDULE.some(s=>s.h===h&&s.m===m)&&!gexFired.has(key)){
    gexFired.add(key);
    log("GEX","Scheduled refresh "+String(h).padStart(2,"0")+":"+String(m).padStart(2,"0"));
    await getGEX(true);
  }
},60000);

// EOD 3:45 PM
setInterval(async()=>{
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(),m=now.getMinutes();
  if(h===15&&m===45){
    const key=now.toLocaleDateString("en-CA")+"_eod";
    if(!gexFired.has(key)){gexFired.add(key);await forceCloseAll();}
  }
},60000);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT,async()=>{
  console.log(`
 ╔══════════════════════════════════════════════════════╗
 ║   SPX COMMAND v9 · Autonomous · No TradingView      ║
 ╠══════════════════════════════════════════════════════╣
 ║  Signal engine : 5-min bar close scan               ║
 ║  Indicators    : ORB(15m) + VWAP + RSI + EMA        ║
 ║  Signal mode   : ${SIGNAL_MODE.padEnd(35)}║
 ║  Exit          : Price monitor + DELETE position     ║
 ║  Database      : SQLite ${DB_FILE.slice(-30).padEnd(27)}║
 ╠══════════════════════════════════════════════════════╣
 ║  GET  /              Health check                   ║
 ║  GET  /dashboard     Trading dashboard              ║
 ║  GET  /status        Full system status             ║
 ║  GET  /gex           GEX levels                     ║
 ║  GET  /db/trades     All trades (data mining)       ║
 ║  GET  /db/signals    All signals evaluated          ║
 ║  GET  /db/stats      Performance statistics         ║
 ║  GET  /db/export     Export trades CSV              ║
 ║  POST /webhook       Manual signal (testing)        ║
 ║  POST /closeall      Force close all positions      ║
 ╚══════════════════════════════════════════════════════╝
`);
  initDB();
  await checkAccount();
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(),m=now.getMinutes();
  if((h>9||(h===9&&m>=30))&&h<16){
    log("GEX","Market open — calculating initial GEX...");
    await getGEX(true);
  } else {
    log("GEX","Market closed — signal engine starts at 9:45 AM ET");
  }
});
