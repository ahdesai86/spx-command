/**
 * SPX COMMAND v8 — Clean Rebuild
 * ─────────────────────────────────────────────────────────────────────────────
 * SPY 0DTE long options · Alpaca Paper API · Railway hosting
 *
 * EXIT STRATEGY (fixes all 403 errors):
 *   Uses price monitoring + DELETE /v2/positions/{symbol} to close
 *   NO sell orders placed — eliminates all "uncovered option" errors
 *
 * ENV VARIABLES (set in Railway):
 *   ALPACA_KEY, ALPACA_SECRET, ALPACA_BASE_URL
 *   ACCOUNT_SIZE, RISK_DOLLARS, RISK_PER_TRADE
 *   MAX_DAILY_LOSS, PREMIUM_STOP_PCT
 *   TP1_MULTIPLIER, TP1_FIXED_MOVE
 *   GEX_BUFFER, PORT
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
const PORT             = parseInt(process.env.PORT               || "3001");
const IS_PAPER         = ALPACA_BASE.includes("paper");

function getRiskBudget() {
  return RISK_DOLLARS > 0 ? RISK_DOLLARS : ACCOUNT_SIZE * RISK_PER_TRADE;
}

function calcContracts(premium) {
  if (!premium || premium <= 0) return 1;
  return Math.max(1, Math.floor(getRiskBudget() / (premium * 100)));
}

function calcTP1(entry, delta) {
  if (TP1_FIXED_MOVE > 0) {
    const move = TP1_FIXED_MOVE * (delta || 0.35);
    return parseFloat((entry + move).toFixed(2));
  }
  return parseFloat((entry * TP1_MULTIPLIER).toFixed(2));
}

// ── State ─────────────────────────────────────────────────────────────────────
let sessionPnL    = 0;
let dailyLoss     = 0;
let signalHistory = [];
let sseClients    = [];
let logHistory    = [];
let gexCache      = null;
let gexCacheTime  = 0;
let gexFired      = new Set();
let gexLastDate   = "";
const MAX_LOGS    = 500;
const GEX_SCHEDULE = [{h:9,m:25},{h:10,m:30},{h:12,m:0},{h:14,m:0}];

// ── Journal ───────────────────────────────────────────────────────────────────
const JOURNAL_FILE = path.join(__dirname, "trade_journal.json");

function loadJournal() {
  try {
    if (fs.existsSync(JOURNAL_FILE)) {
      return JSON.parse(fs.readFileSync(JOURNAL_FILE, "utf8"));
    }
  } catch(e) { log("JOURNAL ERR", e.message); }
  return { trades:[], stats:{ totalTrades:0, wins:0, losses:0, totalPnL:0, winRate:0, avgWin:0, avgLoss:0 } };
}

function saveJournal(j) {
  try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(j, null, 2)); } catch(e) { log("JOURNAL ERR", e.message); }
}

function recordTrade(signal, reason) {
  const j    = loadJournal();
  const pnl  = signal.closePnl || 0;
  const win  = pnl > 0;
  const trade = {
    id: signal.id, bot: "SPX-COMMAND-v8",
    date: new Date().toLocaleDateString("en-US",{timeZone:"America/New_York"}),
    time: signal.time,
    symbol: signal.optionSymbol, direction: signal.direction,
    right: signal.right, strike: signal.strike, expiry: signal.expiry,
    contracts: signal.contracts, fillPrice: signal.fillPrice,
    totalCost: signal.totalCost, stopPrice: signal.stopPrice,
    tp1Price: signal.tp1Price, closePnl: parseFloat(pnl.toFixed(2)),
    pnlPct: signal.fillPrice && signal.totalCost
      ? parseFloat(((pnl / signal.totalCost) * 100).toFixed(1)) : null,
    closeReason: reason, outcome: win ? "WIN" : pnl===0 ? "BREAKEVEN" : "LOSS",
    trigger: signal.trigger, gexRegime: signal.gexSnapshot?.regime || null,
    tp1Mode: TP1_FIXED_MOVE > 0 ? "fixed-$"+TP1_FIXED_MOVE : TP1_MULTIPLIER+"x",
    riskBudget: getRiskBudget(),
  };
  j.trades.unshift(trade);
  j.stats.totalTrades++;
  if (win)   j.stats.wins++;
  if (pnl<0) j.stats.losses++;
  j.stats.totalPnL = parseFloat((j.stats.totalPnL + pnl).toFixed(2));
  j.stats.winRate  = parseFloat(((j.stats.wins / j.stats.totalTrades)*100).toFixed(1));
  const winTrades  = j.trades.filter(t=>t.closePnl>0);
  const lossTrades = j.trades.filter(t=>t.closePnl<0);
  j.stats.avgWin   = winTrades.length  ? parseFloat((winTrades.reduce((a,t)=>a+t.closePnl,0)/winTrades.length).toFixed(2))  : 0;
  j.stats.avgLoss  = lossTrades.length ? parseFloat((lossTrades.reduce((a,t)=>a+t.closePnl,0)/lossTrades.length).toFixed(2)) : 0;
  saveJournal(j);
  log("JOURNAL", trade.outcome+" | "+trade.symbol+" | P&L $"+trade.closePnl+" | WinRate "+j.stats.winRate+"%");
  broadcast({ type:"journal_update", trade, stats:j.stats });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const t = new Date().toLocaleTimeString("en-US",{hour12:false,timeZone:"America/New_York"});
  const entry = { type:"log", time:t, tag, msg };
  console.log("["+t+" ET] ["+tag+"] "+msg);
  logHistory.push(entry);
  if (logHistory.length > MAX_LOGS) logHistory.shift();
  broadcast(entry);
}

function broadcast(payload) {
  const data = "data: "+JSON.stringify(payload)+"\n\n";
  sseClients.forEach(c=>{ try { c.write(data); } catch(_){} });
}

// ── Alpaca helpers ─────────────────────────────────────────────────────────────
function aHeaders() {
  return {
    "APCA-API-KEY-ID":     ALPACA_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SECRET,
    "Content-Type":        "application/json",
    "Accept":              "application/json",
  };
}

async function aGet(path, base) {
  const res = await fetch((base||ALPACA_BASE)+path, {headers:aHeaders()});
  if (!res.ok) { const e=await res.text(); throw new Error("GET "+path+" "+res.status+": "+e); }
  return res.json();
}

async function aPost(path, body) {
  const res = await fetch(ALPACA_BASE+path, {method:"POST",headers:aHeaders(),body:JSON.stringify(body)});
  if (!res.ok) { const e=await res.text(); throw new Error("POST "+path+" "+res.status+": "+e); }
  return res.json();
}

async function aDelete(path) {
  const res = await fetch(ALPACA_BASE+path, {method:"DELETE",headers:aHeaders()});
  return { ok:res.ok, status:res.status, data: res.ok ? await res.json().catch(()=>({})) : await res.text() };
}

// ── Position close (the only exit method) ────────────────────────────────────
async function closePosition(symbol) {
  // DELETE /v2/positions/{symbol} — Alpaca's official way to close any position
  return await aDelete("/v2/positions/"+encodeURIComponent(symbol));
}

// ── Price monitor — checks every 30s, closes via DELETE when stop/TP1 hit ─────
function startMonitor(signal) {
  log("MONITOR", "Watching "+signal.optionSymbol+" | stop $"+signal.stopPrice+" | tp1 $"+signal.tp1Price);

  const iv = setInterval(async () => {
    if (!["FILLED"].includes(signal.status)) { clearInterval(iv); return; }

    try {
      const pos   = await aGet("/v2/positions/"+encodeURIComponent(signal.optionSymbol));
      const price = parseFloat(pos.current_price || 0);
      if (!price) return;

      const entry  = signal.fillPrice || signal.midPrice;
      const pnlPct = ((price-entry)/entry*100).toFixed(1);
      log("MONITOR", signal.optionSymbol+" | $"+price+" | P&L "+pnlPct+"% | stop $"+signal.stopPrice+" | tp1 $"+signal.tp1Price);

      // TP1 hit
      if (price >= signal.tp1Price) {
        clearInterval(iv);
        log("TP1", "Target hit $"+price+" >= $"+signal.tp1Price);
        const r = await closePosition(signal.optionSymbol);
        log("TP1", "Close result: "+r.status+" "+JSON.stringify(r.data).slice(0,100));
        const pnl = (price - entry) * 100 * signal.contracts;
        signal.status   = "TP1_HIT";
        signal.closePnl = pnl;
        sessionPnL += pnl;
        broadcast({type:"signal_update",id:signal.id,status:"TP1_HIT",pnl});
        recordTrade(signal, "TP1_HIT");
        // Trail stop to breakeven if TP1 hits but position still open
        return;
      }

      // Stop hit
      if (price <= signal.stopPrice) {
        clearInterval(iv);
        log("STOP", "Stop hit $"+price+" <= $"+signal.stopPrice);
        const r = await closePosition(signal.optionSymbol);
        log("STOP", "Close result: "+r.status+" "+JSON.stringify(r.data).slice(0,100));
        const pnl = (price - entry) * 100 * signal.contracts;
        signal.status   = "STOPPED";
        signal.closePnl = pnl;
        sessionPnL += pnl;
        dailyLoss  += Math.abs(Math.min(0, pnl));
        broadcast({type:"signal_update",id:signal.id,status:"STOPPED",pnl});
        recordTrade(signal, "STOP_HIT");
        return;
      }

    } catch(e) {
      // 404 = position closed/expired
      if (e.message.includes("404") || e.message.includes("40410000")) {
        clearInterval(iv);
        log("MONITOR", signal.optionSymbol+" no longer exists — expired or closed");
        signal.status = "EOD_CLOSED";
        broadcast({type:"signal_update",id:signal.id,status:"EOD_CLOSED"});
        recordTrade(signal, "EXPIRED");
      }
    }
  }, 30000);

  signal._monitorInterval = iv;
  return iv;
}

// ── GEX ───────────────────────────────────────────────────────────────────────
async function getSPYSpot() {
  try {
    const r = await fetch(ALPACA_DATA+"/v2/stocks/SPY/quotes/latest", {headers:aHeaders()});
    if (!r.ok) return null;
    const d = await r.json();
    return parseFloat((d.quote||{}).ap || (d.quote||{}).bp || 0) || null;
  } catch(_) { return null; }
}

async function calcGEX() {
  try {
    log("GEX", "Calculating from Alpaca chain...");
    const spot = await getSPYSpot();
    if (!spot) { log("GEX ERR","No SPY spot — market may be closed"); return null; }
    log("GEX","SPY spot: $"+spot.toFixed(2));

    const d   = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    const exp = d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");

    // Fetch contracts list first
    let contracts=[], next=null;
    do {
      let url = ALPACA_DATA+"/v1beta1/options/contracts?underlying_symbol=SPY&status=active&limit=250"+
        "&expiration_date_gte="+exp+"&expiration_date_lte="+exp;
      if (next) url += "&page_token="+next;
      const r = await fetch(url, {headers:aHeaders()});
      if (!r.ok) { log("GEX ERR","Contracts "+r.status+": "+await r.text()); break; }
      const data = await r.json();
      contracts  = contracts.concat(data.option_contracts||[]);
      next       = data.next_page_token||null;
    } while(next);

    if (!contracts.length) { log("GEX ERR","No contracts for "+exp); return null; }
    log("GEX","Got "+contracts.length+" contracts — fetching greeks...");

    // Batch fetch snapshots for greeks
    const symbols = contracts.map(c=>c.symbol).filter(Boolean);
    const snaps   = {};
    for (let i=0; i<symbols.length; i+=100) {
      const batch = symbols.slice(i,i+100);
      try {
        const r = await fetch(ALPACA_DATA+"/v1beta1/options/snapshots?symbols="+batch.join(","), {headers:aHeaders()});
        if (r.ok) Object.assign(snaps, (await r.json()).snapshots||{});
      } catch(_){}
    }

    // Calculate GEX per strike
    const strikeMap = {};
    for (const c of contracts) {
      const snap   = snaps[c.symbol]||{};
      const greeks = snap.greeks||{};
      const gamma  = parseFloat(greeks.gamma||0);
      const oi     = parseFloat(snap.openInterest||c.open_interest||0);
      const strike = parseFloat(c.strike_price||0);
      const type   = (c.type||"").toUpperCase();
      if (!strike||!gamma||!oi) continue;
      const gex = gamma*oi*100*spot;
      if (!strikeMap[strike]) strikeMap[strike]={call:0,put:0};
      if (type==="CALL"||type==="C") strikeMap[strike].call += gex;
      if (type==="PUT" ||type==="P") strikeMap[strike].put  -= gex;
    }

    const strikes = Object.keys(strikeMap).map(Number).sort((a,b)=>a-b);
    if (!strikes.length) { log("GEX ERR","No GEX data — greeks unavailable"); return null; }

    let net=0, cum=0, flip=spot;
    const levels = strikes.map(s=>{ const n=strikeMap[s].call+strikeMap[s].put; net+=n; return {strike:s,...strikeMap[s],net:n}; });
    for (const l of levels) { const p=cum; cum+=l.net; if((p<0&&cum>=0)||(p>=0&&cum<0)){flip=l.strike;break;} }

    const callWalls = levels.filter(l=>l.strike>spot&&l.call>0).sort((a,b)=>b.call-a.call).slice(0,5).map(l=>({price:l.strike,gex:Math.round(l.call)}));
    const putWalls  = levels.filter(l=>l.strike<spot&&l.put<0).sort((a,b)=>a.put-b.put).slice(0,5).map(l=>({price:l.strike,gex:Math.round(Math.abs(l.put))}));

    const result = { callWalls, putWalls, gammaFlip:parseFloat(flip.toFixed(2)),
      netGex:Math.round(net), regime:net>=0?"positive":"negative",
      spotPrice:spot, updatedAt:new Date().toISOString(), source:"alpaca-calculated" };

    log("GEX","✓ Regime:"+result.regime+" | Flip:$"+result.gammaFlip+
      " | Calls:"+callWalls.slice(0,3).map(w=>"$"+w.price).join(",")+" | Net:"+Math.round(net/1e6)+"M");
    broadcast({type:"gex_update",...result});
    return result;
  } catch(e) { log("GEX ERR","calcGEX: "+e.message); return null; }
}

async function getGEX(force) {
  const now   = Date.now();
  const today = new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
  if (today!==gexLastDate) { gexFired=new Set(); gexLastDate=today; gexCache=null; gexCacheTime=0; }
  if (!force && gexCache && (now-gexCacheTime)<7200000) return gexCache;
  const r = await calcGEX();
  if (r) { gexCache=r; gexCacheTime=now; }
  return gexCache;
}

function applyGEX(direction, entry, tp1, tp2) {
  if (!gexCache) return {allowed:true,reason:"No GEX — using ORB targets",tp1,tp2,target:null};
  if (direction==="LONG") {
    const walls = (gexCache.callWalls||[]).filter(w=>w.price>entry+GEX_BUFFER).sort((a,b)=>a.price-b.price);
    if (!walls.length) return {allowed:true,reason:"No call wall above",tp1,tp2,target:null};
    if (walls[0].price-entry<GEX_BUFFER) return {allowed:false,reason:"LONG blocked — at call wall $"+walls[0].price,tp1,tp2,target:walls[0].price};
    return {allowed:true,reason:"LONG → call wall $"+walls[0].price,tp1:walls[0].price,tp2:(walls[1]||walls[0]).price,target:walls[0].price};
  }
  if (direction==="SHORT") {
    const walls = (gexCache.putWalls||[]).filter(w=>w.price<entry-GEX_BUFFER).sort((a,b)=>b.price-a.price);
    if (!walls.length) return {allowed:true,reason:"No put wall below",tp1,tp2,target:null};
    if (entry-walls[0].price<GEX_BUFFER) return {allowed:false,reason:"SHORT blocked — at put wall $"+walls[0].price,tp1,tp2,target:walls[0].price};
    return {allowed:true,reason:"SHORT → put wall $"+walls[0].price,tp1:walls[0].price,tp2:(walls[1]||walls[0]).price,target:walls[0].price};
  }
  return {allowed:true,reason:"No GEX filter",tp1,tp2,target:null};
}

// ── Strike selection ──────────────────────────────────────────────────────────
function selectStrike(spyEntry, direction) {
  const atm = Math.round(spyEntry);
  if (!gexCache) return {strike:atm,reason:"ATM (no GEX)",delta:0.50,otm:0};
  const isPos = gexCache.regime==="positive";
  if (direction==="LONG") {
    const walls = (gexCache.callWalls||[]).filter(w=>w.price>spyEntry).sort((a,b)=>a.price-b.price);
    if (!walls.length) return {strike:atm+1,reason:"OTM+1 (no call wall)",delta:0.45,otm:1};
    const dist  = walls[0].price-spyEntry;
    const otm   = Math.min(5,Math.max(1,Math.round(dist*(isPos?0.30:0.15))));
    const strike= Math.min(atm+otm, walls[0].price-1);
    return {strike:Math.round(strike),reason:(isPos?"positive":"negative")+" GEX → $"+otm+" OTM toward $"+walls[0].price,delta:Math.max(0.15,0.50-otm*0.08),otm};
  }
  if (direction==="SHORT") {
    const walls = (gexCache.putWalls||[]).filter(w=>w.price<spyEntry).sort((a,b)=>b.price-a.price);
    if (!walls.length) return {strike:atm-1,reason:"OTM+1 (no put wall)",delta:0.45,otm:1};
    const dist  = spyEntry-walls[0].price;
    const otm   = Math.min(5,Math.max(1,Math.round(dist*(isPos?0.30:0.15))));
    const strike= Math.max(atm-otm, walls[0].price+1);
    return {strike:Math.round(strike),reason:(isPos?"positive":"negative")+" GEX → $"+otm+" OTM toward $"+walls[0].price,delta:Math.max(0.15,0.50-otm*0.08),otm};
  }
  return {strike:atm,reason:"ATM fallback",delta:0.50,otm:0};
}

// ── OCC symbol ────────────────────────────────────────────────────────────────
function buildSymbol(strike, right, date) {
  const yy=String(date.getFullYear()).slice(2);
  const mm=String(date.getMonth()+1).padStart(2,"0");
  const dd=String(date.getDate()).padStart(2,"0");
  return "SPY"+yy+mm+dd+right+String(Math.round(strike*1000)).padStart(8,"0");
}

function getETDate() {
  return new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
}

async function getMidPrice(symbol) {
  try {
    const r = await fetch(ALPACA_DATA+"/v1beta1/options/snapshots?symbols="+symbol, {headers:aHeaders()});
    if (!r.ok) return null;
    const d = await r.json();
    const s = (d.snapshots||{})[symbol];
    if (!s||!s.latestQuote) return null;
    const bid=parseFloat(s.latestQuote.bp||0), ask=parseFloat(s.latestQuote.ap||0);
    if (bid<=0||ask<=0) return null;
    return parseFloat(((bid+ask)/2).toFixed(2));
  } catch(_) { return null; }
}

// ── Execute signal ────────────────────────────────────────────────────────────
async function executeSignal(id) {
  const sig = signalHistory.find(s=>s.id===id);
  if (!sig||sig.status!=="PENDING") return;
  if (!ALPACA_KEY||!ALPACA_SECRET) { log("ERROR","No Alpaca keys"); return; }

  sig.status = "EXECUTING";
  broadcast({type:"signal_update",id,status:"EXECUTING"});

  try {
    const date  = getETDate();
    const si    = selectStrike(sig.spyEntry, sig.direction);
    sig.strike  = si.strike;
    sig.strikeReason   = si.reason;
    sig.estimatedDelta = si.delta;

    log("STRIKE",sig.direction+" SPY | ATM $"+Math.round(sig.spyEntry)+" | Selected $"+si.strike+" ("+si.otm+" OTM) | "+si.reason);

    const symbol = buildSymbol(si.strike, sig.right, date);
    sig.optionSymbol = symbol;

    // Safety: verify OCC format
    if (!/^SPY\d{6}[CP]\d{8}$/.test(symbol)) throw new Error("SAFETY: Bad OCC symbol: "+symbol);

    // Get mid price
    let mid = await getMidPrice(symbol);
    if (!mid || mid < 0.05 || mid > 50) {
      // Try ATM fallback
      const atmSymbol = buildSymbol(Math.round(sig.spyEntry), sig.right, date);
      mid = await getMidPrice(atmSymbol);
      if (!mid) throw new Error("No valid option price — market may be closed");
      sig.optionSymbol = atmSymbol;
      sig.strike = Math.round(sig.spyEntry);
      sig.strikeReason = "ATM fallback (no price for OTM)";
      log("STRIKE","Fell back to ATM $"+sig.strike);
    }

    const contracts = calcContracts(mid);
    const totalCost = parseFloat((mid*100*contracts).toFixed(2));

    // Safety checks
    if (contracts > 50)              throw new Error("SAFETY: "+contracts+" contracts > max 50");
    if (totalCost > ACCOUNT_SIZE*0.10) throw new Error("SAFETY: $"+totalCost+" > 10% of account");

    log("SAFETY","Guards passed — "+sig.optionSymbol+" x"+contracts+" @ $"+mid+" = $"+totalCost);

    // Place buy order
    const order = await aPost("/v2/orders", {
      symbol:          sig.optionSymbol,
      qty:             String(contracts),
      side:            "buy",
      type:            "limit",
      limit_price:     String(mid),
      time_in_force:   "day",
      client_order_id: "spxcmd_"+sig.id,
    });

    sig.contracts  = contracts;
    sig.midPrice   = mid;
    sig.totalCost  = totalCost;
    sig.status     = "SENT";
    broadcast({type:"signal_update",id,status:"SENT",optionSymbol:sig.optionSymbol,
      contracts,midPrice:mid,totalCost,strike:sig.strike,strikeReason:sig.strikeReason});
    log("ALPACA","Order: "+order.id+" | "+sig.optionSymbol+" x"+contracts+" @ $"+mid);

    // Poll for fill
    const filled = await pollFill(order.id, 60000);
    if (!filled) { log("ORDER","Unfilled after 60s"); return; }

    sig.fillPrice = parseFloat(filled.filled_avg_price||mid);
    sig.status    = "FILLED";

    // Calculate exits
    const stop = parseFloat((sig.fillPrice*(1-PREMIUM_STOP_PCT)).toFixed(2));
    const tp1  = calcTP1(sig.fillPrice, sig.estimatedDelta);
    sig.stopPrice = stop;
    sig.tp1Price  = tp1;

    broadcast({type:"signal_update",id,status:"FILLED",fillPrice:sig.fillPrice,stopPrice:stop,tp1Price:tp1});
    log("FILL","Filled @ $"+sig.fillPrice+" | stop $"+stop+" ("+PREMIUM_STOP_PCT*100+"%) | tp1 $"+tp1+" ("+TP1_MULTIPLIER+"x) | R:R "+((tp1-sig.fillPrice)/(sig.fillPrice-stop)).toFixed(1)+":1");
    log("EXIT","Using price monitor — no sell orders placed (avoids uncovered option errors)");

    // Start price monitor — handles all exits
    startMonitor(sig);

  } catch(e) {
    sig.status = "PENDING";
    broadcast({type:"signal_update",id,status:"PENDING"});
    log("ERROR","Execute failed #"+id+": "+e.message);
  }
}

async function pollFill(orderId, maxMs) {
  const start = Date.now();
  while (Date.now()-start < maxMs) {
    const o = await aGet("/v2/orders/"+orderId);
    if (o.status==="filled") return o;
    if (["cancelled","expired","rejected"].includes(o.status)) throw new Error("Order "+orderId+" "+o.status);
    await new Promise(r=>setTimeout(r,2000));
  }
  return null;
}

// ── EOD force close ───────────────────────────────────────────────────────────
async function forceCloseAll() {
  const active = signalHistory.filter(s=>["FILLED","SENT"].includes(s.status));
  if (!active.length) { log("EOD","No open positions"); return; }
  log("EOD","Force closing "+active.length+" position(s)");

  for (const sig of active) {
    // Stop monitor
    if (sig._monitorInterval) { clearInterval(sig._monitorInterval); }
    try {
      const r = await closePosition(sig.optionSymbol);
      log("EOD","Closed "+sig.optionSymbol+" → "+r.status);
      if (r.ok) {
        sig.status = "EOD_CLOSED";
        broadcast({type:"signal_update",id:sig.id,status:"EOD_CLOSED"});
        recordTrade(sig,"EOD_FORCE_CLOSE");
      } else {
        log("EOD ERR","Close failed: "+JSON.stringify(r.data));
      }
    } catch(e) { log("EOD ERR",sig.optionSymbol+": "+e.message); }
  }
}

// ── Account check ─────────────────────────────────────────────────────────────
async function checkAccount() {
  if (!ALPACA_KEY||!ALPACA_SECRET) { log("WARN","No Alpaca keys set"); return; }
  try {
    const a = await aGet("/v2/account");
    log("ALPACA","Connected — "+(IS_PAPER?"PAPER":"LIVE")+
      " | Balance: $"+parseFloat(a.portfolio_value).toLocaleString()+
      " | Buying power: $"+parseFloat(a.buying_power).toLocaleString()+
      " | Options level: "+( a.options_approved_level||"unknown"));
    broadcast({type:"alpaca_status",connected:true,paper:IS_PAPER,balance:a.portfolio_value});
  } catch(e) {
    log("ALPACA ERR",e.message);
    broadcast({type:"alpaca_status",connected:false});
  }
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(cors({origin:"*",methods:["GET","POST","DELETE","OPTIONS"],allowedHeaders:["Content-Type"]}));
app.options("*",cors());
app.use(express.json());

// Health
app.get("/", (req,res)=>res.json({
  service:"SPX COMMAND",status:"running",version:"8.0-clean",
  mode:IS_PAPER?"PAPER":"LIVE",time:new Date().toISOString(),
  exitStrategy:"price-monitor + DELETE /v2/positions",
}));

// Dashboard
app.get("/dashboard",(req,res)=>{
  const f = path.join(__dirname,"dashboard.html");
  if (fs.existsSync(f)) res.sendFile(f);
  else res.status(404).send("Upload dashboard.html to Railway");
});

// SSE
app.get("/events",(req,res)=>{
  res.setHeader("Content-Type","text/event-stream");
  res.setHeader("Cache-Control","no-cache");
  res.setHeader("Connection","keep-alive");
  res.setHeader("Access-Control-Allow-Origin","*");
  res.flushHeaders();
  sseClients.push(res);
  res.write("data: "+JSON.stringify({
    type:"init",sessionPnL,dailyLoss,signals:signalHistory,
    gex:gexCache,expiry:getETDate().toISOString().slice(0,10).replace(/-/g,""),
    riskBudget:getRiskBudget(),logs:logHistory,
  })+"\n\n");
  const ping=setInterval(()=>{ try{res.write(": ping\n\n");}catch(_){clearInterval(ping);} },30000);
  req.on("close",()=>{ clearInterval(ping); sseClients=sseClients.filter(c=>c!==res); });
});

// GEX
app.get("/gex",async(req,res)=>{
  if (req.query.refresh==="true") { const g=await getGEX(true); return res.json(g||{error:"GEX unavailable"}); }
  res.json(gexCache||{error:"Not yet calculated",hint:"?refresh=true"});
});

// Webhook
app.post("/webhook",async(req,res)=>{
  const raw = req.body;
  log("WEBHOOK",JSON.stringify(raw));

  const req_fields = ["symbol","direction","entry","stop","tp1","tp2"];
  const missing    = req_fields.filter(k=>raw[k]==null);
  if (missing.length) return res.status(400).json({error:"Missing: "+missing.join(",")});

  if (dailyLoss >= ACCOUNT_SIZE*MAX_DAILY_LOSS) {
    log("GUARD","Daily loss limit reached — signal rejected");
    return res.json({status:"rejected",reason:"daily_loss_limit"});
  }

  const entry     = parseFloat(raw.entry);
  const stop      = parseFloat(raw.stop);
  const tp1       = parseFloat(raw.tp1);
  const tp2       = parseFloat(raw.tp2);
  const direction = raw.direction.toUpperCase();
  const right     = direction==="LONG" ? "C" : "P";
  const gexResult = applyGEX(direction, entry, tp1, tp2);

  if (!gexResult.allowed) {
    log("GEX","Signal BLOCKED — "+gexResult.reason);
    broadcast({type:"signal_blocked",reason:gexResult.reason});
    return res.json({status:"blocked",reason:gexResult.reason});
  }
  log("GEX","Signal ALLOWED — "+gexResult.reason);

  const sig = {
    id:          Date.now(),
    time:        new Date().toLocaleTimeString("en-US",{hour12:false,timeZone:"America/New_York"}),
    symbol:      "SPY", direction, right,
    spyEntry:    entry,
    strike:      Math.round(entry),
    stop, tp1:gexResult.tp1, tp2:gexResult.tp2,
    gexTarget:   gexResult.target,
    gexReason:   gexResult.reason,
    expiry:      (()=>{ const d=getETDate(); return d.getFullYear()+String(d.getMonth()+1).padStart(2,"0")+String(d.getDate()).padStart(2,"0"); })(),
    riskBudget:  getRiskBudget(),
    contracts:   null, midPrice:null, totalCost:null,
    fillPrice:   null, stopPrice:null, tp1Price:null,
    optionSymbol:null, strikeReason:null, estimatedDelta:null,
    closePnl:    null, trailedToBreakeven:false,
    trigger:     raw.trigger||"TradingView Alert",
    confidence:  raw.confidence||"MEDIUM",
    status:      "PENDING",
    gexSnapshot: gexCache ? {callWalls:(gexCache.callWalls||[]).slice(0,3),putWalls:(gexCache.putWalls||[]).slice(0,3),gammaFlip:gexCache.gammaFlip,regime:gexCache.regime} : null,
  };

  signalHistory.unshift(sig);
  broadcast({type:"new_signal",signal:sig});
  log("SIGNAL",direction+" SPY | entry $"+entry+" | tp1 $"+gexResult.tp1+" | risk $"+getRiskBudget());

  res.json({status:"received",signal:sig});
  executeSignal(sig.id);
});

// Manual execute
app.post("/execute/:id",(req,res)=>{
  const id  = parseInt(req.params.id);
  const sig = signalHistory.find(s=>s.id===id);
  if (!sig)                    return res.status(404).json({error:"Not found"});
  if (sig.status!=="PENDING")  return res.status(400).json({error:"Not pending: "+sig.status});
  res.json({status:"executing",id});
  executeSignal(id);
});

// Cancel
app.post("/cancel/:id",async(req,res)=>{
  const id  = parseInt(req.params.id);
  const sig = signalHistory.find(s=>s.id===id);
  if (!sig) return res.status(404).json({error:"Not found"});
  if (sig._monitorInterval) clearInterval(sig._monitorInterval);
  if (sig.optionSymbol && ["FILLED","SENT"].includes(sig.status)) {
    try { await closePosition(sig.optionSymbol); } catch(_){}
  }
  sig.status = "CANCELLED";
  broadcast({type:"signal_update",id,status:"CANCELLED"});
  log("CANCEL","Signal #"+id+" cancelled");
  res.json({status:"cancelled"});
});

// Close all
app.post("/closeall",async(req,res)=>{ await forceCloseAll(); res.json({status:"done"}); });

// Close specific position
app.post("/closeposition/:symbol",async(req,res)=>{
  const symbol = req.params.symbol;
  const r = await closePosition(symbol);
  log("MANUAL","Closed "+symbol+" → "+r.status);
  res.json({status:r.ok?"closed":"failed",result:r.data});
});

// Journal
app.get("/journal",(req,res)=>res.json(loadJournal()));
app.get("/journal/csv",(req,res)=>{
  const j = loadJournal();
  if (!j.trades.length) return res.json({error:"No trades"});
  const h = Object.keys(j.trades[0]).join(",");
  const r = j.trades.map(t=>Object.values(t).map(v=>typeof v==="string"&&v.includes(",")?"\""+v+"\"":v).join(",")).join("\n");
  res.setHeader("Content-Type","text/csv");
  res.setHeader("Content-Disposition","attachment;filename=spx_command_trades.csv");
  res.send(h+"\n"+r);
});

// Sync
app.get("/sync",async(req,res)=>{
  // Monitor handles exits — sync just reports status
  const active = signalHistory.filter(s=>["FILLED"].includes(s.status));
  res.json({active:active.length,monitoring:active.filter(s=>s._monitorInterval).length});
});

// Status
app.get("/status",(req,res)=>{
  const j = loadJournal();
  res.json({
    version:"8.0-clean", mode:IS_PAPER?"PAPER":"LIVE", broker:"Alpaca",
    underlying:"SPY (long options)", exitStrategy:"price-monitor + DELETE position",
    riskMode:"Fixed $"+getRiskBudget()+" per trade", riskBudget:"$"+getRiskBudget(),
    tp1Config:{ mode:TP1_FIXED_MOVE>0?"fixed-move":"multiplier", value:TP1_FIXED_MOVE>0?"$"+TP1_FIXED_MOVE+" move":TP1_MULTIPLIER+"x premium" },
    sessionPnL:sessionPnL.toFixed(2), dailyLoss:dailyLoss.toFixed(2),
    dailyLossLimit:(ACCOUNT_SIZE*MAX_DAILY_LOSS).toFixed(2),
    expiry:(()=>{ const d=getETDate(); return d.getFullYear()+String(d.getMonth()+1).padStart(2,"0")+String(d.getDate()).padStart(2,"0"); })(),
    gex: gexCache ? {regime:gexCache.regime,gammaFlip:gexCache.gammaFlip,netGex:gexCache.netGex,callWalls:(gexCache.callWalls||[]).slice(0,3).map(w=>"$"+w.price),putWalls:(gexCache.putWalls||[]).slice(0,3).map(w=>"$"+w.price),updatedAt:gexCache.updatedAt} : null,
    journal:{ totalTrades:j.stats.totalTrades||0, wins:j.stats.wins||0, losses:j.stats.losses||0, winRate:j.stats.winRate||0, totalPnL:j.stats.totalPnL||0 },
    signals:{ today:signalHistory.length, pending:signalHistory.filter(s=>s.status==="PENDING").length, active:signalHistory.filter(s=>["SENT","FILLED","EXECUTING"].includes(s.status)).length, closed:signalHistory.filter(s=>["STOPPED","EOD_CLOSED","CANCELLED","TP1_HIT"].includes(s.status)).length },
  });
});

// ── Schedulers ────────────────────────────────────────────────────────────────

// GEX scheduler
setInterval(async()=>{
  const now   = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(), m=now.getMinutes();
  const today = now.toLocaleDateString("en-CA");
  if (!((h>9||(h===9&&m>=25))&&h<16)) return;
  const key = today+"_"+h+"_"+m;
  if (GEX_SCHEDULE.some(s=>s.h===h&&s.m===m)&&!gexFired.has(key)) {
    gexFired.add(key);
    log("GEX","Scheduled refresh at "+String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+" ET");
    await getGEX(true);
  }
},60000);

// EOD 3:45 PM
setInterval(async()=>{
  const now = new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(), m=now.getMinutes();
  if (h===15&&m===45) {
    const key = now.toLocaleDateString("en-CA")+"_eod";
    if (!gexFired.has(key)) { gexFired.add(key); await forceCloseAll(); }
  }
},60000);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async()=>{
  console.log(`
 ╔══════════════════════════════════════════════════════╗
 ║   SPX COMMAND v8 · Clean Build                      ║
 ╠══════════════════════════════════════════════════════╣
 ║  Health    : GET  /                                  ║
 ║  Dashboard : GET  /dashboard                         ║
 ║  Webhook   : POST /webhook                           ║
 ║  Events    : GET  /events (SSE)                      ║
 ║  GEX       : GET  /gex (?refresh=true)               ║
 ║  Execute   : POST /execute/:id                       ║
 ║  Cancel    : POST /cancel/:id                        ║
 ║  CloseAll  : POST /closeall                          ║
 ║  Journal   : GET  /journal                           ║
 ║  CSV       : GET  /journal/csv                       ║
 ║  Status    : GET  /status                            ║
 ╠══════════════════════════════════════════════════════╣
 ║  Broker    : Alpaca (${IS_PAPER?"PAPER":"LIVE "})                         ║
 ║  Exit      : Price monitor + DELETE /v2/positions    ║
 ║  Risk      : $${getRiskBudget()} per trade                       ║
 ║  Stop      : ${PREMIUM_STOP_PCT*100}% | TP1: ${TP1_MULTIPLIER}x | EOD: 3:45 PM ET      ║
 ╚══════════════════════════════════════════════════════╝
`);
  await checkAccount();
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(),m=now.getMinutes();
  if ((h>9||(h===9&&m>=30))&&h<16) { log("GEX","Market open — calculating GEX..."); await getGEX(true); }
  else log("GEX","Market closed — GEX calculates at 9:25 AM ET Monday");
});
