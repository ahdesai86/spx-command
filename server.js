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
 *   JSON files on /data (Railway Volume)
 *   Files: signals.json, trades.json, gex_snapshots.json
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
const PORT             = parseInt(process.env.PORT               || "3001");
const IS_PAPER         = ALPACA_BASE.includes("paper");
const ORB_MINUTES      = 15; // 9:30–9:45 ET
const TP1_FIXED_MOVE   = parseFloat(process.env.TP1_FIXED_MOVE   || "0");
const FLASHALPHA_KEY   = process.env.FLASHALPHA_API_KEY || "";
const FLASHALPHA_BASE  = "https://lab.flashalpha.com";

// ── Runtime-tunable settings ───────────────────────────────────────────────────
// These start from env vars but can be changed live via GET/POST /settings (and
// the dashboard Settings tab) without a redeploy. Held in `let`, not `const`, so
// every function that reads them picks up the live value.
let RISK_DOLLARS      = parseFloat(process.env.RISK_DOLLARS     || "2000");
let RISK_PER_TRADE    = parseFloat(process.env.RISK_PER_TRADE   || "0.02");
let MAX_DAILY_LOSS    = parseFloat(process.env.MAX_DAILY_LOSS   || "0.06");
let PREMIUM_STOP_PCT  = parseFloat(process.env.PREMIUM_STOP_PCT || "0.25");
let TP1_MULTIPLIER    = parseFloat(process.env.TP1_MULTIPLIER   || "3.0");
let TP1_MIN_MULT      = parseFloat(process.env.TP1_MIN_MULTIPLIER || "1.4");  // floor on GEX-derived TP1
let TP1_MAX_MULT      = parseFloat(process.env.TP1_MAX_MULTIPLIER || "4.0");  // ceiling on GEX-derived TP1
let TRAIL_TRIGGER_PCT = parseFloat(process.env.TRAIL_TRIGGER_PCT  || "0.50"); // gain % that activates trailing stop
let TRAIL_DISTANCE_PCT= parseFloat(process.env.TRAIL_DISTANCE_PCT || "0.20"); // trail this far below peak
let GEX_BUFFER         = parseFloat(process.env.GEX_BUFFER       || "1.0");
let SIGNAL_MODE        = (process.env.SIGNAL_MODE || "MODERATE").toUpperCase().split(" ")[0]; // MODERATE or STRICT
let MAX_TRADES_DAY     = parseInt(process.env.MAX_TRADES_DAY || "3");

// Definitions used to validate/clamp incoming POST /settings updates
const SETTINGS_SCHEMA = {
  RISK_DOLLARS:      { type:"number", min:0,    max:50000,  set:v=>RISK_DOLLARS=v },
  RISK_PER_TRADE:    { type:"number", min:0,    max:1,      set:v=>RISK_PER_TRADE=v },
  MAX_DAILY_LOSS:    { type:"number", min:0.01, max:1,      set:v=>MAX_DAILY_LOSS=v },
  PREMIUM_STOP_PCT:  { type:"number", min:0.05, max:0.95,   set:v=>PREMIUM_STOP_PCT=v },
  TP1_MULTIPLIER:    { type:"number", min:1.1,  max:10,     set:v=>TP1_MULTIPLIER=v },
  TP1_MIN_MULT:      { type:"number", min:1.05, max:10,     set:v=>TP1_MIN_MULT=v },
  TP1_MAX_MULT:      { type:"number", min:1.1,  max:20,     set:v=>TP1_MAX_MULT=v },
  TRAIL_TRIGGER_PCT: { type:"number", min:0.05, max:5,      set:v=>TRAIL_TRIGGER_PCT=v },
  TRAIL_DISTANCE_PCT:{ type:"number", min:0.01, max:0.95,   set:v=>TRAIL_DISTANCE_PCT=v },
  GEX_BUFFER:        { type:"number", min:0,    max:20,     set:v=>GEX_BUFFER=v },
  SIGNAL_MODE:       { type:"enum",   values:["MODERATE","STRICT"], set:v=>SIGNAL_MODE=v },
  MAX_TRADES_DAY:    { type:"number", min:1,    max:50, integer:true, set:v=>MAX_TRADES_DAY=v },
};

function getSettingsSnapshot(){
  return {
    RISK_DOLLARS, RISK_PER_TRADE, MAX_DAILY_LOSS, PREMIUM_STOP_PCT,
    TP1_MULTIPLIER, TP1_MIN_MULT, TP1_MAX_MULT,
    TRAIL_TRIGGER_PCT, TRAIL_DISTANCE_PCT,
    GEX_BUFFER, SIGNAL_MODE, MAX_TRADES_DAY,
  };
}

function getRiskBudget() { return RISK_DOLLARS > 0 ? RISK_DOLLARS : ACCOUNT_SIZE * RISK_PER_TRADE; }
function calcContracts(p) { return !p||p<=0 ? 1 : Math.max(1, Math.floor(getRiskBudget()/(p*100))); }
/**
 * TP1 target selection, in priority order:
 *   1. Fixed-$-move mode (TP1_FIXED_MOVE env override), if set.
 *   2. GEX-derived: translate the SPY-level wall/magnet target into an estimated
 *      option premium using the delta-gamma approximation (same method used by
 *      selectStrike's payoff scoring), bounded between TP1_MIN_MULT and
 *      TP1_MAX_MULT of entry premium so a too-close or too-far wall doesn't
 *      produce a degenerate target.
 *   3. Flat TP1_MULTIPLIER fallback when no GEX target is available.
 * Replaces the old flat-3x-only target, which two confirmed trades (June 26
 * +86.2% peak, June 29 +103.5% peak) showed is rarely reachable intraday on 0DTE.
 */
function calcTP1(entry, delta, spyEntry, gexTarget, gamma) {
  if (TP1_FIXED_MOVE > 0) return parseFloat((entry + TP1_FIXED_MOVE*(delta||0.35)).toFixed(2));

  if (gexTarget!=null && spyEntry!=null && delta) {
    const move = Math.abs(gexTarget - spyEntry);
    const estGain = delta*move + 0.5*(gamma||0)*move*move;
    const lo = entry*TP1_MIN_MULT, hi = entry*TP1_MAX_MULT;
    const target = Math.min(Math.max(entry+estGain, lo), hi);
    return parseFloat(target.toFixed(2));
  }
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
const GEX_SCHEDULE  = [{h:9,m:25},{h:10,m:0},{h:10,m:30},{h:11,m:0},{h:11,m:30},{h:12,m:0},{h:13,m:0},{h:14,m:0},{h:15,m:0}];
let faLevelsCache   = null;
let faZeroDteCache  = null;
let faSummaryCache  = null;
let faMaxPainCache  = null;
let faCacheTime     = 0;

// ── JSON File Database ────────────────────────────────────────────────────────
// Railway auto-injects RAILWAY_VOLUME_MOUNT_PATH at runtime once a volume is
// attached to the service (regardless of the mount path chosen in the dashboard).
// Falls back to /data (legacy assumption), then to __dirname (ephemeral — wiped
// on every redeploy) if no volume is attached at all.
const RAILWAY_VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const DB_DIR  = RAILWAY_VOLUME || (fs.existsSync("/data") ? "/data" : __dirname);

// ── JSON-based database (no native deps, persists to Railway Volume) ─────────
// Stores trades, signals, gex_snapshots as JSON files

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
  if (RAILWAY_VOLUME) {
    log("DB", "JSON database initialized at "+DB_DIR+" (Railway Volume — persists across deploys)");
  } else {
    log("DB ERR", "No Railway Volume attached — DB at "+DB_DIR+" is EPHEMERAL and will be WIPED on next deploy/restart. Attach a volume in Railway dashboard (Settings -> Volumes) to persist trade history.");
  }
}


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
      source:      g.source||"Alpaca",
      call_wall:   g.callWall||null,
      put_wall:    g.putWall||null,
      max_pain:    g.maxPain||null,
      zero_dte_magnet: g.zeroDteMagnet||null,
      pin_risk:    g.pinRisk||null,
      dex:         g.dex||null,
      vex:         g.vex||null,
      chex:        g.chex||null,
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

// ── FlashAlpha API helper ─────────────────────────────────────────────────────
const OPTIONS_FEED = process.env.OPTIONS_FEED || "opra";
let fullChainCache = null;

async function faGet(endpoint) {
  if (!FLASHALPHA_KEY) return null;
  const url = FLASHALPHA_BASE + endpoint;
  const r = await fetch(url, { headers: { "X-Api-Key": FLASHALPHA_KEY, "Accept": "application/json" } });
  if (!r.ok) {
    const txt = await r.text();
    log("FA ERR", "GET " + endpoint + " " + r.status + ": " + txt.slice(0, 200));
    return null;
  }
  return r.json();
}

// ── FlashAlpha-powered GEX + exposure analytics ──────────────────────────────
async function calcGEX() {
  if (!FLASHALPHA_KEY) {
    log("GEX", "No FLASHALPHA_API_KEY — GEX disabled");
    return null;
  }
  try {
    log("GEX", "Fetching from FlashAlpha API...");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

    const [gexData, levelsData, zeroDteData, summaryData, maxPainData] = await Promise.all([
      faGet("/v1/exposure/gex/SPY?expiration=" + today),
      faGet("/v1/exposure/levels/SPY"),
      faGet("/v1/exposure/zero-dte/SPY"),
      faGet("/v1/exposure/summary/SPY"),
      faGet("/v1/maxpain/SPY?expiration=" + today),
    ]);

    if (!gexData) { log("GEX ERR", "FlashAlpha GEX endpoint returned no data"); return null; }

    const spot = gexData.underlying_price || (await getSPYQuote()) || 0;
    if (!spot) { log("GEX ERR", "No SPY spot"); return null; }

    // Cache FlashAlpha auxiliary data for signal filtering
    faLevelsCache = levelsData;
    faZeroDteCache = zeroDteData;
    faSummaryCache = summaryData;
    faMaxPainCache = maxPainData;
    faCacheTime = Date.now();

    // Build call/put walls from FlashAlpha strike-level GEX data
    const strikes = gexData.strikes || [];
    const callWalls = strikes
      .filter(s => s.strike > spot && s.call_gex > 0)
      .sort((a, b) => b.call_gex - a.call_gex)
      .slice(0, 5)
      .map(s => ({ price: s.strike, gex: Math.round(s.call_gex), oi: s.call_oi || 0 }));
    const putWalls = strikes
      .filter(s => s.strike < spot && s.put_gex < 0)
      .sort((a, b) => a.put_gex - b.put_gex)
      .slice(0, 5)
      .map(s => ({ price: s.strike, gex: Math.round(Math.abs(s.put_gex)), oi: s.put_oi || 0 }));

    const gammaFlip = gexData.gamma_flip || (levelsData?.levels?.gamma_flip) || spot;
    const regime = (gexData.net_gex_label || (gexData.net_gex >= 0 ? "positive" : "negative"));

    // Extract key levels
    const levels = levelsData?.levels || {};
    const zeroDte = zeroDteData || {};
    const maxPain = maxPainData?.max_pain || null;

    const result = {
      callWalls, putWalls,
      gammaFlip: parseFloat(gammaFlip.toFixed ? gammaFlip.toFixed(2) : gammaFlip),
      netGex: Math.round(gexData.net_gex || 0),
      regime,
      spotPrice: spot,
      updatedAt: gexData.as_of || new Date().toISOString(),
      hasRealGreeks: true,
      source: "FlashAlpha",
      callWall: levels.call_wall || (callWalls[0]?.price) || null,
      putWall: levels.put_wall || (putWalls[0]?.price) || null,
      zeroDteMagnet: levels.zero_dte_magnet || null,
      maxPain,
      pinRisk: zeroDte.pin_risk_score || null,
      expectedMove: zeroDte.expected_move || null,
      dex: summaryData?.exposures?.net_dex || null,
      vex: summaryData?.exposures?.net_vex || null,
      chex: summaryData?.exposures?.net_chex || null,
      dealerBias: summaryData?.hedging_estimate || null,
      zeroDtePctOfTotal: zeroDte.zero_dte?.pct_of_total_gex || summaryData?.zero_dte?.pct_of_total_gex || null,
    };

    log("GEX", "FlashAlpha -- Regime:" + result.regime +
      " | Flip:$" + result.gammaFlip +
      " | Net:" + (result.netGex / 1e9).toFixed(2) + "B" +
      " | CallWall:$" + (result.callWall || "—") +
      " | PutWall:$" + (result.putWall || "—") +
      " | MaxPain:$" + (result.maxPain || "—") +
      " | PinRisk:" + (result.pinRisk || "—") +
      " | 0DTE magnet:$" + (result.zeroDteMagnet || "—"));

    if (result.vex != null || result.dex != null) {
      log("GEX", "DEX:" + ((result.dex || 0) / 1e6).toFixed(1) + "M" +
        " | VEX:" + ((result.vex || 0) / 1e6).toFixed(1) + "M" +
        " | CHEX:" + ((result.chex || 0) / 1e6).toFixed(1) + "M");
    }

    broadcast({ type: "gex_update", ...result });
    saveGEXSnapshot(result);
    return result;
  } catch (e) { log("GEX ERR", "calcGEX: " + e.message); return null; }
}

async function getGEX(force) {
  const now = Date.now();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  if (today !== gexLastDate) { gexFired = new Set(); gexLastDate = today; gexCache = null; gexCacheTime = 0; }
  if (!force && gexCache && (now - gexCacheTime) < 300000) return gexCache; // 5 min cache (FlashAlpha data is fresher)
  const r = await calcGEX();
  if (r) { gexCache = r; gexCacheTime = now; }
  return gexCache;
}

function applyGEX(direction, entry) {
  if (!gexCache) return { allowed: true, reason: "No GEX", tp1: entry * (direction === "LONG" ? 1.005 : 0.995), tp2: entry * (direction === "LONG" ? 1.01 : 0.99), target: null };

  const gc = gexCache;

  // Block trades with high pin risk (price likely stuck near current level)
  if (gc.pinRisk != null && gc.pinRisk > 70) {
    return { allowed: false, reason: "Pin risk " + gc.pinRisk + "/100 — price likely pinned, skip 0DTE", tp1: entry, tp2: entry, target: null };
  }

  // Use DEX to validate direction — if strong opposing flow, block
  if (gc.dex != null) {
    const dexBullish = gc.dex > 0;
    if (direction === "LONG" && !dexBullish && Math.abs(gc.dex) > 1e8) {
      return { allowed: false, reason: "DEX bearish (" + (gc.dex / 1e6).toFixed(0) + "M) — conflicts with LONG", tp1: entry, tp2: entry, target: null };
    }
    if (direction === "SHORT" && dexBullish && Math.abs(gc.dex) > 1e8) {
      return { allowed: false, reason: "DEX bullish (+" + (gc.dex / 1e6).toFixed(0) + "M) — conflicts with SHORT", tp1: entry, tp2: entry, target: null };
    }
  }

  // Use max pain + 0DTE magnet as TP targets when available
  const magnet = gc.zeroDteMagnet || gc.maxPain || null;

  if (direction === "LONG") {
    const walls = (gc.callWalls || []).filter(w => w.price > entry + GEX_BUFFER).sort((a, b) => a.price - b.price);
    const callWall = gc.callWall && gc.callWall > entry + GEX_BUFFER ? gc.callWall : (walls[0]?.price || null);
    if (!callWall) return { allowed: true, reason: "No call wall above", tp1: magnet && magnet > entry ? magnet : entry + 2, tp2: entry + 4, target: magnet };
    if (callWall - entry < GEX_BUFFER) return { allowed: false, reason: "LONG blocked — at call wall $" + callWall, tp1: callWall, tp2: callWall, target: callWall };
    const tp1 = magnet && magnet > entry && magnet < callWall ? magnet : callWall;
    const tp2 = callWall > tp1 ? callWall : (walls[1]?.price || callWall);
    return { allowed: true, reason: "LONG → wall $" + callWall + (magnet ? " | magnet $" + magnet : ""), tp1, tp2, target: callWall };
  }

  if (direction === "SHORT") {
    const walls = (gc.putWalls || []).filter(w => w.price < entry - GEX_BUFFER).sort((a, b) => b.price - a.price);
    const putWall = gc.putWall && gc.putWall < entry - GEX_BUFFER ? gc.putWall : (walls[0]?.price || null);
    if (!putWall) return { allowed: true, reason: "No put wall below", tp1: magnet && magnet < entry ? magnet : entry - 2, tp2: entry - 4, target: magnet };
    if (entry - putWall < GEX_BUFFER) return { allowed: false, reason: "SHORT blocked — at put wall $" + putWall, tp1: putWall, tp2: putWall, target: putWall };
    const tp1 = magnet && magnet < entry && magnet > putWall ? magnet : putWall;
    const tp2 = putWall < tp1 ? putWall : (walls[1]?.price || putWall);
    return { allowed: true, reason: "SHORT → wall $" + putWall + (magnet ? " | magnet $" + magnet : ""), tp1, tp2, target: putWall };
  }

  return { allowed: true, reason: "No GEX filter", tp1: entry, tp2: entry, target: null };
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
  log("MONITOR","Watching "+signal.optionSymbol+" | stop $"+signal.stopPrice+" | tp1 $"+signal.tp1Price+" | poll: 30s");
  const entryTime=Date.now();
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5; // ~2.5 minutes of failures at 30s poll before giving up

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

      // Trailing stop: once a position is up TRAIL_TRIGGER_PCT, ratchet the stop up to
      // trail TRAIL_DISTANCE_PCT below the peak (never below breakeven once active, and
      // only ever moves up). Catches large moves that fall short of the TP1 target instead
      // of riding them back down to a fixed-% loss — confirmed twice now (June 26 +86.2%
      // peak, June 29 +103.5% peak) that 0DTE often reverses well before TP1.
      const gainPct=(signal.maxPrice-entry)/entry;
      if(gainPct>=TRAIL_TRIGGER_PCT){
        const trailStop=signal.maxPrice*(1-TRAIL_DISTANCE_PCT);
        const newStop=Math.max(trailStop,entry,signal.stopPrice);
        if(newStop>signal.stopPrice){
          signal.stopPrice=parseFloat(newStop.toFixed(2));
          signal.trailingActive=true;
          log("TRAIL",signal.optionSymbol+" stop raised to $"+signal.stopPrice+" (peak $"+signal.maxPrice+", "+signal.maxPnlPct+"%)");
          broadcast({type:"signal_update",id:signal.id,stopPrice:signal.stopPrice,trailingActive:true});
        }
      }

      log("MONITOR",signal.optionSymbol+" $"+price+" | P&L "+pct+"% | stop $"+signal.stopPrice+(signal.trailingActive?" (trailing)":"")+" | tp1 $"+signal.tp1Price+" | max $"+signal.maxPrice+" | min $"+signal.minPrice);
      broadcast({type:"signal_update",id:signal.id,currentPrice:price,maxPrice:signal.maxPrice,minPrice:signal.minPrice,maxPnlPct:signal.maxPnlPct,minPnlPct:signal.minPnlPct});

      if(price>=signal.tp1Price){
        clearInterval(iv);
        log("TP1","Hit $"+price+" >= $"+signal.tp1Price+" | peak $"+signal.maxPrice+" ("+signal.maxPnlPct+"%)");
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
        const reason=signal.trailingActive?"TRAIL_STOP_HIT":"STOP_HIT";
        log(signal.trailingActive?"TRAIL":"STOP",
          (signal.trailingActive?"Trailing stop":"Stop")+" hit $"+price+" <= $"+signal.stopPrice+
          " | peak $"+signal.maxPrice+" ("+signal.maxPnlPct+"%) | trough $"+signal.minPrice+" ("+signal.minPnlPct+"%)");
        await closePosition(signal.optionSymbol);
        const pnl=(price-entry)*100*signal.contracts;
        signal.status="STOPPED"; signal.closePnl=pnl; signal.closePrice=price;
        signal.closeReason=reason; signal.durationMin=((Date.now()-entryTime)/60000).toFixed(1);
        signal.outcome=pnl>=0?"WIN":"LOSS";
        // Cooldown only applies to genuine losses on the initial fixed stop — a trailing
        // stop exit in profit isn't evidence the thesis failed, so don't block re-entry.
        if(!signal.trailingActive) lastStopTime=Date.now();
        sessionPnL+=pnl; dailyLoss+=Math.abs(Math.min(0,pnl));
        broadcast({type:"signal_update",id:signal.id,status:"STOPPED",closeReason:reason,pnl});
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
  },30000); // 30s poll
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
  sig._dbId = dbResult?.id||null;

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
    const tp1=calcTP1(sig.fillPrice,si.delta,price,gexResult?.target,si.gamma);
    sig.stopPrice=stop; sig.tp1Price=tp1; sig.status="FILLED";
    sig.entryTime=Date.now();
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
let lastSignalBar = null;
let lastStopTime  = 0;
const COOLDOWN_MS = 600000; // 10 min cooldown after stop before re-entering

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
    if(lastBarTime===latestBar.t){scanActive=false;return;}
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

    // Cooldown after stop-loss
    if(lastStopTime && (Date.now()-lastStopTime)<COOLDOWN_MS){
      const remain=Math.ceil((COOLDOWN_MS-(Date.now()-lastStopTime))/60000);
      log("SCAN","Cooldown active — "+remain+" min remaining after last stop");
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
      // Capture last known position price before closing, as a PnL fallback
      // in case the closing order's fill price can't be read in time.
      let lastKnownPrice=null;
      try{
        const pos=await aGet("/v2/positions/"+encodeURIComponent(sig.optionSymbol));
        lastKnownPrice=parseFloat(pos.current_price||0)||null;
      }catch(_){}

      const r=await closePosition(sig.optionSymbol);
      log("EOD","Closed "+sig.optionSymbol+" → "+r.status);
      if(r.ok){
        const entry=sig.fillPrice||sig.midPrice;
        let closePrice=null;

        // Closing order rarely fills synchronously on DELETE — try the response first,
        // then poll briefly for the fill, then fall back to last known position price.
        if(r.data&&r.data.filled_avg_price) closePrice=parseFloat(r.data.filled_avg_price);
        if(!closePrice&&r.data&&r.data.id){
          const filled=await pollFill(r.data.id,15000).catch(()=>null);
          if(filled&&filled.filled_avg_price) closePrice=parseFloat(filled.filled_avg_price);
        }
        if(!closePrice) closePrice=lastKnownPrice;

        const pnl=(closePrice!=null&&entry)?(closePrice-entry)*100*sig.contracts:null;

        sig.status="EOD_CLOSED"; sig.closeReason="EOD_FORCE_CLOSE";
        sig.closePrice=closePrice; sig.closePnl=pnl;
        sig.durationMin=sig.entryTime?((Date.now()-sig.entryTime)/60000).toFixed(1):null;
        sig.outcome=pnl==null?"UNKNOWN":(pnl>=0?"WIN":"LOSS");
        if(pnl!=null){ sessionPnL+=pnl; if(pnl<0) dailyLoss+=Math.abs(pnl); }

        log("EOD",sig.optionSymbol+" closed @ "+(closePrice!=null?"$"+closePrice:"unknown price")+
          (pnl!=null?" | PnL $"+pnl.toFixed(2):" | PnL unknown — could not determine close price")+
          " | peak $"+sig.maxPrice+" ("+sig.maxPnlPct+"%)");
        broadcast({type:"signal_update",id:sig.id,status:"EOD_CLOSED",pnl});
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
  service:"SPX COMMAND",version:"11.4-settings-tab",status:"running",
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
  try {
    const initPayload = sanitizeForBroadcast({
      type:"init",sessionPnL,dailyLoss,signals:signalHistory,
      gex:gexCache,expiry:getExpiry(),riskBudget:getRiskBudget(),
      logs:logHistory,orb:orbState,signalMode:SIGNAL_MODE,
    });
    res.write("data: "+JSON.stringify(initPayload)+"\n\n");
  } catch(e) {
    console.error("[SSE INIT ERR] "+e.message);
  }
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
  const rows=loadDB("trades").reverse().slice(0,limit);
  res.json({count:rows.length,trades:rows});
});

app.get("/db/signals",(req,res)=>{
  const limit=parseInt(req.query.limit||"100");
  const rows=loadDB("signals").reverse().slice(0,limit);
  res.json({count:rows.length,signals:rows});
});

app.get("/db/gex",(req,res)=>{
  const rows=loadDB("gex_snapshots").reverse().slice(0,50);
  res.json({count:rows.length,snapshots:rows});
});

app.get("/db/stats",(req,res)=>{
  const allTrades=loadDB("trades").filter(t=>t.close_reason);
  const wins=allTrades.filter(t=>t.outcome==="WIN");
  const losses=allTrades.filter(t=>t.outcome==="LOSS");
  const winPnls=wins.map(t=>t.pnl||0);
  const lossPnls=losses.map(t=>t.pnl||0);
  const totalPnl=allTrades.reduce((a,t)=>a+(t.pnl||0),0);
  const stats={
    total_trades:allTrades.length,
    wins:wins.length,
    losses:losses.length,
    win_rate:allTrades.length>0?parseFloat(((wins.length/allTrades.length)*100).toFixed(1)):0,
    avg_win:winPnls.length?parseFloat((winPnls.reduce((a,b)=>a+b,0)/winPnls.length).toFixed(2)):0,
    avg_loss:lossPnls.length?parseFloat((lossPnls.reduce((a,b)=>a+b,0)/lossPnls.length).toFixed(2)):0,
    total_pnl:parseFloat(totalPnl.toFixed(2)),
    avg_pnl_pct:allTrades.length?parseFloat((allTrades.reduce((a,t)=>a+(t.pnl_pct||0),0)/allTrades.length).toFixed(2)):0,
    avg_duration_min:allTrades.length?parseFloat((allTrades.reduce((a,t)=>a+parseFloat(t.duration_min||0),0)/allTrades.length).toFixed(1)):0,
    best_trade:allTrades.length?Math.max(...allTrades.map(t=>t.pnl||0)):0,
    worst_trade:allTrades.length?Math.min(...allTrades.map(t=>t.pnl||0)):0,
  };
  const byMode={};
  allTrades.forEach(t=>{const k=(t.signal_mode||"UNKNOWN")+"_"+(t.outcome||"UNKNOWN");byMode[k]=(byMode[k]||0)+1;});
  const byModeArr=Object.entries(byMode).map(([k,count])=>{const [signal_mode,outcome]=k.split("_");return{signal_mode,outcome,count};});
  const byReason={};
  allTrades.forEach(t=>{const k=t.close_reason||"UNKNOWN";if(!byReason[k])byReason[k]={count:0,total_pnl:0};byReason[k].count++;byReason[k].total_pnl+=(t.pnl||0);});
  const byReasonArr=Object.entries(byReason).map(([close_reason,v])=>({close_reason,count:v.count,total_pnl:parseFloat(v.total_pnl.toFixed(2))}));
  res.json({stats,byMode:byModeArr,byReason:byReasonArr});
});

app.get("/db/export",(req,res)=>{
  const trades=loadDB("trades").reverse();
  if(!trades.length) return res.json({error:"No trades"});
  const h=Object.keys(trades[0]).join(",");
  const r=trades.map(t=>Object.values(t).map(v=>typeof v==="string"&&v.includes(",")?"\""+v+"\"":v||"").join(",")).join("\n");
  res.setHeader("Content-Type","text/csv");
  res.setHeader("Content-Disposition","attachment;filename=spx_trades.csv");
  res.send(h+"\n"+r);
});

// ── Runtime settings ──────────────────────────────────────────────────────────
app.get("/settings",(req,res)=>{
  res.json({settings:getSettingsSnapshot(),schema:Object.fromEntries(
    Object.entries(SETTINGS_SCHEMA).map(([k,v])=>[k,{type:v.type,min:v.min,max:v.max,values:v.values,integer:v.integer}])
  )});
});

app.post("/settings",(req,res)=>{
  const body=req.body||{};
  const applied={}, errors={};
  for(const [key,val] of Object.entries(body)){
    const def=SETTINGS_SCHEMA[key];
    if(!def){ errors[key]="Unknown setting"; continue; }
    if(def.type==="enum"){
      const v=String(val).toUpperCase();
      if(!def.values.includes(v)){ errors[key]="Must be one of: "+def.values.join(", "); continue; }
      def.set(v); applied[key]=v;
    } else {
      let n=parseFloat(val);
      if(isNaN(n)){ errors[key]="Must be a number"; continue; }
      if(def.integer) n=Math.round(n);
      if(n<def.min||n>def.max){ errors[key]="Must be between "+def.min+" and "+def.max; continue; }
      def.set(n); applied[key]=n;
    }
  }
  if(Object.keys(applied).length){
    log("SETTINGS","Updated: "+Object.entries(applied).map(([k,v])=>k+"="+v).join(", "));
    broadcast({type:"settings_update",settings:getSettingsSnapshot()});
  }
  res.json({applied,errors,settings:getSettingsSnapshot()});
});

app.get("/status",(req,res)=>{
  const allTrades=loadDB("trades").filter(t=>t.close_reason);
  const wins=allTrades.filter(t=>t.outcome==="WIN");
  const s={t:allTrades.length,w:wins.length,p:parseFloat(allTrades.reduce((a,t)=>a+(t.pnl||0),0).toFixed(2))};
  res.json({
    version:"11.4-settings-tab", mode:IS_PAPER?"PAPER":"LIVE",
    signalMode:SIGNAL_MODE, noTradingView:true,
    exitStrategy:"price-monitor + DELETE /v2/positions",
    riskBudget:"$"+getRiskBudget(),
    optionsFeed:OPTIONS_FEED,
    realGreeks:gexCache?.hasRealGreeks||false,
    tp1Config:{mode:TP1_FIXED_MOVE>0?"fixed":"gex-adaptive",value:TP1_FIXED_MOVE>0?"$"+TP1_FIXED_MOVE:"GEX wall ("+TP1_MIN_MULT+"x-"+TP1_MAX_MULT+"x bounds, "+TP1_MULTIPLIER+"x fallback)"},
    trailingStop:{triggerPct:(TRAIL_TRIGGER_PCT*100)+"%",trailDistance:(TRAIL_DISTANCE_PCT*100)+"%"},
    sessionPnL:sessionPnL.toFixed(2), dailyLoss:dailyLoss.toFixed(2),
    dailyLossLimit:(ACCOUNT_SIZE*MAX_DAILY_LOSS).toFixed(2),
    tradesDay:tradesDay+"/"+MAX_TRADES_DAY,
    orb:orbState,
    flashAlpha:!!FLASHALPHA_KEY,
    gex:gexCache?{regime:gexCache.regime,gammaFlip:gexCache.gammaFlip,source:gexCache.source||"Alpaca",callWall:gexCache.callWall||null,putWall:gexCache.putWall||null,callWalls:(gexCache.callWalls||[]).slice(0,3).map(w=>"$"+w.price),putWalls:(gexCache.putWalls||[]).slice(0,3).map(w=>"$"+w.price),maxPain:gexCache.maxPain||null,zeroDteMagnet:gexCache.zeroDteMagnet||null,pinRisk:gexCache.pinRisk||null,dex:gexCache.dex||null,vex:gexCache.vex||null}:null,
    signals:{today:signalHistory.length,active:signalHistory.filter(s=>["FILLED","SENT"].includes(s.status)).length},
    db:{totalTrades:s.t||0,wins:s.w||0,totalPnL:s.p||0,winRate:s.t>0?((s.w/s.t)*100).toFixed(1)+"%":"—",persistent:!!RAILWAY_VOLUME,dir:DB_DIR},
  });
});

// ── Schedulers ────────────────────────────────────────────────────────────────
// All scheduler intervals fire every minute regardless of day; without a weekday
// gate they'd hit FlashAlpha/Alpaca with weekend dates (markets closed Sat/Sun),
// burning API quota and producing confusing 404 log noise that lingers in the
// rolling logHistory buffer into the next trading day.
function isWeekday(etDate){ const d=etDate.getDay(); return d>=1&&d<=5; }

// Signal engine: runs on 5-min bar close (every minute, fires when new bar available)
setInterval(async()=>{
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  if(!isWeekday(now)) return;
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
  if(!isWeekday(now)) return;
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
  if(!isWeekday(now)) return;
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
 ║   SPX COMMAND v11 · FlashAlpha · Autonomous         ║
 ╠══════════════════════════════════════════════════════╣
 ║  Signal engine : 5-min bar close scan               ║
 ║  Indicators    : ORB(15m) + VWAP + RSI + EMA        ║
 ║  GEX source    : ${(FLASHALPHA_KEY?"FlashAlpha API":"DISABLED").padEnd(35)}║
 ║  Signal mode   : ${SIGNAL_MODE.padEnd(35)}║
 ║  Exit          : Price monitor + DELETE position     ║
 ║  Database      : JSON files at ${DB_DIR.slice(-22).padEnd(22)}║
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
