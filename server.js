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

// ── Global crash guards ───────────────────────────────────────────────────────
// Railway runs Node 18+ where unhandled rejections kill the process by default.
// Without these, a single unexpected throw anywhere in an async scheduler
// (network glitch, Alpaca 5xx, unexpected data shape) will crash the server and
// take the dashboard URL offline until Railway restarts it (backoff: up to 60s).
process.on("uncaughtException", err => {
  console.error("[CRASH GUARD] uncaughtException — server kept alive:", err.message, err.stack);
});
process.on("unhandledRejection", (reason, promise) => {
  console.error("[CRASH GUARD] unhandledRejection — server kept alive:", reason);
});

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
// Single source of truth for the version — used by /, /status, and the startup banner so
// they can never drift apart again (the banner was stale at v11.8 while the app was v11.27).
const APP_VERSION      = "11.34-2dte-immediate-strikes";
const ACCOUNT_SIZE     = parseFloat(process.env.ACCOUNT_SIZE     || "100000");
const PORT             = parseInt(process.env.PORT               || "3001");
const IS_PAPER         = ALPACA_BASE.includes("paper");
const ORB_MINUTES      = 15; // 9:30–9:45 ET
const TP1_FIXED_MOVE   = parseFloat(process.env.TP1_FIXED_MOVE   || "0");
const TRADEECHO_PAT    = process.env.TRADEECHO_PAT || "";
const TRADEECHO_MCP    = "https://api.tradeecho.com/api/mcp/intel";
const TRADEECHO_MAX_REQUESTS_HOUR = 20;

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
let TRAIL_TRIGGER_PCT     = parseFloat(process.env.TRAIL_TRIGGER_PCT     || "0.50"); // gain % that activates trailing stop (overridden by $ if set)
let TRAIL_DISTANCE_PCT    = parseFloat(process.env.TRAIL_DISTANCE_PCT    || "0.20"); // trail this far below peak (overridden by $ if set)
let TRAIL_TRIGGER_DOLLARS = parseFloat(process.env.TRAIL_TRIGGER_DOLLARS || "0");    // > 0: use $ gain to trigger instead of %
let TRAIL_DISTANCE_DOLLARS= parseFloat(process.env.TRAIL_DISTANCE_DOLLARS|| "0");    // > 0: trail $ below peak instead of %
let MAX_OPTION_SPREAD_PCT = parseFloat(process.env.MAX_OPTION_SPREAD_PCT || "0.15"); // reject illiquid contracts
let GEX_BUFFER         = parseFloat(process.env.GEX_BUFFER       || "1.0");
let SIGNAL_MODE        = (process.env.SIGNAL_MODE || "MODERATE").toUpperCase().split(" ")[0]; // MODERATE or STRICT
let MAX_TRADES_DAY     = parseInt(process.env.MAX_TRADES_DAY || "3");
let RSI_LONG_MAX       = parseFloat(process.env.RSI_LONG_MAX  || "65"); // RSI ceiling for LONG entries (avoid overbought)
let RSI_SHORT_MIN      = parseFloat(process.env.RSI_SHORT_MIN || "35"); // RSI floor for SHORT entries (avoid oversold)
let DIRECTION_COOLDOWN = (process.env.DIRECTION_COOLDOWN || "ON").toUpperCase(); // ON/OFF — block direction after 2 consecutive stops
let DIRECTION_COOLDOWN_MINS = parseInt(process.env.DIRECTION_COOLDOWN_MINS || "60");
// Market mode auto-classifier — defaults ON; set OFF (env var or Settings tab) to classify+log only
let MARKET_MODE_AUTO = (process.env.MARKET_MODE_AUTO || "ON").toUpperCase(); // ON | OFF
// Optional hard override (skips classifier entirely when set)
let MARKET_MODE_OVERRIDE = (process.env.MARKET_MODE_OVERRIDE || "").toUpperCase(); // TREND | CHOP | NEUTRAL | ""

// Definitions used to validate/clamp incoming POST /settings updates
const SETTINGS_SCHEMA = {
  RISK_DOLLARS:      { type:"number", min:0,    max:50000,  set:v=>RISK_DOLLARS=v },
  RISK_PER_TRADE:    { type:"number", min:0,    max:1,      set:v=>RISK_PER_TRADE=v },
  MAX_DAILY_LOSS:    { type:"number", min:0.01, max:1,      set:v=>MAX_DAILY_LOSS=v },
  PREMIUM_STOP_PCT:  { type:"number", min:0.05, max:0.95,   set:v=>PREMIUM_STOP_PCT=v },
  TP1_MULTIPLIER:    { type:"number", min:1.1,  max:10,     set:v=>TP1_MULTIPLIER=v },
  TP1_MIN_MULT:      { type:"number", min:1.05, max:10,     set:v=>TP1_MIN_MULT=v },
  TP1_MAX_MULT:      { type:"number", min:1.1,  max:20,     set:v=>TP1_MAX_MULT=v },
  TRAIL_TRIGGER_PCT:     { type:"number", min:0.05, max:5,    set:v=>TRAIL_TRIGGER_PCT=v },
  TRAIL_DISTANCE_PCT:    { type:"number", min:0.01, max:0.95, set:v=>TRAIL_DISTANCE_PCT=v },
  TRAIL_TRIGGER_DOLLARS: { type:"number", min:0,    max:50,   set:v=>TRAIL_TRIGGER_DOLLARS=v },
  TRAIL_DISTANCE_DOLLARS:{ type:"number", min:0,    max:50,   set:v=>TRAIL_DISTANCE_DOLLARS=v },
  MAX_OPTION_SPREAD_PCT:{ type:"number", min:0.01, max:1,     set:v=>MAX_OPTION_SPREAD_PCT=v },
  GEX_BUFFER:            { type:"number", min:0,    max:20,   set:v=>GEX_BUFFER=v },
  SIGNAL_MODE:           { type:"enum",   values:["MODERATE","STRICT"], set:v=>SIGNAL_MODE=v },
  MAX_TRADES_DAY:        { type:"number", min:0,    max:50, integer:true, set:v=>MAX_TRADES_DAY=v },
  RSI_LONG_MAX:          { type:"number", min:40,   max:90,  set:v=>RSI_LONG_MAX=v },
  RSI_SHORT_MIN:         { type:"number", min:10,   max:60,  set:v=>RSI_SHORT_MIN=v },
  DIRECTION_COOLDOWN:    { type:"enum",   values:["ON","OFF"], set:v=>DIRECTION_COOLDOWN=v },
  DIRECTION_COOLDOWN_MINS:{ type:"number",min:5,   max:240, integer:true, set:v=>DIRECTION_COOLDOWN_MINS=v },
  MARKET_MODE_AUTO:      { type:"enum",   values:["ON","OFF"], set:v=>MARKET_MODE_AUTO=v },
  MARKET_MODE_OVERRIDE:  { type:"enum",   values:["","TREND","NEUTRAL","CHOP"], set:v=>MARKET_MODE_OVERRIDE=v },
  SIGNAL_SCAN_MINS:      { type:"number", min:5, max:30, integer:true, set:v=>SIGNAL_SCAN_MINS=snapTo5(v) },
  GEX_REFRESH_MINS:      { type:"number", min:5, max:30, integer:true, set:v=>GEX_REFRESH_MINS=snapTo5(v) },
  POST_TP1_COOLDOWN_MINS:{ type:"number", min:0, max:120, integer:true, set:v=>POST_TP1_COOLDOWN_MINS=v },
  REVERSAL_BLOCK:        { type:"enum",   values:["ON","OFF"], set:v=>REVERSAL_BLOCK=v },
  PATH_RESIST_BLOCK:     { type:"number", min:0.5, max:1, set:v=>PATH_RESIST_BLOCK=v },
  WALL_HARD_BLOCK:       { type:"number", min:2, max:20, set:v=>WALL_HARD_BLOCK=v },
  MAGNET_DIRECTION_FILTER:{ type:"enum",  values:["ON","OFF"], set:v=>MAGNET_DIRECTION_FILTER=v },
  MAGNET_RANGE:          { type:"number", min:0.5, max:10, set:v=>MAGNET_RANGE=v },
  MAX_DIR_LOSSES_DAY:    { type:"number", min:1, max:20, integer:true, set:v=>MAX_DIR_LOSSES_DAY=v },
  TREND_MIN_SCORE:       { type:"number", min:2, max:5, integer:true, set:v=>TREND_MIN_SCORE=v },
};

function getSettingsSnapshot(){
  return {
    RISK_DOLLARS, RISK_PER_TRADE, MAX_DAILY_LOSS, PREMIUM_STOP_PCT,
    TP1_MULTIPLIER, TP1_MIN_MULT, TP1_MAX_MULT,
    TRAIL_TRIGGER_PCT, TRAIL_DISTANCE_PCT,
    TRAIL_TRIGGER_DOLLARS, TRAIL_DISTANCE_DOLLARS, MAX_OPTION_SPREAD_PCT,
    GEX_BUFFER, SIGNAL_MODE, MAX_TRADES_DAY,
    RSI_LONG_MAX, RSI_SHORT_MIN,
    DIRECTION_COOLDOWN, DIRECTION_COOLDOWN_MINS,
    MARKET_MODE_AUTO, MARKET_MODE_OVERRIDE,
    SIGNAL_SCAN_MINS, GEX_REFRESH_MINS, POST_TP1_COOLDOWN_MINS,
    REVERSAL_BLOCK, PATH_RESIST_BLOCK, WALL_HARD_BLOCK,
    MAGNET_DIRECTION_FILTER, MAGNET_RANGE, MAX_DIR_LOSSES_DAY, TREND_MIN_SCORE,
  };
}

function getRiskBudget() { return RISK_DOLLARS > 0 ? RISK_DOLLARS : ACCOUNT_SIZE * RISK_PER_TRADE; }
// RISK_DOLLARS is a stop-loss budget, not premium outlay. Size from the per-contract
// loss between the entry limit and the software stop; account/notional caps still apply.
function calcContracts(entryPrice, stopPrice) {
  const perContractRisk = (entryPrice - stopPrice) * 100;
  return !Number.isFinite(perContractRisk) || perContractRisk <= 0
    ? 0 : Math.floor(getRiskBudget() / perContractRisk);
}
/**
 * TP1 now represents the trailing stop TRIGGER price — the option premium level
 * at which the trailing stop activates. This replaces the old theoretical 3x/GEX-wall
 * target, which confirmed trades showed is rarely reachable intraday on 0DTE.
 * The trailing stop is the real exit; TP1 is its activation threshold.
 *
 * Priority:
 *   1. Dollar-amount mode (TRAIL_TRIGGER_DOLLARS > 0): trigger at entry + $N
 *   2. Percentage mode (TRAIL_TRIGGER_PCT): trigger at entry × (1 + PCT)
 */
function calcTP1(entry) {
  if (TRAIL_TRIGGER_DOLLARS > 0) return parseFloat((entry + TRAIL_TRIGGER_DOLLARS).toFixed(2));
  return parseFloat((entry * (1 + TRAIL_TRIGGER_PCT)).toFixed(2));
}

// ── State ─────────────────────────────────────────────────────────────────────
let sessionPnL      = 0;
let dailyLoss       = 0;
let signalHistory   = [];
let sseClients      = [];
let logHistory      = [];
// Raw console mirror — captures BOTH console.log and console.error (the SCHEDULER ERR /
// SSE INIT ERR lines that never go through log()/logHistory), so /logs shows what Railway's
// stdout shows without needing the Railway API. Bounded ring buffer.
const consoleBuffer = [];
const CONSOLE_BUFFER_MAX = 1500;
(function mirrorConsole(){
  for (const level of ["log","error","warn"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      try {
        const line = args.map(a => typeof a==="string" ? a : (()=>{try{return JSON.stringify(a);}catch{return String(a);}})()).join(" ");
        consoleBuffer.push({ t:new Date().toISOString(), level, line });
        if (consoleBuffer.length > CONSOLE_BUFFER_MAX) consoleBuffer.shift();
      } catch(_){}
      orig(...args);
    };
  }
})();
let gexCache        = null;
let gexCacheTime    = 0;
let gexFired        = new Set();
let gexLastDate     = "";
let orbState        = null;   // { high, low, built, date }
let lastBarTime     = null;   // last processed 5-min bar timestamp
let lastVwap        = null;   // most recent session VWAP (for classifier pin-floor guard)
let scanActive      = false;
let tradesDay       = 0;
const MAX_LOGS      = 500;
// Two independent, live-tunable cadences (minutes), both default 5. Signal scan drives
// entry evaluation (aligned to 5-min bars); GEX refresh drives FlashAlpha calls. Kept
// separate so quota headroom and entry precision don't trade off against each other.
// At 5-min GEX during RTH that's ~77 slots x 5 endpoints = ~385 FA calls/day (15% of the
// 2500/day quota) — slow GEX to 10/15 from Settings if you want more headroom.
let SIGNAL_SCAN_MINS = parseInt(process.env.SIGNAL_SCAN_MINS || "5");
let GEX_REFRESH_MINS = parseInt(process.env.GEX_REFRESH_MINS || "5");
// Post-TP1 cooldown: after a TP1 win, block new entries for this many minutes to avoid
// chasing an exhausted move. Default 5 — backtested on 7/17: the two losing re-entries
// came 3-4 min after a TP1 (chase), while a legit +$140 re-entry came 8 min after, so 5m
// blocks only the instant chase ($175->$325) while 10m+ starts eating winners. 0 disables.
let POST_TP1_COOLDOWN_MINS = parseInt(process.env.POST_TP1_COOLDOWN_MINS || "5");
// Reversal-risk entry block: refuse entries where GEX says the move will likely stall/reverse.
// path_resist = fraction of opposing (pinning) GEX between entry and target (1 = all opposing);
// wall hardness = target wall GEX vs profile mean (higher = sharper rejection expected). On
// 2026-07-21 a LONG with path_resist=1 + wall 7.1x HARD was taken, never went green, held
// overnight at a loss — every reversal signal fired but none gated. These make them gate.
let REVERSAL_BLOCK      = (process.env.REVERSAL_BLOCK || "ON").toUpperCase(); // ON | OFF
let PATH_RESIST_BLOCK   = parseFloat(process.env.PATH_RESIST_BLOCK || "0.85"); // block if >=
let WALL_HARD_BLOCK     = parseFloat(process.env.WALL_HARD_BLOCK   || "6");    // block if >=
// Magnet-direction filter (see applyGEX): don't trade away from the 0DTE magnet.
let MAGNET_DIRECTION_FILTER = (process.env.MAGNET_DIRECTION_FILTER || "ON").toUpperCase();
let MAGNET_RANGE        = parseFloat(process.env.MAGNET_RANGE || "2.5"); // magnet within $X pulls
// Daily per-direction loss circuit breaker: after N losses in a direction in one day, lock
// that direction until tomorrow. The 30-min cooldown resets and lets the bot bleed all day
// (2026-07-23: 7 short losses); this caps it. Rebuilt from today's trades on restart.
let MAX_DIR_LOSSES_DAY  = parseInt(process.env.MAX_DIR_LOSSES_DAY || "3");
// TREND requires score >= this (raised 2→3 on 2026-08-06 — see detectMarketMode). Higher =
// stricter = fewer days get the scalp profile, more fall back to NEUTRAL (run-to-TP1).
let TREND_MIN_SCORE     = parseInt(process.env.TREND_MIN_SCORE || "3");
let dirLossesToday      = { LONG:0, SHORT:0 };
let dirLockedToday      = { LONG:false, SHORT:false };
const snapTo5 = v => Math.max(5, Math.min(30, Math.round(v/5)*5)); // keep aligned to 5-min bars
let faLevelsCache   = null;
let faZeroDteCache  = null;
// Market mode classifier state
let MARKET_MODE      = "NEUTRAL"; // active classification: TREND | CHOP | NEUTRAL
let marketScore      = 0;         // last composite score
let marketModeDate   = "";        // date mode was set (reset each day)
let prevDayData      = null;      // { close, adr5, high, low } from prior session daily bars
let faSummaryCache  = null;
let faMaxPainCache  = null;
let faCacheTime     = 0;
// Daily EMA9/21 seeded from prior trading-day closes — always available from first intraday bar
let dailyEMA9  = null;
let dailyEMA21 = null;

// ── JSON File Database ────────────────────────────────────────────────────────
// Railway auto-injects RAILWAY_VOLUME_MOUNT_PATH at runtime once a volume is
// attached to the service (regardless of the mount path chosen in the dashboard).
// Falls back to /data (legacy assumption), then to __dirname (ephemeral — wiped
// on every redeploy) if no volume is attached at all.
const RAILWAY_VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH || null;
const DB_DIR  = RAILWAY_VOLUME || (fs.existsSync("/data") ? "/data" : __dirname);

// ── TradeEcho MCP request budget ─────────────────────────────────────────────
// The vendor limit is higher, but this bot deliberately stays within 20 requests
// per ET clock hour. Count every JSON-RPC request (including initialize/list and
// failures) before sending it, and persist the count so a restart cannot bypass it.
const TRADEECHO_QUOTA_FILE = path.join(DB_DIR, "tradeecho_quota.json");
let tradeEchoQuota = null;
let tradeEchoQuotaBlocked = false;
let tradeEchoSessionId = null;
let tradeEchoDealerTool = null;
let tradeEchoRpcId = 0;

function tradeEchoHourKey(){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",hourCycle:"h23"}).formatToParts(new Date());
  const p=Object.fromEntries(parts.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return p.year+"-"+p.month+"-"+p.day+"T"+p.hour;
}
function loadTradeEchoQuota(){
  if(tradeEchoQuota) return;
  try{ tradeEchoQuota=JSON.parse(fs.readFileSync(TRADEECHO_QUOTA_FILE,"utf8")); }catch(_){ tradeEchoQuota={hour:"",count:0}; }
}
function consumeTradeEchoRequest(){
  loadTradeEchoQuota();
  const hour=tradeEchoHourKey();
  if(tradeEchoQuota.hour!==hour) tradeEchoQuota={hour,count:0};
  if(tradeEchoQuota.count>=TRADEECHO_MAX_REQUESTS_HOUR){
    if(!tradeEchoQuotaBlocked) log("TRADEECHO","20-request/hour cap reached — GEX refresh paused until next ET hour");
    tradeEchoQuotaBlocked=true;
    return false;
  }
  tradeEchoQuota.count++;
  tradeEchoQuotaBlocked=false;
  try{ fs.writeFileSync(TRADEECHO_QUOTA_FILE,JSON.stringify(tradeEchoQuota)); }
  catch(e){ log("TRADEECHO ERR","Could not persist request quota: "+e.message); return false; }
  return true;
}

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
      squeeze_on:     indicators.squeeze?.on??null,
      squeeze_bars:   indicators.squeeze?.barsOn??null,
      squeeze_fired:  indicators.squeeze?.fired??null,
      squeeze_dir:    indicators.squeeze?.direction||null,
      flag_pattern:   indicators.flag||null,
      gex_path_resist: gexCache?.profile ? pathResistance(sig.direction, sig.spyEntry) : null,
      gex_regime:     gexCache?.regime||null,
      gex_flip:       gexCache?.gammaFlip||null,
      nearest_wall:   sig.gexTarget||null,
      // ── Unified reversal-risk feature vector (LOG-ONLY; scored by /db/blocked-analysis
      //    segmented by GEX regime). Captures the candidates raised for reversal mitigation:
      //    Bollinger extension, VWAP extension, and the DEX/VEX/CHEX exposures we weren't
      //    logging per-signal. None gates a trade until the data proves it on the right regime.
      percent_b:      indicators.squeeze?.percentB ?? null,
      bb_upper:       indicators.squeeze?.bbUpper ?? null,
      bb_lower:       indicators.squeeze?.bbLower ?? null,
      vwap_dist:      (indicators.vwap!=null && sig.spyEntry!=null) ? parseFloat((sig.spyEntry-indicators.vwap).toFixed(2)) : null,
      net_gex:        gexCache?.netGex ?? null,
      dex:            gexCache?.dex ?? null,
      vex:            gexCache?.vex ?? null,
      chex:           gexCache?.chex ?? null,
      dex_pct:        gexCache?.dexPctRank ?? null,
      vex_pct:        gexCache?.vexPctRank ?? null,
      chex_pct:       gexCache?.chexPctRank ?? null,
      signal_strength:sig.strength||null,
      signal_mode:    SIGNAL_MODE,
      market_mode:    MARKET_MODE,
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
      bot:            "SPX-COMMAND",
      source:         "bot",
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
      tp1_armed:      trade.tp1Armed ? 1 : 0,
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
      // entry-time context (frozen at fill in executeTrade) — NOT the live close-time cache
      gex_regime:     trade.gexRegimeAtEntry ?? null,
      gex_flip:       trade.gexFlipAtEntry ?? null,
      net_gex_entry:  trade.netGexAtEntry ?? null,
      dex_entry:      trade.dexAtEntry ?? null,
      vex_entry:      trade.vexAtEntry ?? null,
      chex_entry:     trade.chexAtEntry ?? null,
      magnet_entry:   trade.magnetAtEntry ?? null,
      orb_high:       indicators?.orbHigh||null,
      orb_low:        indicators?.orbLow||null,
      vwap_at_entry:  indicators?.vwap||null,
      rsi_at_entry:   indicators?.rsi||null,
      squeeze_at_entry: indicators?.squeeze ? {on:indicators.squeeze.on, fired:indicators.squeeze.fired, dir:indicators.squeeze.direction} : null,
      flag_at_entry:  indicators?.flag||null,
      gex_path_resist: trade.gexPathResist??null,
      ema9_at_entry:  indicators?.ema9||null,
      ema21_at_entry: indicators?.ema21||null,
      tp1_mode:       TRAIL_TRIGGER_DOLLARS>0?"trail-trigger-$"+TRAIL_TRIGGER_DOLLARS:"trail-trigger-"+(TRAIL_TRIGGER_PCT*100)+"%",
      risk_budget:    getRiskBudget(),
      signal_mode:    SIGNAL_MODE,
      market_mode:    MARKET_MODE,
      mode_at_fill:   trade.modeAtFill||null,
      // Shadow trail counterfactuals — what each virtual config WOULD have exited at.
      // Unexited shadows finalize at the real close price (they rode to the actual exit).
      shadow_exits:   (trade.shadows||[]).map(sh=>({
        name: sh.name,
        exit_price: sh.exited ? sh.exitPrice : (trade.closePrice||null),
        exited_early: sh.exited,
        pnl: (sh.exited?sh.exitPrice:trade.closePrice)!=null && trade.fillPrice!=null
          ? parseFloat((((sh.exited?sh.exitPrice:trade.closePrice)-trade.fillPrice)*100*(trade.contracts||0)).toFixed(2)) : null,
      })),
    });
  } catch(e) { log("DB ERR","saveTradeToDB: "+e.message); return null; }
}

// Computes percentile rank of currentValue within the historical series (0-100).
// pctRank=75 means currentValue is higher than 75% of past readings — i.e., elevated.
function pctRank(series, currentValue) {
  if (!series || series.length < 5) return null; // need at least 5 data points
  const below = series.filter(v => v < currentValue).length;
  return Math.round((below / series.length) * 100);
}

// Enriches a GEX result object with rolling percentile ranks for VEX, DEX, and CHEX.
// Uses last 5 trading days of snapshots (~45 records at 9 fetches/day).
// Percentile interpretation:
//   VEX p80+ = vol buyers active → large move expected → TREND signal
//   VEX p20- = vol suppressed → pinning → CHOP signal
//   DEX p80+ = MMs very net long → strong selling hedging pressure
//   CHEX p80+ = strong charm decay selling into close (after 1PM, skip LONGs)
function enrichWithPercentiles(result) {
  try {
    const snapshots = loadDB("gex_snapshots").slice(-45); // ~5 trading days
    const vexSeries  = snapshots.filter(s => s.vex  != null).map(s => s.vex);
    const dexSeries  = snapshots.filter(s => s.dex  != null).map(s => s.dex);
    const chexSeries = snapshots.filter(s => s.chex != null).map(s => s.chex);

    result.vexPctRank  = result.vex  != null ? pctRank(vexSeries,  result.vex)  : null;
    result.dexPctRank  = result.dex  != null ? pctRank(dexSeries,  result.dex)  : null;
    result.chexPctRank = result.chex != null ? pctRank(chexSeries, result.chex) : null;

    // Descriptive labels for dashboard/logs
    const label = pct => pct == null ? "—" : pct >= 80 ? "HIGH" : pct >= 60 ? "ELEVATED" : pct <= 20 ? "LOW" : "NORMAL";
    result.vexLabel  = label(result.vexPctRank);
    result.dexLabel  = label(result.dexPctRank);
    result.chexLabel = label(result.chexPctRank);
  } catch(e) { log("GEX ERR", "enrichWithPercentiles: " + e.message); }
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
    const start  = today+"T09:30:00"+etOffset(today);
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
    // Midpoint, not ask-first: ap||bp biased the underlying up on every scan (helped LONG
    // confirmations, hurt SHORT). Use (bid+ask)/2 when both sides quote; fall back otherwise.
    const bid=parseFloat(q.bp||0), ask=parseFloat(q.ap||0);
    const p = (bid>0&&ask>0) ? (bid+ask)/2 : (ask||bid||0);
    return p>0?p:null;
  } catch(_) { return null; }
}

/**
 * Fetch prior trading-day daily bars and seed EMA9/EMA21 from historical closes.
 * This makes EMA21 available from the very first intraday bar instead of needing
 * 105 minutes of 5-min data to accumulate. The bot calculates EMA from intraday
 * bars; without this seed the first ~100 minutes of each session have null EMA21.
 */
// Shared SPY daily-bar fetch. The bug both callers hit: WITHOUT a `start` date the Alpaca
// IEX bars API returns a near-empty window (0-1 bars) — that's why EMA seed said "0/21" and
// fetchPrevDayData said "not enough bars" for weeks. An explicit start/end date range fixes
// it. end=yesterday to only pull COMPLETED sessions and dodge any free-tier recency limit.
async function fetchSpyDailyBars(calendarDays=60) {
  const today = new Date();
  const end   = new Date(today.getTime() - 1*86400000);
  const start = new Date(today.getTime() - calendarDays*86400000);
  const url = ALPACA_DATA+"/v2/stocks/SPY/bars?timeframe=1Day"
            + "&start="+start.toISOString().slice(0,10)
            + "&end="+end.toISOString().slice(0,10)
            + "&feed=iex&adjustment=raw&limit=100";
  const r = await fetch(url,{headers:aH()});
  if(!r.ok){ const t=await r.text(); throw new Error("daily bars "+r.status+": "+t.slice(0,120)); }
  const data = await r.json();
  return (data.bars||[]).sort((a,b)=>new Date(a.t)-new Date(b.t));
}

async function fetchDailyEMAs() {
  try {
    const allBars = await fetchSpyDailyBars(60);
    // Exclude today's bar (incomplete intraday)
    const etToday = new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
    const hist = allBars.filter(b=>b.t.slice(0,10)<etToday);
    if (hist.length<21) { log("DATA","Not enough daily bars for EMA seed ("+hist.length+"/21)"); return; }
    const closes = hist.map(b=>b.c);
    dailyEMA9  = calcEMA(closes, 9);
    dailyEMA21 = calcEMA(closes, 21);
    log("DATA","Daily EMA seed — EMA9:"+dailyEMA9+" EMA21:"+dailyEMA21+" (from "+hist.length+" prior closes)");
  } catch(e) { log("DATA ERR","fetchDailyEMAs: "+e.message); }
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
 * TTM Squeeze — Bollinger Bands (20, 2σ) inside Keltner Channels (20, 1.5×ATR).
 * Pure arithmetic, zero subjective parameters. squeezeState is module-global so
 * fired-transitions are detected across scan ticks and the classifier can read it.
 * Returns { on, barsOn, fired, direction, momentum } or null if <21 bars.
 */
let squeezeState = { on:false, barsOn:0, fired:false, firedAt:0, direction:null, momentum:null, date:"" };
function calcSqueeze(bars) {
  const P = 20;
  if (bars.length < P+1) return null;
  const today = new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
  if (squeezeState.date !== today) squeezeState = { on:false, barsOn:0, fired:false, firedAt:0, direction:null, momentum:null, date:today };

  const w      = bars.slice(-P);
  const closes = w.map(b=>b.c);
  const sma    = closes.reduce((a,b)=>a+b,0)/P;
  const sd     = Math.sqrt(closes.reduce((a,c)=>a+(c-sma)**2,0)/P);
  // ATR over the window (true range vs prior close)
  let atr=0;
  for (let i=0;i<w.length;i++){
    const pc = i>0 ? w[i-1].c : w[0].o ?? w[0].c;
    atr += Math.max(w[i].h-w[i].l, Math.abs(w[i].h-pc), Math.abs(w[i].l-pc));
  }
  atr/=P;

  const bbU=sma+2*sd, bbL=sma-2*sd, kcU=sma+1.5*atr, kcL=sma-1.5*atr;
  const on = bbU < kcU && bbL > kcL;

  // TTM momentum: close vs midpoint of (Donchian mid + SMA)
  const hh=Math.max(...w.map(b=>b.h)), ll=Math.min(...w.map(b=>b.l));
  const momentum = parseFloat((closes[P-1] - ((hh+ll)/2 + sma)/2).toFixed(4));

  const wasOn = squeezeState.on;
  const fired = wasOn && !on; // squeeze released this bar
  squeezeState.on     = on;
  squeezeState.barsOn = on ? squeezeState.barsOn+1 : 0;
  if (fired) { squeezeState.fired=true; squeezeState.firedAt=Date.now(); }
  // fired flag stays true for 3 bars (~15 min) then decays
  if (squeezeState.fired && Date.now()-squeezeState.firedAt > 15*60000) squeezeState.fired=false;
  squeezeState.direction = momentum>0 ? "LONG" : momentum<0 ? "SHORT" : null;
  squeezeState.momentum  = momentum;
  if (fired) log("SQUEEZE","Fired "+squeezeState.direction+" — momentum "+momentum+" after "+(squeezeState.barsOn||"?")+" bars of compression");
  // %B = position within the Bollinger Bands: >1 above upper (extended long), <0 below
  // lower (extended short). Volatility-normalized extension — a reversal-risk candidate.
  const lastPx = closes[P-1];
  const percentB = bbU>bbL ? parseFloat(((lastPx-bbL)/(bbU-bbL)).toFixed(3)) : null;
  return { on, barsOn:squeezeState.barsOn, fired:squeezeState.fired, direction:squeezeState.direction, momentum,
           bbUpper:parseFloat(bbU.toFixed(2)), bbLower:parseFloat(bbL.toFixed(2)), percentB };
}

/**
 * Bull/bear flag detector — LOG-ONLY pilot (never gates a trade).
 * Impulse: any 4-bar window in the last 12 bars moving >= 0.25%.
 * Consolidation: 3-8 bars after impulse, avg range < 50% of impulse bar range,
 * retracing <= 40% of the impulse. Breakout: latest close beyond consolidation
 * extreme in the impulse direction.
 * Returns "BULL_FLAG" | "BEAR_FLAG" | null. Journal accumulates outcomes for
 * 2-3 weeks before this is allowed to become a real (CHOP-mode) filter.
 */
function detectFlag(bars) {
  if (bars.length < 10) return null;
  const recent = bars.slice(-16);
  for (let s=0; s<=recent.length-8; s++) {
    const imp = recent.slice(s, s+4);
    const impMove = imp[3].c - imp[0].o;
    const impPct  = Math.abs(impMove)/imp[0].o;
    if (impPct < 0.0025) continue;
    const dir = impMove>0 ? 1 : -1;
    const impRange = imp.reduce((a,b)=>a+(b.h-b.l),0)/4;
    const cons = recent.slice(s+4);
    if (cons.length < 3 || cons.length > 8) continue;
    const consRange = cons.reduce((a,b)=>a+(b.h-b.l),0)/cons.length;
    if (consRange >= impRange*0.5) continue;                       // not tightening
    const retrace = dir>0 ? imp[3].c - Math.min(...cons.map(b=>b.l))
                          : Math.max(...cons.map(b=>b.h)) - imp[3].c;
    if (retrace > Math.abs(impMove)*0.4) continue;                 // gave back too much
    const last = recent[recent.length-1];
    const consHigh = Math.max(...cons.slice(0,-1).map(b=>b.h));
    const consLow  = Math.min(...cons.slice(0,-1).map(b=>b.l));
    if (dir>0 && last.c > consHigh) return "BULL_FLAG";
    if (dir<0 && last.c < consLow)  return "BEAR_FLAG";
  }
  return null;
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
  const orbEnd = new Date(today+"T09:30:00"+etOffset(today));
  orbEnd.setMinutes(orbEnd.getMinutes()+ORB_MINUTES);

  const orbBars = bars.filter(b=>{
    const bt = new Date(b.t);
    return bt >= new Date(today+"T09:30:00"+etOffset(today)) && bt < orbEnd;
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

  // Fall back to daily-seeded EMAs when intraday bars are insufficient.
  // dailyEMA9/21 are fetched from prior closes at startup, making trend
  // confirmation available from the first 5-min bar instead of waiting 105 min.
  const ema9Final  = ema9  ?? dailyEMA9;
  const ema21Final = ema21 ?? dailyEMA21;
  const squeeze = calcSqueeze(bars);   // logged context + classifier input
  const flag    = detectFlag(bars);    // LOG-ONLY pilot — never gates entries
  if (vwap != null) lastVwap = vwap;   // expose latest VWAP for classifier pin-floor
  return { price, orbHigh:orb?.high||null, orbLow:orb?.low||null,
    vwap, rsi, ema9:ema9Final, ema21:ema21Final, orbBreak, squeeze, flag };
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

  // RSI — thresholds from env vars; auto-adjusted by market mode when MARKET_MODE_AUTO=ON
  const mp = MARKET_MODE_AUTO==="ON" ? getModeParams() : null;
  const rsiLongMax  = mp ? mp.rsiLongMax  : RSI_LONG_MAX;
  const rsiShortMin = mp ? mp.rsiShortMin : RSI_SHORT_MIN;
  const rsiOk = isLong ? ind.rsi < rsiLongMax && ind.rsi > 40 : ind.rsi > rsiShortMin && ind.rsi < 60;
  if (rsiOk) passed.push("RSI "+ind.rsi+" [mode:"+MARKET_MODE+"]");
  else failed.push("RSI "+ind.rsi+" ("+(isLong?"overbought >"+rsiLongMax+" or weak <40":"oversold <"+rsiShortMin+" or weak >60")+") [mode:"+MARKET_MODE+"]");

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

// FlashAlpha usage tracking + quota circuit breaker. The Growth plan is 2500 requests/day.
// Once "Quota exceeded" is seen, STOP calling FA until the reset time — retrying a quota
// error just burns more of the (already-exhausted) budget. Counter resets each ET day.
let faCallsToday   = 0;
let faCallsDate    = "";
let faQuotaBlocked = false;
let faQuotaResetAt = 0;   // epoch ms; 0 = unknown → default next UTC midnight
function faDayRollover(){
  const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
  if(faCallsDate!==today){ faCallsDate=today; faCallsToday=0; faQuotaBlocked=false; faQuotaResetAt=0; }
}

async function faGet(endpoint, attempt=1) {
  if (!FLASHALPHA_KEY) return null;
  faDayRollover();
  // Quota circuit breaker — skip the call entirely while blocked
  if (faQuotaBlocked) {
    if (Date.now() >= faQuotaResetAt && faQuotaResetAt>0) { faQuotaBlocked=false; log("FA","Quota window elapsed — resuming FlashAlpha calls"); }
    else return null;
  }
  const url = FLASHALPHA_BASE + endpoint;
  const MAX_ATTEMPTS = 2;
  try {
    faCallsToday++;
    const r = await fetch(url, {
      headers: { "X-Api-Key": FLASHALPHA_KEY, "Accept": "application/json" },
      signal: AbortSignal.timeout(20000),  // generous — FA slows near the close; only guard against a true hang
    });
    if (!r.ok) {
      const txt = await r.text();
      // 429 QUOTA EXCEEDED — do NOT retry (wastes more budget). Trip the circuit breaker.
      if (r.status === 429) {
        // Distinguish a genuine DAILY-QUOTA 429 (suspend until reset) from a transient
        // rate/burst 429 (skip this one call, next refresh retries). Misclassifying the
        // latter as the former suspended FA for a WHOLE DAY on 2026-07-20 despite only
        // 144/2500 used — the daily-quota body says "daily"; a rate-limit body does not.
        const isDailyQuota = /daily/i.test(txt);
        if (isDailyQuota) {
          faQuotaBlocked = true;
          const m = txt.match(/resets at\s+([0-9T:\-\.Z+]+)/i);
          const parsed = m ? Date.parse(m[1]) : NaN;
          faQuotaResetAt = !isNaN(parsed) ? parsed : new Date(new Date().setUTCHours(24,0,0,0)).getTime();
          log("FA ERR", "DAILY QUOTA exhausted — FA suspended until "+new Date(faQuotaResetAt).toISOString());
          return null;
        }
        log("FA ERR", "rate-limited (429) on "+endpoint+" — skipping this call only, retry next refresh");
        return null;
      }
      // Retry only genuine transient server errors (5xx); other 4xx won't fix on retry
      if (r.status >= 500 && attempt < MAX_ATTEMPTS) {
        log("FA ERR", "GET " + endpoint + " " + r.status + " — retrying");
        await new Promise(res => setTimeout(res, 600));
        return faGet(endpoint, attempt+1);
      }
      log("FA ERR", "GET " + endpoint + " " + r.status + ": " + txt.slice(0, 200));
      return null;
    }
    return r.json();
  } catch (e) {
    // Network/timeout — retry once before giving up
    if (attempt < MAX_ATTEMPTS) {
      log("FA ERR", "GET " + endpoint + " " + e.message + " — retrying");
      await new Promise(res => setTimeout(res, 600));
      return faGet(endpoint, attempt+1);
    }
    log("FA ERR", "GET " + endpoint + " failed after "+attempt+" attempts: " + e.message);
    return null;
  }
}

// ── TradeEcho MCP-powered Dealer Edge / GEX ───────────────────────────────────
async function tradeEchoRpc(method, params={}){
  if(!TRADEECHO_PAT){ log("TRADEECHO","No TRADEECHO_PAT — GEX disabled"); return null; }
  if(!consumeTradeEchoRequest()) return null;
  try{
    const headers={"Authorization":"Bearer "+TRADEECHO_PAT,"Content-Type":"application/json","Accept":"application/json, text/event-stream"};
    if(tradeEchoSessionId) headers["Mcp-Session-Id"]=tradeEchoSessionId;
    const r=await fetch(TRADEECHO_MCP,{method:"POST",headers,body:JSON.stringify({jsonrpc:"2.0",id:++tradeEchoRpcId,method,params}),signal:AbortSignal.timeout(15000)});
    const sid=r.headers.get("mcp-session-id"); if(sid) tradeEchoSessionId=sid;
    const body=await r.json();
    if(!r.ok||body.error){ log("TRADEECHO ERR",method+": "+(body.error?.message||("HTTP "+r.status))); return null; }
    return body.result||null;
  }catch(e){ log("TRADEECHO ERR",method+": "+e.message); return null; }
}
function tradeEchoValue(value){
  if(value==null) return null;
  if(typeof value==="string"){ try{return JSON.parse(value);}catch(_){return value;} }
  if(Array.isArray(value)) return value.map(tradeEchoValue);
  if(typeof value==="object"){
    if(Array.isArray(value.content)){
      const text=value.content.find(x=>x.type==="text")?.text;
      if(text) return tradeEchoValue(text);
    }
    return value;
  }
  return value;
}
function tradeEchoPick(obj, names){
  if(!obj||typeof obj!=="object") return null;
  const wanted=new Set(names.map(x=>x.toLowerCase().replace(/[^a-z0-9]/g,"")));
  const stack=[obj];
  while(stack.length){
    const cur=stack.pop();
    for(const [key,val] of Object.entries(cur)){
      if(wanted.has(key.toLowerCase().replace(/[^a-z0-9]/g,""))) return val;
      if(val&&typeof val==="object") stack.push(val);
    }
  }
  return null;
}
function tradeEchoNumber(v){ const n=parseFloat(v); return Number.isFinite(n)?n:null; }
function normalizeTradeEchoDealerEdge(payload){
  const raw=tradeEchoValue(payload);
  if(!raw||typeof raw!=="object") return null;
  const spot=tradeEchoNumber(tradeEchoPick(raw,["spot_price","spot","underlying_price","price"]));
  const gammaFlip=tradeEchoNumber(tradeEchoPick(raw,["gamma_flip","gammaFlip","flip"]));
  const netGex=tradeEchoNumber(tradeEchoPick(raw,["net_gex","netGamma","net_gamma"]));
  const callWall=tradeEchoNumber(tradeEchoPick(raw,["call_wall","callWall"]));
  const putWall=tradeEchoNumber(tradeEchoPick(raw,["put_wall","putWall"]));
  const magnet=tradeEchoNumber(tradeEchoPick(raw,["zero_dte_magnet","zeroDteMagnet","magnet","max_pain"]));
  const pinRisk=tradeEchoNumber(tradeEchoPick(raw,["pin_risk_score","pinRisk","pin_risk"]));
  const strikes=tradeEchoPick(raw,["strikes","strike_data","levels"]);
  const rows=Array.isArray(strikes)?strikes:[];
  const profile=rows.map(s=>{
    const strike=tradeEchoNumber(s.strike??s.price);
    const call=tradeEchoNumber(s.call_gex??s.callGex)??0, put=tradeEchoNumber(s.put_gex??s.putGex)??0;
    return strike==null?null:{strike,netGex:tradeEchoNumber(s.net_gex??s.netGex)??call+put,callGex:call,putGex:put};
  }).filter(Boolean).sort((a,b)=>a.strike-b.strike);
  const callWalls=profile.filter(x=>x.callGex>0&&(!spot||x.strike>spot)).sort((a,b)=>b.callGex-a.callGex).slice(0,5).map(x=>({price:x.strike,gex:Math.round(x.callGex)}));
  const putWalls=profile.filter(x=>x.putGex<0&&(!spot||x.strike<spot)).sort((a,b)=>a.putGex-b.putGex).slice(0,5).map(x=>({price:x.strike,gex:Math.round(Math.abs(x.putGex))}));
  if(!spot||gammaFlip==null||!callWall||!putWall) return null;
  return {spotPrice:spot,gammaFlip,netGex:netGex??0,regime:(netGex??0)>=0?"positive":"negative",callWall,putWall,
    callWalls:callWalls.length?callWalls:[{price:callWall,gex:0}],putWalls:putWalls.length?putWalls:[{price:putWall,gex:0}],
    profile,zeroDteMagnet:magnet,maxPain:magnet,pinRisk,source:"TradeEcho MCP",hasRealGreeks:false,updatedAt:new Date().toISOString()};
}
async function calcTradeEchoGEX(){
  if(!tradeEchoSessionId){
    const init=await tradeEchoRpc("initialize",{protocolVersion:"2024-11-05",capabilities:{},clientInfo:{name:"spx-command",version:APP_VERSION}});
    if(!init) return null;
    await tradeEchoRpc("notifications/initialized",{});
  }
  if(!tradeEchoDealerTool){
    const list=await tradeEchoRpc("tools/list",{});
    tradeEchoDealerTool=list?.tools?.find(t=>t.name==="get_dealer_edge_data");
    if(!tradeEchoDealerTool){ log("TRADEECHO ERR","get_dealer_edge_data is unavailable — confirm Dealer Edge scope on the PAT"); return null; }
  }
  const props=tradeEchoDealerTool.inputSchema?.properties||{};
  const args={};
  for(const key of Object.keys(props)){
    const k=key.toLowerCase();
    if(["symbol","ticker","underlying","root"].includes(k)) args[key]="SPY";
    else if(["date","as_of_date","trade_date"].includes(k)) args[key]=etDateString();
  }
  const result=await tradeEchoRpc("tools/call",{name:"get_dealer_edge_data",arguments:args});
  const normalized=normalizeTradeEchoDealerEdge(result);
  if(!normalized){ log("TRADEECHO ERR","Dealer Edge response lacked required SPY GEX levels"); return null; }
  enrichWithPercentiles(normalized);
  log("GEX","TradeEcho — Flip:$"+normalized.gammaFlip+" | CallWall:$"+normalized.callWall+" | PutWall:$"+normalized.putWall+" | Net:"+(normalized.netGex/1e9).toFixed(2)+"B");
  broadcast({type:"gex_update",...normalized}); saveGEXSnapshot(normalized); return normalized;
}

// Legacy FlashAlpha implementation is retained only for historical journal compatibility.
// Production GEX retrieval routes exclusively through calcTradeEchoGEX().
async function calcGEX() {
  if (!FLASHALPHA_KEY) {
    log("GEX", "No FLASHALPHA_API_KEY — GEX disabled");
    return null;
  }
  try {
    log("GEX", "Fetching from FlashAlpha API...");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

    // Fetch SEQUENTIALLY, not Promise.all — 5 concurrent requests was a burst that tripped
    // FlashAlpha's per-second rate limit (→ the 429 that suspended us on 2026-07-20). At a
    // 5-15 min cadence the extra ~1s of sequential latency is irrelevant. maxpain dropped:
    // it returned "$—" on every call and threw 502s — a wasted request feeding nothing.
    const gexData     = await faGet("/v1/exposure/gex/SPY?expiration=" + today);
    const levelsData  = await faGet("/v1/exposure/levels/SPY");
    const zeroDteData = await faGet("/v1/exposure/zero-dte/SPY");
    const summaryData = await faGet("/v1/exposure/summary/SPY");
    const maxPainData = null; // endpoint never returned usable data; magnet falls back to zeroDteMagnet

    if (!gexData) { log("GEX ERR", "FlashAlpha GEX endpoint returned no data"); broadcastHealth(); return null; }

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

    // Per-strike GEX profile (spot ±$10) — the SHAPE of the curve, not just wall peaks.
    // Used for path resistance (opposing GEX between entry and target) and wall
    // hardness (concentrated spike vs distributed ledge).
    const profile = strikes
      .filter(s => Math.abs(s.strike - spot) <= 10)
      .map(s => ({ strike: s.strike, netGex: (s.call_gex||0)+(s.put_gex||0), callGex: s.call_gex||0, putGex: s.put_gex||0 }))
      .sort((a,b) => a.strike - b.strike);

    // Extract key levels
    const levels = levelsData?.levels || {};
    const zeroDte = zeroDteData || {};
    const maxPain = maxPainData?.max_pain || null;

    const result = {
      callWalls, putWalls, profile,
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

    // Compute rolling percentile ranks from historical snapshots before broadcasting
    enrichWithPercentiles(result);

    log("GEX", "FlashAlpha -- DEX:" + ((result.dex||0)/1e9).toFixed(1) + "B p" + (result.dexPctRank??'—') +
      " | VEX:" + ((result.vex||0)/1e9).toFixed(1) + "B p" + (result.vexPctRank??'—') +
      " | CHEX:" + ((result.chex||0)/1e6).toFixed(1) + "M p" + (result.chexPctRank??'—'));

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
  const r = await calcTradeEchoGEX();
  if (r) {
    gexCache = r; gexCacheTime = now;
    // Re-classify on every fresh GEX — a midday net-GEX sign flip (positive pin → negative
    // trend) is a major regime change the old twice-a-day (ORB + 11:00) schedule missed
    // entirely. Only once the session is underway (ORB built) to avoid pre-open noise.
    if (orbState?.built) detectMarketMode();
  }
  return gexCache;
}

/**
 * Path resistance — fraction [0..1] of nearby absolute GEX that opposes a move
 * from entry toward the target side. Positive net GEX at a strike = dealers fade
 * moves through it (resistance); negative = dealers amplify (fuel).
 * High value (>0.6) = price must chew through a wall of pinning gamma; low = clear air.
 */
function pathResistance(direction, entry) {
  const prof = gexCache?.profile;
  if (!prof || !prof.length) return null;
  const ahead = prof.filter(p => direction==="LONG" ? p.strike > entry : p.strike < entry);
  if (!ahead.length) return null;
  const totalAbs = ahead.reduce((a,p)=>a+Math.abs(p.netGex),0);
  if (!totalAbs) return null;
  const opposing = ahead.reduce((a,p)=>a+(p.netGex>0?p.netGex:0),0); // positive GEX = pinning = resistance
  return parseFloat((opposing/totalAbs).toFixed(2));
}

/**
 * Wall hardness — is the target wall a concentrated spike (hard: expect sharp
 * rejection, tighten at it) or a distributed ledge (soft: price may grind through)?
 * Returns ratio of wall strike |GEX| to mean |GEX| of the rest of the profile.
 */
function wallHardness(wallPrice) {
  const prof = gexCache?.profile;
  if (!prof || prof.length < 3 || wallPrice==null) return null;
  const wall = prof.find(p => Math.abs(p.strike-wallPrice) < 0.51);
  if (!wall) return null;
  const rest = prof.filter(p => p !== wall);
  const meanAbs = rest.reduce((a,p)=>a+Math.abs(p.netGex),0)/rest.length;
  return meanAbs ? parseFloat((Math.abs(wall.netGex)/meanAbs).toFixed(1)) : null;
}

// Returns a block reason string if this entry is a high reversal-risk setup, else null.
function reversalBlock(direction, pathResist, hardness){
  if (REVERSAL_BLOCK !== "ON") return null;
  if (pathResist != null && pathResist >= PATH_RESIST_BLOCK)
    return direction+" blocked — reversal risk: path resist "+pathResist+" (>= "+PATH_RESIST_BLOCK+", pinning gamma ahead)";
  if (hardness != null && hardness >= WALL_HARD_BLOCK)
    return direction+" blocked — reversal risk: wall "+hardness+"x HARD (>= "+WALL_HARD_BLOCK+"x, sharp rejection likely)";
  return null;
}

function applyGEX(direction, entry, vwap) {
  // Fail-CLOSED when GEX is unavailable: without the flip/wall map we can't tell a
  // pin from a clean breakout, and pins are where directional entries die. Allow the
  // trade only when we at least have a fresh flip to check; otherwise block.
  if (!gexCache) return { allowed: false, reason: "No GEX cache — blocking directional entry (fail-closed, cannot verify flip/pin)", tp1: entry, tp2: entry, target: null, dexBias: "NEUTRAL" };

  const gc = gexCache;

  // ── Pin risk block ────────────────────────────────────────────────────────────
  if (gc.pinRisk != null && gc.pinRisk > 70) {
    return { allowed: false, reason: "Pin risk " + gc.pinRisk + "/100 — price likely pinned", tp1: entry, tp2: entry, target: null, dexBias: "NEUTRAL" };
  }

  // ── Gamma flip proximity / VWAP-on-flip pin block ─────────────────────────────
  // At the flip, MMs hedge both directions simultaneously — most unpredictable zone.
  // Instantaneous price lies: a breakout tick pokes >$0.50 past the flip, passes this
  // check, then snaps back onto the flip and whipsaws (cost 2 stop-outs on 2026-07-13).
  // VWAP-on-flip is the honest pin signal — it means the whole session is centered on
  // the flip. Block on EITHER instantaneous price OR VWAP being within the buffer.
  if (gc.gammaFlip != null) {
    const flipDist = Math.abs(entry - gc.gammaFlip);
    if (flipDist < 0.50) {
      return { allowed: false, reason: "SPY $" + entry.toFixed(2) + " within $0.50 of gamma flip $" + gc.gammaFlip + " — regime indeterminate", tp1: entry, tp2: entry, target: null, dexBias: "NEUTRAL" };
    }
    if (vwap != null && Math.abs(vwap - gc.gammaFlip) < GEX_BUFFER) {
      return { allowed: false, reason: "VWAP $" + vwap.toFixed(2) + " pinned to gamma flip $" + gc.gammaFlip + " ($" + Math.abs(vwap - gc.gammaFlip).toFixed(2) + " < $" + GEX_BUFFER + ") — session centered on flip, chop", tp1: entry, tp2: entry, target: null, dexBias: "NEUTRAL" };
    }
  }

  // ── DEX — context log and conviction bias, NOT a hard direction block ─────────
  // Positive DEX = MMs net long delta → hedge by selling → bearish pressure (headwind for LONG)
  // Negative DEX = MMs net short delta → hedge by buying → bullish pressure (tailwind for LONG)
  // This is counterintuitive: high positive DEX ≠ bullish. MMs must sell into rising price.
  let dexBias = "NEUTRAL";
  let dexNote = "";
  if (gc.dex != null && Math.abs(gc.dex) > 1e10) { // only log when >$10B (signal, not noise)
    const dexBullishMM = gc.dex > 0; // MMs net long → must sell to hedge → bearish pressure on SPY
    // ALIGNED: DEX hedging flows in same direction as our trade (tailwinds)
    // OPPOSED: DEX hedging works against our trade (headwinds)
    const aligned = (direction === "LONG" && !dexBullishMM) || (direction === "SHORT" && dexBullishMM);
    dexBias = aligned ? "ALIGNED" : "OPPOSED";
    const mmAction = dexBullishMM ? "selling (headwind LONG)" : "buying (tailwind LONG)";
    dexNote = " | DEX " + (gc.dex > 0 ? "+" : "") + (gc.dex / 1e9).toFixed(1) + "B → MMs " + mmAction + " [" + dexBias + "]";
  } else if (gc.dex != null) {
    dexNote = " | DEX " + (gc.dex / 1e9).toFixed(1) + "B (neutral)";
  }

  // ── 0DTE magnet entry proximity block ────────────────────────────────────────
  // Don't enter when price is already at the magnet — no room to reach TP
  const magnet = gc.zeroDteMagnet || gc.maxPain || null;
  const MIN_MAGNET_ROOM = 0.25;
  if (magnet != null) {
    if (direction === "LONG" && magnet > entry && (magnet - entry) < MIN_MAGNET_ROOM) {
      return { allowed: false, reason: "LONG blocked — already at 0DTE magnet $" + magnet + " ($" + (magnet - entry).toFixed(2) + " room < $0.25)", tp1: magnet, tp2: magnet, target: magnet, dexBias };
    }
    if (direction === "SHORT" && magnet < entry && (entry - magnet) < MIN_MAGNET_ROOM) {
      return { allowed: false, reason: "SHORT blocked — already at 0DTE magnet $" + magnet + " ($" + (entry - magnet).toFixed(2) + " room < $0.25)", tp1: magnet, tp2: magnet, target: magnet, dexBias };
    }
    // ── Magnet-DIRECTION filter ──────────────────────────────────────────────
    // The 0DTE magnet pulls price toward it. Trading AWAY from it — SHORT below the magnet
    // or LONG above it — fights that pull. On 2026-07-23 the bot shorted below the $740
    // magnet 8x and price reverted up to it every time (1W/7L). Block entries against the
    // magnet when it's close enough to actively pull (within MAGNET_RANGE).
    if (MAGNET_DIRECTION_FILTER === "ON") {
      const dist = magnet - entry; // + = magnet is above entry
      if (direction === "SHORT" && dist > MIN_MAGNET_ROOM && dist <= MAGNET_RANGE)
        return { allowed: false, reason: "SHORT blocked — 0DTE magnet $" + magnet + " is $" + dist.toFixed(2) + " ABOVE entry (pulls price up, against short)", tp1: entry, tp2: entry, target: null, dexBias };
      if (direction === "LONG" && dist < -MIN_MAGNET_ROOM && -dist <= MAGNET_RANGE)
        return { allowed: false, reason: "LONG blocked — 0DTE magnet $" + magnet + " is $" + (-dist).toFixed(2) + " BELOW entry (pulls price down, against long)", tp1: entry, tp2: entry, target: null, dexBias };
    }
  }

  // ── Call/put wall TP targets ──────────────────────────────────────────────────
  if (direction === "LONG") {
    const walls = (gc.callWalls || []).filter(w => w.price > entry + GEX_BUFFER).sort((a, b) => a.price - b.price);
    const callWall = gc.callWall && gc.callWall > entry + GEX_BUFFER ? gc.callWall : (walls[0]?.price || null);
    if (!callWall) return { allowed: false, reason: "SPY above all GEX call walls — no upside target", tp1: entry, tp2: entry, target: null, dexBias };
    if (callWall - entry < GEX_BUFFER) return { allowed: false, reason: "LONG blocked — at call wall $" + callWall, tp1: callWall, tp2: callWall, target: callWall, dexBias };
    const tp1    = magnet && magnet > entry && magnet < callWall ? magnet : callWall;
    const tp2    = callWall > tp1 ? callWall : (walls[1]?.price || callWall);
    const target = magnet && magnet > entry && magnet < callWall ? magnet : callWall;
    const pathResist = pathResistance("LONG", entry);
    const hardness   = wallHardness(callWall);
    const revBlock   = reversalBlock("LONG", pathResist, hardness);
    if (revBlock) return { allowed: false, reason: revBlock, tp1: entry, tp2: entry, target: null, dexBias, pathResist, wallHardness: hardness };
    const profNote   = (pathResist!=null ? " | path resist "+pathResist : "") + (hardness!=null ? " | wall "+hardness+"x"+(hardness>=2?" HARD":" soft") : "");
    return { allowed: true, reason: "LONG → wall $" + callWall + (magnet ? " | magnet $" + magnet : "") + dexNote + profNote, tp1, tp2, target, dexBias, pathResist, wallHardness: hardness };
  }

  if (direction === "SHORT") {
    const walls = (gc.putWalls || []).filter(w => w.price < entry - GEX_BUFFER).sort((a, b) => b.price - a.price);
    const putWall = gc.putWall && gc.putWall < entry - GEX_BUFFER ? gc.putWall : (walls[0]?.price || null);
    if (!putWall) return { allowed: false, reason: "SPY below all GEX put walls — no downside target", tp1: entry, tp2: entry, target: null, dexBias };
    if (entry - putWall < GEX_BUFFER) return { allowed: false, reason: "SHORT blocked — at put wall $" + putWall, tp1: putWall, tp2: putWall, target: putWall, dexBias };
    const tp1    = magnet && magnet < entry && magnet > putWall ? magnet : putWall;
    const tp2    = putWall < tp1 ? putWall : (walls[1]?.price || putWall);
    const target = magnet && magnet < entry && magnet > putWall ? magnet : putWall;
    const pathResist = pathResistance("SHORT", entry);
    const hardness   = wallHardness(putWall);
    const revBlock   = reversalBlock("SHORT", pathResist, hardness);
    if (revBlock) return { allowed: false, reason: revBlock, tp1: entry, tp2: entry, target: null, dexBias, pathResist, wallHardness: hardness };
    const profNote   = (pathResist!=null ? " | path resist "+pathResist : "") + (hardness!=null ? " | wall "+hardness+"x"+(hardness>=2?" HARD":" soft") : "");
    return { allowed: true, reason: "SHORT → wall $" + putWall + (magnet ? " | magnet $" + magnet : "") + dexNote + profNote, tp1, tp2, target, dexBias, pathResist, wallHardness: hardness };
  }

  return { allowed: true, reason: "No GEX filter" + dexNote, tp1: entry, tp2: entry, target: null, dexBias };
}

// ── Strike selection ──────────────────────────────────────────────────────────
// Deliberately independent of GEX, Greeks, IV, and walls. A call uses the next
// whole-dollar strike above spot; a put uses the next whole-dollar strike below.
// Exact-dollar spot still moves one strike in the trade direction.
function selectStrike(price, direction) {
  if (!Number.isFinite(price)) throw new Error("Invalid SPY price for strike selection");
  const strike = direction === "LONG" ? Math.floor(price) + 1 : Math.ceil(price) - 1;
  return {
    strike,
    reason: "Immediate $1 strike "+(direction === "LONG" ? "above" : "below")+" SPY $"+price.toFixed(2),
    delta: null,
    gamma: null,
    impliedVol: null,
    otm: Math.abs(strike-price),
    method: "immediate-directional",
  };
}

/* Retained temporarily as historical reference only; no production path calls it. */
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
 *
 * Exposure-aware adjustments (VEX/DEX/CHEX from FlashAlpha):
 *   CHEX high (p70+) after 12:00 ET — charm decay accelerates OTM premium bleed into
 *     close; penalize low-delta strikes so late entries favor ATM/ITM contracts.
 *   VEX high (p80+) — vol demand implies a larger expected move; gamma-heavy OTM
 *     strikes get a boost. VEX low (p20-) — pinning likely; penalize low delta.
 *   DEX OPPOSED — MM hedging flows work against the trade; penalize low-delta
 *     strikes (need the move to overcome the hedging headwind before OTM pays).
 */
function _legacyGexStrikeSelectionBody(price, direction, target, dexBias, pathResist) {
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

      // Exposure context for scoring adjustments
      const etNow      = getETDate();
      const charmHours = etNow.getHours() >= 12;
      const chexHigh   = charmHours && gexCache.chexPctRank != null && gexCache.chexPctRank >= 70;
      const vexHigh    = gexCache.vexPctRank != null && gexCache.vexPctRank >= 80;
      const vexLow     = gexCache.vexPctRank != null && gexCache.vexPctRank <= 20;
      const dexOpposed = dexBias === "OPPOSED";
      const highResist = pathResist != null && pathResist >= 0.6;
      const expNotes   = [];
      if (highResist) expNotes.push("GEX path resist "+pathResist+" — pinning gamma ahead, favoring high delta");
      if (chexHigh)   expNotes.push("CHEX p"+gexCache.chexPctRank+" charm decay — favoring ATM/ITM");
      if (vexHigh)    expNotes.push("VEX p"+gexCache.vexPctRank+" big move expected — OTM boost");
      if (vexLow)     expNotes.push("VEX p"+gexCache.vexPctRank+" pinning — favoring high delta");
      if (dexOpposed) expNotes.push("DEX OPPOSED headwind — favoring high delta");

      const scored = candidates.map(c => {
        // Delta-gamma approximation of option price change to target
        const estMove = c.delta*Math.abs(move) + 0.5*c.gamma*Math.pow(move,2);
        const payoffScore = estMove / c.mid; // bigger = better R:R per $ paid
        const ivPenalty = medianIV>0 && c.iv > medianIV*1.3 ? 0.6 : 1.0; // discount overpriced IV
        let expAdj = 1.0;
        if (chexHigh   && c.delta < 0.35) expAdj *= 0.65; // charm bleed hits far OTM hardest
        if (vexLow     && c.delta < 0.40) expAdj *= 0.80;
        if (dexOpposed && c.delta < 0.40) expAdj *= 0.80;
        if (highResist && c.delta < 0.40) expAdj *= 0.75; // must chew through pinning gamma — OTM unlikely to be reached
        if (vexHigh    && c.delta < 0.40 && c.delta >= 0.20) expAdj *= 1.15;
        return {...c, score: payoffScore*ivPenalty*expAdj};
      }).sort((a,b)=>b.score-a.score);

      const best = scored[0];
      if (best) {
        if (expNotes.length) log("STRIKE","Exposure adj: "+expNotes.join(" | "));
        return {
          strike: best.strike,
          reason: "Greeks-optimized: δ"+best.delta.toFixed(2)+" γ"+best.gamma.toFixed(4)+
                   " IV"+(best.iv*100).toFixed(0)+"% → best payoff/cost toward $"+target.toFixed(2)+
                   (expNotes.length ? " ["+expNotes.join("; ")+"]" : ""),
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
  // Charm clamp: high CHEX after 12:00 ET bleeds OTM premium into close — cap OTM at 1
  const charmClamp = getETDate().getHours() >= 12 && gexCache.chexPctRank != null && gexCache.chexPctRank >= 70;
  // Resistance clamp: >=60% of nearby GEX opposes the move — far OTM won't get reached
  const resistClamp = pathResist != null && pathResist >= 0.6;
  const otmCap = charmClamp ? 1 : resistClamp ? 2 : 5;
  if(direction==="LONG"){
    const walls=(gexCache.callWalls||[]).filter(w=>w.price>price).sort((a,b)=>a.price-b.price);
    if(!walls.length) return {strike:atm+1,reason:"OTM+1",delta:0.45,otm:1,method:"heuristic"};
    const dist=walls[0].price-price, otm=Math.min(otmCap,Math.max(1,Math.round(dist*(isPos?0.30:0.15))));
    return {strike:Math.min(Math.round(atm+otm),Math.round(walls[0].price-1)),reason:(isPos?"pos":"neg")+" GEX → "+otm+" OTM toward $"+walls[0].price+(charmClamp?" [CHEX p"+gexCache.chexPctRank+" charm clamp]":""),delta:Math.max(0.15,0.50-otm*0.08),otm,method:"heuristic"};
  }
  if(direction==="SHORT"){
    const walls=(gexCache.putWalls||[]).filter(w=>w.price<price).sort((a,b)=>b.price-a.price);
    if(!walls.length) return {strike:atm-1,reason:"OTM+1",delta:0.45,otm:1,method:"heuristic"};
    const dist=price-walls[0].price, otm=Math.min(otmCap,Math.max(1,Math.round(dist*(isPos?0.30:0.15))));
    return {strike:Math.max(Math.round(atm-otm),Math.round(walls[0].price+1)),reason:(isPos?"pos":"neg")+" GEX → "+otm+" OTM toward $"+walls[0].price+(charmClamp?" [CHEX p"+gexCache.chexPctRank+" charm clamp]":""),delta:Math.max(0.15,0.50-otm*0.08),otm,method:"heuristic"};
  }
  return {strike:atm,reason:"ATM fallback",delta:0.50,otm:0,method:"heuristic"};
}

// ── OCC helpers ───────────────────────────────────────────────────────────────
function buildSymbol(strike,right,date) {
  const yy=String(date.getFullYear()).slice(2),mm=String(date.getMonth()+1).padStart(2,"0"),dd=String(date.getDate()).padStart(2,"0");
  return "SPY"+yy+mm+dd+right+String(Math.round(strike*1000)).padStart(8,"0");
}
function getETDate(){return new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));}
// DST-safe ET UTC-offset for a given YYYY-MM-DD ("-04:00" in EDT, "-05:00" in EST). Replaces
// hardcoded "-04:00" which was wrong Nov–Mar (ORB window + bar filtering off by an hour).
function etOffset(dateStr){
  const utcNoon = new Date(dateStr+"T12:00:00Z");
  const etHour = parseInt(new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",hour:"numeric",hour12:false}).format(utcNoon),10);
  let off = etHour - 12; if(off>0) off-=24;   // 12:00Z → 08:00 EDT(-4) or 07:00 EST(-5)
  return (off<=0?"-":"+")+String(Math.abs(off)).padStart(2,"0")+":00";
}
function getExpiry(){const d=getETDate();return d.getFullYear()+String(d.getMonth()+1).padStart(2,"0")+String(d.getDate()).padStart(2,"0");}
function etDateString(date=getETDate()){
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const p=Object.fromEntries(parts.filter(x=>x.type!=="literal").map(x=>[x.type,x.value]));
  return p.year+"-"+p.month+"-"+p.day;
}

// Resolve 2DTE against Alpaca's trading calendar, rather than assuming weekdays are
// sessions. This correctly skips market holidays and deliberately fails closed if the
// calendar cannot be obtained, avoiding an invalid or unintended expiration.
async function getTradingDayOffset(daysAhead){
  const today=etDateString();
  const end=new Date(Date.now()+21*86400000).toISOString().slice(0,10);
  const rows=await aGet("/v2/calendar?start="+today+"&end="+end);
  const future=(rows||[]).map(r=>r.date).filter(d=>d>today);
  if(future.length<daysAhead) throw new Error("Trading calendar did not return "+daysAhead+" future sessions");
  const [y,m,d]=future[daysAhead-1].split("-").map(Number);
  return new Date(y,m-1,d,12,0,0);
}

async function getOptionQuote(symbol){
  try{
    const r=await fetch(ALPACA_DATA+"/v1beta1/options/snapshots?symbols="+symbol,{headers:aH()});
    if(!r.ok) return null;
    const d=await r.json(), s=(d.snapshots||{})[symbol];
    if(!s||!s.latestQuote) return null;
    const bid=parseFloat(s.latestQuote.bp||0),ask=parseFloat(s.latestQuote.ap||0);
    if(!(bid>0&&ask>0&&ask>=bid)) return null;
    const mid=parseFloat(((bid+ask)/2).toFixed(2));
    return { bid, ask, mid, spreadPct:(ask-bid)/mid };
  }catch(_){return null;}
}

// ── Position close ────────────────────────────────────────────────────────────
async function closePosition(symbol){
  return await aDel("/v2/positions/"+encodeURIComponent(symbol));
}

// Confirmed close: verify the DELETE succeeded (retry once), treat a 404 as already-gone, and
// derive the REAL exit price from the resulting close order's fill (not the pre-close mark).
// Returns { ok, fillPrice }. ok=false means the position may STILL BE OPEN — caller must NOT
// mark the trade closed; it should retry on the next monitor tick.
async function closePositionConfirmed(symbol, fallbackPrice){
  let r = await closePosition(symbol);
  if(!r.ok){
    if(String(r.status)==="404") return { ok:true, fillPrice:fallbackPrice }; // already gone/expired
    await new Promise(res=>setTimeout(res,600));
    r = await closePosition(symbol); // one retry
    if(!r.ok){
      if(String(r.status)==="404") return { ok:true, fillPrice:fallbackPrice };
      log("MONITOR ERR","closePosition "+symbol+" FAILED ("+r.status+") — position may still be open");
      return { ok:false, fillPrice:fallbackPrice, error:r.data };
    }
  }
  // r.data is the close order — poll for its actual fill price
  let fillPrice=fallbackPrice;
  const oid=r.data?.id;
  if(oid){ const f=await pollFill(oid,8000).catch(()=>null); if(f?.filled_avg_price) fillPrice=parseFloat(f.filled_avg_price); }
  return { ok:true, fillPrice };
}

// ── Price monitor ─────────────────────────────────────────────────────────────
// Stepped ladder ratchet — widening variant. Peak gain (pts) → locked profit (pts):
//   <15: not armed | 15-19: breakeven | 20-40: lock 5 per 5 (20→5 ... 40→25)
//   >40: lock 5 per 10 of additional peak (50→30, 60→35 ...) — gap widens so runners breathe
function ratchetLockPct(peakGainPct){
  const p = peakGainPct*100;
  if (p < 15) return null;
  if (p < 20) return 0;
  if (p <= 40) return 5*Math.floor((p-15)/5);
  return 25 + 5*Math.floor((p-40)/10);
}

// Shadow trail configs — virtual only, never touch real exits. Journal records what
// each WOULD have done so trail params can be reevaluated from data, not anecdotes.
const SHADOW_TRAILS = [
  { name:"trail_10_5", trigger:0.10, dist:0.05 },
  { name:"trail_20_8", trigger:0.20, dist:0.08 },
];

function startMonitor(signal, indicators) {
  log("MONITOR","Watching "+signal.optionSymbol+" | stop $"+signal.stopPrice+" | tp1 $"+signal.tp1Price+" | poll: 30s");
  const entryTime=Date.now();
  signal.shadows = SHADOW_TRAILS.map(c=>({name:c.name, trigger:c.trigger, dist:c.dist, active:false, stop:null, exited:false, exitPrice:null}));
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5; // ~2.5 minutes of failures at 30s poll before giving up

  const iv=setInterval(async()=>{
    if(!["FILLED"].includes(signal.status)){clearInterval(iv);return;}
    // Re-entrancy guard: a poll/close call can take >30s; without this, a second tick could
    // fire while the first is still awaiting a close → duplicate DELETE requests. Skip if busy.
    if(signal._monitorBusy) return;
    signal._monitorBusy=true;
    try{
    // Market closed → skip. A 1DTE position held overnight can't move on a stale price, so
    // polling every 30s all night is wasted work and floods the log buffer (it pushed a whole
    // morning of activity out of the ring buffer on 2026-07-21). Interval stays alive; real
    // polling resumes at the next open. (Not a per-position log — silent skip by design.)
    if(!isMarketHours(getETDate())){ signal._monitorBusy=false; return; }
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

      // Shadow trails — virtual bookkeeping only (see SHADOW_TRAILS)
      for(const sh of (signal.shadows||[])){
        if(sh.exited) continue;
        if(!sh.active && (signal.maxPrice-entry)/entry >= sh.trigger) sh.active=true;
        if(sh.active){
          const shStop=Math.max(signal.maxPrice*(1-sh.dist), entry);
          sh.stop = sh.stop!=null ? Math.max(sh.stop, shStop) : shStop;
          if(price<=sh.stop){ sh.exited=true; sh.exitPrice=price; }
        }
      }

      // Trailing stop — activates once gain reaches trigger ($ or %).
      // Trail distance is dynamic: tightens when price is near the 0DTE magnet/wall
      // (maximizing profit capture at the likely SPY reversal zone) and widens when
      // far from it (gives the position room to run toward the target).
      const gainPct  = (signal.maxPrice - entry) / entry;
      const gainDollars = signal.maxPrice - entry;
      // Use params frozen at fill time — immune to mid-session mode changes
      const sigTrailTriggerPct  = signal.trailTriggerPct  ?? TRAIL_TRIGGER_PCT;
      const sigTrailDistancePct = signal.trailDistancePct ?? TRAIL_DISTANCE_PCT;
      const trailTriggered = TRAIL_TRIGGER_DOLLARS > 0
        ? gainDollars >= TRAIL_TRIGGER_DOLLARS
        : gainPct >= sigTrailTriggerPct;
      if (trailTriggered) {
        // Dynamic distance: tighten near GEX magnet/wall to lock in gains at target
        let trailDist = sigTrailDistancePct;
        if (TRAIL_DISTANCE_DOLLARS > 0) {
          trailDist = TRAIL_DISTANCE_DOLLARS / signal.maxPrice;
        } else if (gexCache) {
          const magnet = gexCache.zeroDteMagnet || (signal.direction==="LONG" ? gexCache.callWall : gexCache.putWall);
          if (magnet && price) {
            const headroom = signal.direction==="LONG"
              ? (magnet - price) / price
              : (price - magnet) / price;
            // Tighten near magnet — mode-aware baseline: TREND uses sigTrailDistancePct (10%) as floor
            if      (headroom <= 0)     trailDist = 0.05;                           // past magnet: very tight
            else if (headroom <= 0.003) trailDist = Math.min(sigTrailDistancePct, 0.08);  // within $0.20
            else if (headroom <= 0.007) trailDist = Math.min(sigTrailDistancePct, 0.11);  // within $0.50
            else if (headroom <= 0.015) trailDist = Math.min(sigTrailDistancePct, 0.16);  // within $1
            else trailDist = sigTrailDistancePct;                                   // far: use mode default
          }
        }
        const trailStop = signal.maxPrice * (1 - trailDist);
        const newStop   = Math.max(trailStop, entry, signal.stopPrice);
        if (newStop > signal.stopPrice) {
          signal.stopPrice    = parseFloat(newStop.toFixed(2));
          signal.trailingActive = true;
          signal.trailDist    = parseFloat((trailDist*100).toFixed(1));
          log("TRAIL", signal.optionSymbol+" stop raised to $"+signal.stopPrice+
            " (peak $"+signal.maxPrice+", "+signal.maxPnlPct+"%, trail "+signal.trailDist+"%)");
          broadcast({type:"signal_update",id:signal.id,stopPrice:signal.stopPrice,trailingActive:true,trailDist:signal.trailDist});
        }
      }

      // Stepped ladder ratchet — raises stop as peak gain climbs, never lowers it.
      // Runs in every mode alongside the trail; whichever produces the higher stop wins.
      const lock = ratchetLockPct(gainPct);
      if (lock != null) {
        const ratchetStop = parseFloat((entry*(1+lock/100)).toFixed(2));
        if (ratchetStop > signal.stopPrice) {
          signal.stopPrice   = ratchetStop;
          signal.ratchetActive = true;
          signal.ratchetLock   = lock;
          log("RATCHET", signal.optionSymbol+" stop raised to $"+signal.stopPrice+
            " (+"+lock+"% locked, peak "+signal.maxPnlPct+"%)");
          broadcast({type:"signal_update",id:signal.id,stopPrice:signal.stopPrice,ratchetActive:true,ratchetLock:lock});
        }
      }

      // TREND VWAP-cross exit — flagged by the scan loop on a 5-min close through VWAP
      if (signal.vwapExit) {
        const cc=await closePositionConfirmed(signal.optionSymbol, price);
        if(!cc.ok){ log("MONITOR ERR","VWAP-exit close FAILED — retrying next tick"); broadcast({type:"signal_update",id:signal.id,status:"CLOSE_FAILED"}); return; }
        clearInterval(iv);
        const exitPx=cc.fillPrice;
        log("TREND","Closed "+signal.optionSymbol+" on VWAP-cross exit @ $"+exitPx+" | peak $"+signal.maxPrice+" ("+signal.maxPnlPct+"%)");
        const pnl=(exitPx-entry)*100*signal.contracts;
        signal.status="STOPPED"; signal.closePnl=pnl; signal.closePrice=exitPx;
        signal.closeReason="VWAP_TREND_EXIT"; signal.durationMin=((Date.now()-entryTime)/60000).toFixed(1);
        signal.outcome=pnl>=0?"WIN":"LOSS";
        sessionPnL+=pnl; dailyLoss+=Math.abs(Math.min(0,pnl));
        broadcast({type:"signal_update",id:signal.id,status:"STOPPED",closeReason:"VWAP_TREND_EXIT",pnl});
        saveTradeToDB(signal,signal._dbId,indicators);
        return;
      }

      log("MONITOR",signal.optionSymbol+" $"+price+" | P&L "+pct+"% | stop $"+signal.stopPrice+(signal.trailingActive?" (trailing)":signal.ratchetActive?" (ratchet +"+signal.ratchetLock+"%)":"")+" | tp1 $"+signal.tp1Price+" | max $"+signal.maxPrice+" | min $"+signal.minPrice);
      broadcast({type:"signal_update",id:signal.id,currentPrice:price,maxPrice:signal.maxPrice,minPrice:signal.minPrice,maxPnlPct:signal.maxPnlPct,minPnlPct:signal.minPnlPct});

      // TP1 is the trailing-stop trigger, not a fixed-profit exit. The first hit is
      // journaled and blocks re-entry only after the eventual profitable trailing exit.
      if(price>=signal.tp1Price && !signal.tp1Armed){
        signal.tp1Armed=true;
        log("TP1","Triggered @ $"+price+" — runner remains open with stop $"+signal.stopPrice);
        broadcast({type:"signal_update",id:signal.id,tp1Armed:true,stopPrice:signal.stopPrice});
      }
      if(price<=signal.stopPrice){
        const reason=signal.trailingActive?"TRAIL_STOP_HIT":signal.ratchetActive?"RATCHET_STOP_HIT":"STOP_HIT";
        const cc=await closePositionConfirmed(signal.optionSymbol, price);
        if(!cc.ok){ log("MONITOR ERR","stop close FAILED — retrying next tick"); broadcast({type:"signal_update",id:signal.id,status:"CLOSE_FAILED"}); return; }
        clearInterval(iv);
        const exitPx=cc.fillPrice;
        log(signal.trailingActive?"TRAIL":"STOP",
          (signal.trailingActive?"Trailing stop":"Stop")+" hit $"+price+" <= $"+signal.stopPrice+" — closed @ $"+exitPx+
          " | peak $"+signal.maxPrice+" ("+signal.maxPnlPct+"%) | trough $"+signal.minPrice+" ("+signal.minPnlPct+"%)");
        const pnl=(exitPx-entry)*100*signal.contracts;
        signal.status="STOPPED"; signal.closePnl=pnl; signal.closePrice=exitPx;
        signal.closeReason=reason; signal.durationMin=((Date.now()-entryTime)/60000).toFixed(1);
        signal.outcome=pnl>=0?"WIN":"LOSS";
        if(signal.tp1Armed && pnl>=0) lastTP1Time=Date.now();
        // Cooldown only applies to genuine losses on the initial fixed stop — a trailing
        // or ratchet stop exit at/above entry isn't evidence the thesis failed.
        if(!signal.trailingActive && !signal.ratchetActive){
          lastStopTime=Date.now();
          // Direction-specific cooldown: count consecutive fixed stops per direction
          const dir=signal.direction;
          if(dir==="LONG"||dir==="SHORT"){
            dirStops[dir]=(dirStops[dir]||0)+1;
            if(dirStops[dir]>=2 && DIRECTION_COOLDOWN==="ON"){
              const cdMins = MARKET_MODE_AUTO==="ON" ? getModeParams().cooldownMins : DIRECTION_COOLDOWN_MINS;
              dirCooldownUntil[dir]=Date.now()+cdMins*60000;
              log("SAFETY","Direction cooldown: "+dir+" blocked for "+cdMins+" min after "+dirStops[dir]+" consecutive stops [mode:"+MARKET_MODE+"]");
            }
          }
        } else {
          // Winning trail-stop exit resets the consecutive-stop counter for this direction
          const dir=signal.direction;
          if(dir==="LONG"||dir==="SHORT") dirStops[dir]=0;
        }
        sessionPnL+=pnl; dailyLoss+=Math.abs(Math.min(0,pnl));
        // Daily per-direction loss circuit breaker: count ANY losing close (trailing or not)
        // and lock the direction for the day once it hits the cap.
        if(pnl<0 && (signal.direction==="LONG"||signal.direction==="SHORT")){
          const dir=signal.direction;
          dirLossesToday[dir]=(dirLossesToday[dir]||0)+1;
          if(dirLossesToday[dir]>=MAX_DIR_LOSSES_DAY && !dirLockedToday[dir]){
            dirLockedToday[dir]=true;
            log("SAFETY","DAILY LOCKOUT: "+dir+" blocked for the rest of the day — "+dirLossesToday[dir]+" losses (cap "+MAX_DIR_LOSSES_DAY+")");
          }
        }
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
    } finally { signal._monitorBusy=false; } // always release the re-entrancy lock
  },30000); // 30s poll
  signal._monitorInterval=iv;
}


// ── Execute trade ─────────────────────────────────────────────────────────────
async function executeTrade(direction, price, indicators, gexResult) {
  if(!ALPACA_KEY||!ALPACA_SECRET){log("ERROR","No Alpaca keys");return;}
  // MAX_TRADES_DAY = 0 → auto mode: up to 5 when DEX strongly bullish and session is green
  const effectiveMaxTrades = MAX_TRADES_DAY === 0
    ? (gexCache?.dex != null && gexCache.dex > 5e10 && sessionPnL > 0 ? 5 : 3)
    : MAX_TRADES_DAY;
  if(tradesDay>=effectiveMaxTrades){
    log("GUARD","Max "+effectiveMaxTrades+" trades/day reached"+(MAX_TRADES_DAY===0?" (auto: DEX="+((gexCache?.dex||0)/1e9).toFixed(0)+"B, PnL $"+sessionPnL.toFixed(0)+")":""));
    return;
  }
  if(dailyLoss>=ACCOUNT_SIZE*MAX_DAILY_LOSS){log("GUARD","Daily loss limit reached");return;}

  const right = direction==="LONG"?"C":"P";
  let date;
  try { date=await getTradingDayOffset(2); }
  catch(e){ log("SAFETY","2DTE calendar lookup failed — entry blocked: "+e.message); return; }
  const si=selectStrike(price, direction);

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
    gexTarget:   gexResult.target, gexReason:gexResult.reason, dexBias:gexResult.dexBias||"NEUTRAL",
    gexPathResist: gexResult.pathResist??null, gexWallHardness: gexResult.wallHardness??null,
    squeezeAtEntry: indicators.squeeze ? {on:indicators.squeeze.on, fired:indicators.squeeze.fired, dir:indicators.squeeze.direction} : null,
    flagAtEntry: indicators.flag||null,
    expiry:      date.getFullYear()+String(date.getMonth()+1).padStart(2,"0")+String(date.getDate()).padStart(2,"0"),
    is2DTE:      true,
    riskBudget:getRiskBudget(),
    contracts:null, midPrice:null, totalCost:null,
    fillPrice:null, stopPrice:null, tp1Price:null,
    optionSymbol:null, closePnl:null,
    closePrice:null, closeReason:null,
    durationMin:null, outcome:null,
    trigger:"Internal Signal Engine",
    confidence:indicators.strength||"MEDIUM",
    status:"PENDING",
    indicators: {...indicators},
    // Full greek context frozen at signal-fire time — displayed on signal card, stored for data mining
    gexSnapshot: gexCache ? {
      regime:       gexCache.regime,
      gammaFlip:    gexCache.gammaFlip,
      callWall:     gexCache.callWall,
      putWall:      gexCache.putWall,
      zeroDteMagnet:gexCache.zeroDteMagnet,
      pinRisk:      gexCache.pinRisk,
      dex:          gexCache.dex,        dexPctRank: gexCache.dexPctRank,  dexLabel: gexCache.dexLabel,
      vex:          gexCache.vex,        vexPctRank: gexCache.vexPctRank,  vexLabel: gexCache.vexLabel,
      chex:         gexCache.chex,       chexPctRank:gexCache.chexPctRank, chexLabel:gexCache.chexLabel,
      marketMode:   MARKET_MODE,         marketScore: marketScore,
      callWalls:    (gexCache.callWalls||[]).slice(0,3),
      putWalls:     (gexCache.putWalls||[]).slice(0,3),
      gexRationale: gexResult.reason,    dexBias:    gexResult.dexBias,
    } : null,
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

    const quote=await getOptionQuote(symbol);
    if(!quote||quote.ask<0.05||quote.ask>50) throw new Error("No valid quote for immediate 2DTE strike");
    if(quote.spreadPct>MAX_OPTION_SPREAD_PCT) throw new Error("SAFETY: option spread "+(quote.spreadPct*100).toFixed(1)+"% exceeds "+(MAX_OPTION_SPREAD_PCT*100).toFixed(1)+"% cap");
    const mpForRisk=MARKET_MODE_AUTO==="ON"?getModeParams():null;
    const plannedStopPct=(mpForRisk?.premiumStopPct&&quote.ask>0.70)?mpForRisk.premiumStopPct:PREMIUM_STOP_PCT;
    const plannedStop=parseFloat((quote.ask*(1-plannedStopPct)).toFixed(2));
    let contracts=calcContracts(quote.ask,plannedStop);
    if(contracts<1) throw new Error("SAFETY: risk budget is below one contract at the configured stop");
    const totalCost=parseFloat((quote.ask*100*contracts).toFixed(2));
    if(contracts>50)               throw new Error("SAFETY: "+contracts+" contracts > 50");
    if(totalCost>ACCOUNT_SIZE*0.10) throw new Error("SAFETY: $"+totalCost+" > 10% of account");

    log("SAFETY","Guards passed — "+sig.optionSymbol+" x"+contracts+" @ ask $"+quote.ask+" | spread "+(quote.spreadPct*100).toFixed(1)+"% | planned loss $"+((quote.ask-plannedStop)*100*contracts).toFixed(2));

    const order=await aPost("/v2/orders",{
      symbol:sig.optionSymbol, qty:String(contracts),
      side:"buy", type:"limit", limit_price:String(quote.ask),
      time_in_force:"day", client_order_id:"spxcmd_"+sig.id,
    });

    sig.contracts=contracts; sig.midPrice=quote.mid; sig.totalCost=totalCost;
    sig.status="SENT";
    broadcast({type:"signal_update",id:sig.id,status:"SENT",optionSymbol:sig.optionSymbol,contracts,midPrice:quote.mid,totalCost});
    log("ALPACA","Order: "+order.id+" | "+sig.optionSymbol+" x"+contracts+" @ ask $"+quote.ask);

    let filled=await pollFill(order.id,60000).catch(()=>null);
    if(!filled){
      // Don't leave a live limit order the bot no longer watches — it could fill later,
      // unmonitored, while the bot takes another trade. Cancel, then check for a partial fill.
      log("ORDER","Unfilled after 60s — cancelling order "+order.id);
      try{ await aDel("/v2/orders/"+order.id); }catch(e){ log("ORDER ERR","cancel: "+e.message); }
      let final=null; try{ final=await aGet("/v2/orders/"+order.id); }catch(_){}
      const fq=parseInt(final?.filled_qty||0);
      if(fq>0){
        // Partially filled before cancel — that's a real position; monitor it.
        log("ORDER","Partial fill "+fq+"/"+contracts+" before cancel — monitoring as position");
        filled={ filled_avg_price: final.filled_avg_price||quote.ask };
        contracts=fq; sig.contracts=fq;
      } else {
        sig.status="CANCELLED";
        broadcast({type:"signal_update",id:sig.id,status:"CANCELLED"});
        log("ORDER","No fill — order cancelled, no position");
        return;
      }
    }

    sig.fillPrice=parseFloat(filled.filled_avg_price||quote.ask);
    sig.totalCost=parseFloat((sig.fillPrice*100*sig.contracts).toFixed(2));

    // Freeze mode-specific exit params at fill time so mid-session mode changes don't affect open position
    const mp = MARKET_MODE_AUTO==="ON" ? getModeParams() : null;
    // Premium-conditional stop: only tighten TREND stop if fill > $0.70
    // (below $0.70, 15% = ~$0.10 — narrower than typical 0DTE bid-ask spread, gets stopped by noise)
    const effectiveStopPct = (mp?.premiumStopPct && sig.fillPrice > 0.70)
      ? mp.premiumStopPct : PREMIUM_STOP_PCT;
    const effectiveTrailTriggerPct  = mp?.trailTriggerPct  ?? TRAIL_TRIGGER_PCT;
    const effectiveTrailDistancePct = mp?.trailDistancePct ?? TRAIL_DISTANCE_PCT;

    const stop = parseFloat((sig.fillPrice*(1-effectiveStopPct)).toFixed(2));
    const tp1  = TRAIL_TRIGGER_DOLLARS > 0
      ? parseFloat((sig.fillPrice + TRAIL_TRIGGER_DOLLARS).toFixed(2))
      : parseFloat((sig.fillPrice * (1 + effectiveTrailTriggerPct)).toFixed(2));

    // Freeze onto signal so monitor uses same params regardless of future mode changes
    sig.stopPct          = effectiveStopPct;
    sig.trailTriggerPct  = effectiveTrailTriggerPct;
    sig.trailDistancePct = effectiveTrailDistancePct;
    sig.modeAtFill       = mp ? (MARKET_MODE_OVERRIDE || MARKET_MODE) : "NEUTRAL";
    // Freeze entry-time GEX context so the trade row reflects conditions AT ENTRY, not at close
    // (reading the live cache at close time contaminated later performance analysis).
    sig.gexRegimeAtEntry = gexCache?.regime || null;
    sig.gexFlipAtEntry   = gexCache?.gammaFlip || null;
    sig.netGexAtEntry    = gexCache?.netGex ?? null;
    sig.dexAtEntry       = gexCache?.dex ?? null;
    sig.vexAtEntry       = gexCache?.vex ?? null;
    sig.chexAtEntry      = gexCache?.chex ?? null;
    sig.magnetAtEntry    = gexCache?.zeroDteMagnet ?? null;

    sig.stopPrice=stop; sig.tp1Price=tp1; sig.status="FILLED";
    sig.entryTime=Date.now();
    tradesDay++;

    broadcast({type:"signal_update",id:sig.id,status:"FILLED",fillPrice:sig.fillPrice,stopPrice:stop,tp1Price:tp1,modeAtFill:sig.modeAtFill,stopPct:effectiveStopPct});
    log("FILL","Filled @ $"+sig.fillPrice+" | stop $"+stop+" ("+Math.round(effectiveStopPct*100)+"%) | tp1 $"+tp1+" | R:R "+((tp1-sig.fillPrice)/(sig.fillPrice-stop)).toFixed(1)+":1 | mode:"+sig.modeAtFill);
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
let lastTP1Time   = 0;      // epoch ms of the last TP1 win — drives POST_TP1_COOLDOWN_MINS
const COOLDOWN_MS = 600000; // 10 min cooldown after stop before re-entering
// Direction-specific cooldown — block a direction after 2 consecutive losses in that direction
const dirStops = { LONG: 0, SHORT: 0 }; // consecutive fixed-stop count per direction
const dirCooldownUntil = { LONG: 0, SHORT: 0 }; // epoch ms until direction is unblocked

// ── Market Mode Classifier ─────────────────────────────────────────────────────
// Fetches prior-session daily bars once at startup — gives overnight gap + 5-day ADR.
// One lightweight Alpaca call, cached for the day.
async function fetchPrevDayData() {
  try {
    // Uses the shared date-ranged fetch (a bare limit=7 query returned <2 bars — the "not
    // enough bars" bug that left the classifier's gap + 5-day-ADR inputs dead for weeks).
    const daily = await fetchSpyDailyBars(20);
    if (daily.length < 2) { log("MARKET","fetchPrevDayData: not enough bars"); return; }
    const prev = daily[daily.length - 2]; // yesterday
    // 5-day ADR from last 5 complete sessions
    const last5 = daily.slice(-6, -1);
    const adr5 = last5.length ? parseFloat((last5.reduce((s,b)=>s+(b.h-b.l),0)/last5.length).toFixed(2)) : null;
    prevDayData = { close: prev.c, high: prev.h, low: prev.l, open: prev.o, adr5 };
    log("MARKET","PrevDay loaded — close $"+prev.c+" | ADR5 $"+(adr5||"n/a"));
  } catch(e) { log("MARKET ERR","fetchPrevDayData: "+e.message); }
}

// Returns per-mode parameter overrides. Only applied when MARKET_MODE_AUTO=ON.
function getModeParams() {
  const mode = MARKET_MODE_OVERRIDE || MARKET_MODE;
  return {
    // TREND: momentum-scalp profile — forgiving RSI, quick profit lock, tight trail
    // premiumStopPct is conditional on fill price (applied in executeTrade, not here):
    //   fill > $0.70 → 15% stop (safe above spread noise floor)
    //   fill <= $0.70 → keep 25% (cheap contracts, spread noise too wide for 15%)
    TREND: {
      rsiLongMax:70, rsiShortMin:30, cooldownMins:30, fibEntryFilter:false,
      // FIX #2 (2026-08-06): let TREND winners RUN. The old 15% stop + 30% trail exited winners
      // around +26% (avg win collapsed $916→$152). On a genuine trend (now rare: score>=3) the
      // move is big, so give it room: wider stop, trail activates late so it can reach TP1.
      premiumStopPct:0.22,   // was 0.15 — tight stop got chopped up (conditional on fill in executeTrade)
      trailTriggerPct:0.60,  // was 0.30 — don't start trailing until +60%; let the trend run toward TP1
      trailDistancePct:0.25, // wide catastrophe backstop; magnet-proximity tightening still overrides near walls
    },
    // NEUTRAL: use env var settings unchanged
    NEUTRAL: {
      rsiLongMax:RSI_LONG_MAX, rsiShortMin:RSI_SHORT_MIN, cooldownMins:DIRECTION_COOLDOWN_MINS, fibEntryFilter:false,
      premiumStopPct:null, trailTriggerPct:null, trailDistancePct:null,
    },
    // CHOP: wider stop (spread noise higher in choppy markets), slower to trigger trail
    CHOP: {
      rsiLongMax:55, rsiShortMin:45, cooldownMins:90, fibEntryFilter:true,
      premiumStopPct:null, trailTriggerPct:null, trailDistancePct:null,
    },
  }[mode] || { rsiLongMax:RSI_LONG_MAX, rsiShortMin:RSI_SHORT_MIN, cooldownMins:DIRECTION_COOLDOWN_MINS, fibEntryFilter:false, premiumStopPct:null, trailTriggerPct:null, trailDistancePct:null };
}

// Scores market signals and sets MARKET_MODE. Safe to call repeatedly — idempotent within same day.
// When MARKET_MODE_AUTO=OFF: classifies and logs but does not change any active parameters.
function detectMarketMode() {
  try {
    let score = 0;
    const reasons = [];

    // Signal 1: GEX sign/magnitude (weight ×2) — most reliable signal
    if (gexCache?.netGex != null) {
      const g = gexCache.netGex;
      // ANY positive net GEX is a pinning (chop) regime — dealers are long gamma and
      // suppress moves. The old $0-2B "neutral" band scored 0 and let a genuine pin day
      // (2026-07-13 AM lived in that band) drift to NEUTRAL/TREND. Removed: positive now
      // always votes CHOP, scaled by magnitude.
      if      (g < -1e9) { score += 2; reasons.push("GEX<-$1B (dealer short-gamma, trend) +2"); }
      else if (g < 0)    { score += 1; reasons.push("GEX neg (mild trend bias) +1"); }
      else if (g > 4e9)  { score -= 2; reasons.push("GEX>$4B (strong pinning) -2"); }
      else               { score -= 1; reasons.push("GEX>$0 (dealer long-gamma, pinning) -1"); }
    } else { reasons.push("GEX unavailable"); }

    // Signal 2: VEX — use percentile rank when available (normalised vs last 5 days),
    // fall back to absolute thresholds only when there is insufficient history (<5 snapshots).
    if (gexCache?.vex != null) {
      const pct = gexCache.vexPctRank; // null when <5 historical records exist
      const vB  = (gexCache.vex / 1e9).toFixed(1);
      if (pct != null) {
        // Percentile path — context-aware
        if      (pct >= 80) { score += 2; reasons.push("VEX "+vB+"B p"+pct+" HIGH (vol demand, big move) +2"); }
        else if (pct >= 60) { score += 1; reasons.push("VEX "+vB+"B p"+pct+" ELEVATED +1"); }
        else if (pct <= 20) { score -= 1; reasons.push("VEX "+vB+"B p"+pct+" LOW (vol suppressed) -1"); }
        else                { reasons.push("VEX "+vB+"B p"+pct+" NORMAL"); }
      } else {
        // Fallback — absolute thresholds (used only until 5+ snapshots accumulate)
        const v = gexCache.vex;
        if      (v > 1e9)  { score += 2; reasons.push("VEX "+vB+"B HIGH (no history yet) +2"); }
        else if (v > 5e8)  { score += 1; reasons.push("VEX "+vB+"B ELEVATED (no history yet) +1"); }
        else if (v < 0)    { score -= 1; reasons.push("VEX "+vB+"B NEGATIVE (no history yet) -1"); }
      }
    }

    // Signal 3: Overnight gap vs prior close (needs prevDayData)
    if (prevDayData && orbState?.built) {
      const todayOpen = orbState.open || (orbState.high + orbState.low) / 2;
      const gapPct = Math.abs((todayOpen - prevDayData.close) / prevDayData.close * 100);
      if      (gapPct > 0.5)  { score += 1; reasons.push("Gap "+gapPct.toFixed(2)+"% large +1"); }
      else if (gapPct < 0.1)  { score -= 1; reasons.push("Gap "+gapPct.toFixed(2)+"% tiny -1"); }
      else                    { reasons.push("Gap "+gapPct.toFixed(2)+"% neutral"); }
    }

    // Signal 4: ORB range as % of 5-day ADR
    if (prevDayData?.adr5 && orbState?.built) {
      const orbRange  = orbState.high - orbState.low;
      const orbPctADR = orbRange / prevDayData.adr5;
      if      (orbPctADR > 0.45) { score += 1; reasons.push("ORB "+(orbPctADR*100).toFixed(0)+"% ADR wide +1"); }
      else if (orbPctADR < 0.20) { score -= 1; reasons.push("ORB "+(orbPctADR*100).toFixed(0)+"% ADR tight -1"); }
      else                       { reasons.push("ORB "+(orbPctADR*100).toFixed(0)+"% ADR normal"); }
    }

    // Signal 5: TTM Squeeze — price-action confirmation of the compression/expansion
    // cycle the exposure metrics see from the positioning side
    if (squeezeState.date) {
      if      (squeezeState.fired)      { score += 1; reasons.push("Squeeze fired "+(squeezeState.direction||"")+" (expansion beginning) +1"); }
      else if (squeezeState.barsOn >= 6){ score -= 1; reasons.push("Squeeze on "+squeezeState.barsOn+" bars (compression) -1"); }
      else                              { reasons.push("Squeeze neutral"); }
    }

    marketScore = score;
    // FIX #1 (2026-08-06): TREND now needs score >= TREND_MIN_SCORE (3, was 2). The v11.14
    // classifier fix flipped 78% of trades into TREND, whose scalp profile cut winners small
    // and took tight-stop losses (net +$718 before → -$2013 after). Raising the bar sends
    // most negative-GEX days back to the NEUTRAL "run to TP1" profile that was actually winning.
    let classified = score >= TREND_MIN_SCORE ? "TREND" : score <= -2 ? "CHOP" : "NEUTRAL";

    // Pin floor: positive GEX with VWAP on the gamma flip = pin/chop, never TREND.
    if (classified === "TREND" && gexCache?.netGex > 0 && gexCache?.gammaFlip != null &&
        lastVwap != null && Math.abs(lastVwap - gexCache.gammaFlip) < GEX_BUFFER) {
      reasons.push("PIN FLOOR: +GEX & VWAP $"+lastVwap.toFixed(2)+" on flip $"+gexCache.gammaFlip+" — capped TREND→NEUTRAL");
      classified = "NEUTRAL";
    }
    // FIX #3 (2026-08-06): Magnet-pin override. A strong 0DTE magnet pulling price to it is a
    // REVERTING (chop) day even on negative GEX — the tape pins, it doesn't trend. If VWAP is
    // within MAGNET_RANGE of the 0DTE magnet, it's not a trend: cap TREND→NEUTRAL so we use the
    // wide stop / run-to-TP1 profile instead of the scalp. Directly targets the 7/23 & 8/6
    // reverting-short days (negative GEX, price pinned to the magnet).
    if (classified === "TREND" && gexCache?.zeroDteMagnet != null && lastVwap != null &&
        Math.abs(lastVwap - gexCache.zeroDteMagnet) < MAGNET_RANGE) {
      reasons.push("MAGNET PIN: VWAP $"+lastVwap.toFixed(2)+" within $"+MAGNET_RANGE+" of 0DTE magnet $"+gexCache.zeroDteMagnet+" — capped TREND→NEUTRAL (reverting, not trending)");
      classified = "NEUTRAL";
    }

    const active = MARKET_MODE_OVERRIDE || (MARKET_MODE_AUTO === "ON" ? classified : "NEUTRAL");
    const changed = active !== MARKET_MODE;
    MARKET_MODE = active;
    marketModeDate = new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});

    log("MARKET","Mode: "+classified+" (score:"+score+") — AUTO:"+MARKET_MODE_AUTO+" ACTIVE:"+active+" — "+reasons.join(" | "));
    if (MARKET_MODE_AUTO === "OFF") log("MARKET","[DRY-RUN] Set MARKET_MODE_AUTO=ON in Railway env to activate dynamic parameters");

    broadcast({ type:"market_mode", mode:active, classified, score, auto:MARKET_MODE_AUTO==="ON", reasons });
    if (changed) log("MARKET","Mode changed → "+active+(MARKET_MODE_AUTO==="ON"?" (params applied)":" (dry-run, no effect)"));
    saveModeState();
    broadcastHealth();
  } catch(e) { log("MARKET ERR","detectMarketMode: "+e.message); }
}

// Persist mode state so a mid-day restart resumes the last classification instead of
// snapping to NEUTRAL until the next scan. Small single-object file on the DB volume.
const MODE_STATE_FILE = path.join(DB_DIR, "mode_state.json");
function saveModeState(){
  try{ fs.writeFileSync(MODE_STATE_FILE, JSON.stringify({ mode:MARKET_MODE, score:marketScore, date:marketModeDate })); }
  catch(e){ console.error("[MODE ERR] saveModeState:", e.message); }
}
function restoreModeState(){
  try{
    if(!fs.existsSync(MODE_STATE_FILE)) return;
    const s=JSON.parse(fs.readFileSync(MODE_STATE_FILE,"utf8"));
    const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
    if(s.date===today){
      MARKET_MODE=s.mode; marketScore=s.score; marketModeDate=s.date;
      log("RECOVER","Mode restored from disk → "+MARKET_MODE+" (score "+marketScore+") — survives mid-day restart");
    }
  }catch(e){ log("RECOVER ERR","restoreModeState: "+e.message); }
}

async function runSignalEngine() {
  if(scanActive) return;
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(),m=now.getMinutes();

  // Only run during market hours, after ORB period
  if(!((h>9||(h===9&&m>=45))&&h<15||(h===15&&m<=44))) return;

  scanActive=true;
  try{
    const bars=await getSPYBars();
    // Alpaca timestamps bars at their OPEN. Exclude a bar until its full five-minute
    // interval has elapsed so an in-progress candle is never marked processed as final.
    const closedBars=bars.filter(b=>new Date(b.t).getTime()+5*60000<=Date.now());
    if(!closedBars.length){scanActive=false;return;}

    // Build ORB if not built yet
    buildORB(closedBars);
    if(!orbState?.built){log("SCAN","ORB not built yet — waiting");scanActive=false;return;}

    // Market mode: classify once after ORB builds, re-check at 11:00 AM
    const today=now.toLocaleDateString("en-CA");
    if(marketModeDate!==today || (h===11&&m===0)) detectMarketMode();

    // Get latest bar
    const latestBar=closedBars[closedBars.length-1];
    if(lastBarTime===latestBar.t){scanActive=false;return;}
    lastBarTime=latestBar.t;

    // Get live quote
    const currentPrice=await getSPYQuote()||latestBar.c;
    const ind=calcIndicators(closedBars,currentPrice);
    if(!ind){scanActive=false;return;}

    // Check if already in a trade
    const activeTrades=signalHistory.filter(s=>["FILLED","SENT","EXECUTING"].includes(s.status));
    if(activeTrades.length>0){
      // TREND-mode structure exit: a 5-min bar close through VWAP against the position
      // means the trend thesis is dead — flag it; the 30s monitor executes the close.
      // RSI confirm (back through 50) filters single-bar VWAP fakeouts.
      if(ind.vwap){
        for(const t of activeTrades){
          if(t.status!=="FILLED" || t.modeAtFill!=="TREND" || t.vwapExit) continue;
          const barClose=latestBar.c;
          const crossed = t.direction==="LONG"
            ? (barClose < ind.vwap && (ind.rsi==null || ind.rsi < 50))
            : (barClose > ind.vwap && (ind.rsi==null || ind.rsi > 50));
          if(crossed){
            t.vwapExit=true;
            log("TREND","VWAP-cross exit flagged: "+t.optionSymbol+" — 5m close $"+barClose.toFixed(2)+
              (t.direction==="LONG"?" below":" above")+" VWAP $"+ind.vwap.toFixed(2)+" | RSI "+ind.rsi);
          }
        }
      }
      log("SCAN","Bar "+latestBar.t.slice(11,16)+" | SPY $"+currentPrice.toFixed(2)+" | Position open — skipping");
      scanActive=false;return;
    }

    // Cooldown after stop-loss
    if(lastStopTime && (Date.now()-lastStopTime)<COOLDOWN_MS){
      const remain=Math.ceil((COOLDOWN_MS-(Date.now()-lastStopTime))/60000);
      log("SCAN","Cooldown active — "+remain+" min remaining after last stop");
      scanActive=false;return;
    }

    // Post-TP1 cooldown — the move is usually exhausted right after a TP1 win; re-entering
    // chases it. Blocks ALL new entries for POST_TP1_COOLDOWN_MINS after a TP1 (0 disables).
    if(POST_TP1_COOLDOWN_MINS>0 && lastTP1Time && (Date.now()-lastTP1Time)<POST_TP1_COOLDOWN_MINS*60000){
      const remain=Math.ceil((POST_TP1_COOLDOWN_MINS*60000-(Date.now()-lastTP1Time))/60000);
      log("SCAN","Post-TP1 cooldown — "+remain+" min remaining (avoid chasing exhausted move)");
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

    // Daily per-direction lockout — hard cap on losses in one direction per day
    if(dirLockedToday[eval_result.direction]){
      log("SCAN","Direction LOCKED for the day: "+eval_result.direction+" — hit "+MAX_DIR_LOSSES_DAY+" losses");
      saveSignalToDB({direction:eval_result.direction,spyEntry:currentPrice,gexTarget:null,strength:eval_result.strength},{...ind},false,"LOCKOUT: "+eval_result.direction+" hit "+MAX_DIR_LOSSES_DAY+" losses today");
      scanActive=false;return;
    }

    // Direction-specific cooldown check
    if(DIRECTION_COOLDOWN==="ON"){
      const cd=dirCooldownUntil[eval_result.direction]||0;
      if(Date.now()<cd){
        const remain=Math.ceil((cd-Date.now())/60000);
        log("SCAN","Direction cooldown: "+eval_result.direction+" blocked ("+remain+" min) — 2 consecutive stops");
        saveSignalToDB({direction:eval_result.direction,spyEntry:currentPrice,gexTarget:null,strength:eval_result.strength},{...ind},false,"COOLDOWN: "+eval_result.direction+" blocked "+remain+"m after 2 stops");
        scanActive=false;return;
      }
    }

    // CHEX EOD bias filter — after 1 PM, charm decay forces directional MM hedging into close
    // Positive CHEX: MMs gain delta as time passes → must sell to stay neutral → headwind for LONGs
    // Negative CHEX: MMs lose delta as time passes → must buy to stay neutral → headwind for SHORTs
    if(h>=13 && gexCache?.chex!=null){
      const CHEX_THRESHOLD=5e9; // $5B — filters only meaningful charm flow, not noise
      const chex=gexCache.chex;
      if(eval_result.direction==="LONG" && chex>CHEX_THRESHOLD){
        const reason="CHEX +" + (chex/1e9).toFixed(1)+"B after 1PM — MM charm decay selling into close";
        log("GEX","CHEX EOD filter: LONG skipped — "+reason);
        saveSignalToDB({direction:eval_result.direction,spyEntry:currentPrice,gexTarget:null,strength:eval_result.strength},{...ind},false,"CHEX: "+reason);
        scanActive=false;return;
      }
      if(eval_result.direction==="SHORT" && chex<-CHEX_THRESHOLD){
        const reason="CHEX "+(chex/1e9).toFixed(1)+"B after 1PM — MM charm decay buying into close";
        log("GEX","CHEX EOD filter: SHORT skipped — "+reason);
        saveSignalToDB({direction:eval_result.direction,spyEntry:currentPrice,gexTarget:null,strength:eval_result.strength},{...ind},false,"CHEX: "+reason);
        scanActive=false;return;
      }
    }

    // GEX freshness is handled by the 15-min scheduled refresh (GEX_SCHEDULE), NOT a
    // per-scan refresh — the old per-scan getGEX fired a 5-call FA fetch on nearly every
    // 5-min scan (~375 calls/day), a major contributor to blowing the 2500/day quota on
    // 2026-07-13. Only refresh here as a last resort if the cache is truly stale (>20 min),
    // and never when the quota breaker is tripped.
    if(!tradeEchoQuotaBlocked && (!gexCache || (Date.now()-gexCacheTime)>1200000)){
      try{ await getGEX(false); }catch(e){ log("GEX ERR","pre-signal refresh: "+e.message); }
    }

    // Apply GEX filter (walls, flip, magnet, DEX bias, VWAP-on-flip pin)
    const gexResult=applyGEX(eval_result.direction,currentPrice,ind.vwap);
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

// ── Recover open positions on restart ─────────────────────────────────────────
// When the bot restarts mid-day (e.g. redeploy), any 1DTE positions bought after 2:30 PM
// the prior day will still be open in Alpaca. Re-attach monitors so they can be stopped out
// or trailed rather than running unmonitored until the position is closed manually.
async function recoverPositions(){
  try{
    const positions=await aGet("/v2/positions");
    const spyOpts=positions.filter(p=>/^SPY\d{6}[CP]\d{8}$/.test(p.symbol));
    if(!spyOpts.length){log("RECOVER","No open SPY option positions");return;}
    log("RECOVER","Found "+spyOpts.length+" open SPY option position(s) — re-attaching monitors");
    // The original entry-time indicators died with the crashed process. Attach CURRENT market
    // context (today's ORB + live VWAP/RSI/EMA) so the recovered open-position card isn't blank
    // — for an open position, live context is what you want to see anyway.
    let liveInd={};
    try{ const b=await getSPYBars(); if(b.length) liveInd=calcIndicators(b, await getSPYQuote()||b[b.length-1].c)||{}; }
    catch(e){ log("RECOVER","indicator snapshot failed: "+e.message); }
    for(const pos of spyOpts){
      const alreadyTracked=signalHistory.find(s=>s.optionSymbol===pos.symbol&&["FILLED"].includes(s.status));
      if(alreadyTracked) continue; // already monitored
      const avgEntry=parseFloat(pos.avg_entry_price||0);
      if(!avgEntry) continue;
      const right=pos.symbol[9];
      const dir=right==="C"?"LONG":"SHORT";
      const contracts=parseInt(pos.qty||1);
      const stop=parseFloat((avgEntry*(1-PREMIUM_STOP_PCT)).toFixed(2));
      const tp1=calcTP1(avgEntry);
      const recovered={
        id:Date.now(),
        time:new Date().toLocaleTimeString("en-US",{hour12:false,timeZone:"America/New_York"}),
        symbol:"SPY", direction:dir, right,
        strike: parseInt(pos.symbol.slice(-8))/1000,   // OCC strike (fixes "$undefined PUT" header)
        optionSymbol:pos.symbol, contracts,
        fillPrice:avgEntry, midPrice:avgEntry,
        // SPY-underlying row: stop = today's ORB low (available); entry-time SPY price and the
        // GEX walls at entry are genuinely lost on recovery, so ENTRY/TRAIL/WALL stay blank.
        spyEntry:null, stop: liveInd.orbLow ?? null, tp1:null, tp2:null,
        stopPrice:stop, tp1Price:tp1,
        status:"FILLED", trigger:"Recovered on restart",
        is2DTE:true, expiry:pos.symbol.slice(3,9),
        confidence:"MEDIUM",
        indicators:{ vwap:liveInd.vwap, rsi:liveInd.rsi, ema9:liveInd.ema9, ema21:liveInd.ema21,
                     orbHigh:liveInd.orbHigh, orbLow:liveInd.orbLow, live:true },
      };
      signalHistory.unshift(recovered);
      tradesDay++; // an open position is a trade taken today but not yet in the trades DB
      log("RECOVER","Re-monitoring "+pos.symbol+" x"+contracts+" @ $"+avgEntry+" | stop $"+stop);
      startMonitor(recovered, recovered.indicators);
    }
  }catch(e){ log("RECOVER ERR","recoverPositions: "+e.message); }
}

// ── Reconstruct day P&L / risk state after a mid-day restart ──────────────────
// sessionPnL, dailyLoss and tradesDay live only in memory and start at 0 on every
// process launch. A mid-day redeploy therefore zeroes the day's realized P&L display
// AND, critically, the daily-loss circuit breaker and max-trades-per-day cap — the bot
// would forget it was already down for the day. Rebuild all three from today's persisted
// trades so the accounting and safety limits survive restarts.
// Classifier health — the market-mode classifier's primary, highest-weighted input is
// net GEX. When GEX is missing/stale/quota-blocked the classifier still runs but is flying
// on secondary signals only (degraded). Surface this so the dashboard can warn loudly.
function classifierHealth(){
  const now=Date.now();
  const ageMin = gexCacheTime ? Math.round((now-gexCacheTime)/60000) : null;
  const staleAfter = Math.max(GEX_REFRESH_MINS*3, 20); // >3 refresh cycles (min 20m) = stale
  const available = !!(gexCache && gexCache.netGex != null);
  const stale = available && ageMin != null && ageMin > staleAfter;
  let status="OK", reason="GEX live";
  if (tradeEchoQuotaBlocked) { status="FAILED"; reason="TradeEcho 20-request/hour cap reached — classifier paused until next hour"; }
  else if (!available)     { status="FAILED";   reason="No GEX data — classifier running without its primary signal"; }
  else if (stale)          { status="DEGRADED"; reason="GEX stale ("+ageMin+"m old) — classifier may be acting on outdated regime"; }
  return { status, reason, gexAvailable:available, gexAgeMin:ageMin, gexStale:stale,
           quotaBlocked:tradeEchoQuotaBlocked, marketMode:MARKET_MODE, marketScore, auto:MARKET_MODE_AUTO==="ON" };
}
function broadcastHealth(){ try{ broadcast({ type:"health", ...classifierHealth() }); }catch(_){} }

function reconstructDayState(){
  try{
    const today=new Date().toLocaleDateString("en-CA",{timeZone:"America/New_York"});
    const todays=loadDB("trades").filter(t=>t.date===today);
    if(!todays.length){log("RECOVER","No prior trades today — day state starts clean");return;}
    sessionPnL = todays.reduce((a,t)=>a+(t.pnl||0),0);
    dailyLoss  = todays.reduce((a,t)=>a+(t.pnl<0?Math.abs(t.pnl):0),0);
    tradesDay  = todays.length;
    // Rebuild the daily per-direction loss lockout so it survives a mid-day restart too —
    // otherwise a redeploy would forget a direction was locked and let the bleed resume.
    dirLossesToday = { LONG:0, SHORT:0 };
    for(const t of todays){ if(t.pnl<0 && (t.direction==="LONG"||t.direction==="SHORT")) dirLossesToday[t.direction]++; }
    dirLockedToday = { LONG: dirLossesToday.LONG>=MAX_DIR_LOSSES_DAY, SHORT: dirLossesToday.SHORT>=MAX_DIR_LOSSES_DAY };
    // Rebuild signalHistory (the array the dashboard cards + stats render from) from today's
    // persisted trades — otherwise after a restart the live view shows only the 1 recovered
    // open position ("Trades today: 1") while tradesDay says 8. Map each trade row to a
    // closed signal-card shape so cards, win/loss counts and signals-derived P&L all match.
    const cards = todays
      .slice().sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp))
      .map(t=>({
        id: t.signal_id || Date.parse(t.timestamp)||Date.now(),
        time: t.time, symbol:"SPY", direction: t.direction, right: t.right_type,
        strike: t.strike, optionSymbol: t.symbol, contracts: t.contracts,
        spyEntry: t.spy_price ?? null, fillPrice: t.fill_price,
        stopPrice: t.stop_price, tp1Price: t.tp1_price,
        closePrice: t.close_price, closePnl: t.pnl, closeReason: t.close_reason,
        maxPrice: t.max_price, minPrice: t.min_price,
        outcome: t.outcome, status: /TP1/.test(t.close_reason||"") ? "TP1_HIT" : (/EOD/.test(t.close_reason||"")?"EOD_CLOSED":"STOPPED"),
        indicators:{ vwap:t.vwap_at_entry, rsi:t.rsi_at_entry, ema9:t.ema9_at_entry, orbHigh:t.orb_high, orbLow:t.orb_low },
        recovered:true,
      }));
    // newest first (matches the live unshift convention); recoverPositions prepends the open one after
    signalHistory = cards.reverse();
    log("RECOVER","Day state rebuilt from "+todays.length+" trade(s) today — sessionPnL $"+sessionPnL.toFixed(2)+" | dailyLoss $"+dailyLoss.toFixed(2)+" | tradesDay "+tradesDay+
      " | cards "+signalHistory.length+" | dir losses L:"+dirLossesToday.LONG+" S:"+dirLossesToday.SHORT+(dirLockedToday.LONG?" [LONG LOCKED]":"")+(dirLockedToday.SHORT?" [SHORT LOCKED]":""));
  }catch(e){ log("RECOVER ERR","reconstructDayState: "+e.message); }
}

// ── EOD force close ───────────────────────────────────────────────────────────
async function forceCloseAll(){
  // Close EVERYTHING at EOD — 0DTE AND 1DTE. Overnight 1DTE holds were 0-for-2 (both gapped
  // through their stops at the open, e.g. the 748C on 2026-07-22 opened -49.6%). The 1DTE-
  // after-2:30 switch still gives theta protection in the final 90 min, but we now exit the
  // same day at 3:45 rather than carrying unmonitored overnight gap risk.
  const active=signalHistory.filter(s=>["FILLED","SENT"].includes(s.status));
  if(!active.length){log("EOD","No positions to close");return;}
  log("EOD","Force closing "+active.length+" position(s) (0DTE + 1DTE — no overnight holds)");
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
app.set("trust proxy", true); // Railway is behind a proxy — needed for correct client IP in rate limiter
app.use(cors({origin:"*",methods:["GET","POST","DELETE","OPTIONS"],allowedHeaders:["Content-Type","Authorization"]}));
app.options("*",cors());

// ── Rate limiting (in-memory, per-IP fixed window; no dependency) ─────────────
// Protects against public scraping/abuse of the data + control endpoints.
const DASH_USER = process.env.DASHBOARD_USER || "admin";
const DASH_PASS = process.env.DASHBOARD_PASS || "";        // unset = OPEN (warned at startup)
// Scoped, read-only log token — grants ONLY /logs (via X-Log-Token header), nothing else.
// Lets an operator/agent pull logs without handing over the master dashboard password;
// if it leaks it exposes read-only logs, not settings or close-all.
const LOG_TOKEN = process.env.LOG_TOKEN || "";
const RATE_MAX  = parseInt(process.env.RATE_LIMIT_PER_MIN || "120"); // requests/IP/min
const rlBuckets = new Map(); // ip -> { count, resetAt }
setInterval(()=>{ const now=Date.now(); for(const [ip,b] of rlBuckets) if(b.resetAt<now) rlBuckets.delete(ip); }, 120000).unref?.();
app.use((req,res,next)=>{
  const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
  const now=Date.now();
  let b=rlBuckets.get(ip);
  if(!b || b.resetAt<now){ b={count:0, resetAt:now+60000}; rlBuckets.set(ip,b); }
  b.count++;
  if(b.count>RATE_MAX){
    res.set("Retry-After", Math.ceil((b.resetAt-now)/1000));
    return res.status(429).json({error:"rate limit exceeded"});
  }
  next();
});

// ── HTTP Basic Auth — password wall over the whole app ────────────────────────
// When DASHBOARD_PASS is set, every route (dashboard, SSE, DB reads, settings,
// close-all) requires credentials. The browser caches them for the origin, so SSE
// /events authenticates automatically after the first prompt. Timing-safe compare.
function timingSafeEq(a,b){
  const ab=Buffer.from(a), bb=Buffer.from(b);
  if(ab.length!==bb.length) return false;
  try{ return require("crypto").timingSafeEqual(ab,bb); }catch{ return false; }
}
// Health check must stay public — Railway's healthcheckPath ("/") probes it unauthenticated
// to decide whether to route traffic. A 401 here makes Railway mark the deploy unhealthy and
// pull it out of rotation (the whole site goes dark). This endpoint leaks nothing sensitive.
const AUTH_EXEMPT = new Set(["/","/healthz"]);
app.get("/healthz",(req,res)=>res.json({ok:true}));
app.use((req,res,next)=>{
  if(!DASH_PASS) return next(); // no password configured → open (startup warns loudly)
  if(req.method==="GET" && AUTH_EXEMPT.has(req.path)) return next(); // liveness probe only
  // Scoped log token: valid X-Log-Token grants /logs only (read-only), bypassing Basic Auth.
  if(req.path==="/logs" && LOG_TOKEN){
    const tok=req.headers["x-log-token"]||"";
    if(tok && timingSafeEq(tok, LOG_TOKEN)) return next();
  }
  const hdr=req.headers.authorization||"";
  if(hdr.startsWith("Basic ")){
    const [u,p]=Buffer.from(hdr.slice(6),"base64").toString().split(":");
    if(u!=null && p!=null && timingSafeEq(u,DASH_USER) && timingSafeEq(p,DASH_PASS)) return next();
  }
  res.set("WWW-Authenticate",'Basic realm="SPX COMMAND", charset="UTF-8"');
  return res.status(401).json({error:"authentication required"});
});

app.use(express.json());

app.get("/",(req,res)=>res.json({
  service:"SPX COMMAND",version:APP_VERSION,status:"running",
  mode:IS_PAPER?"PAPER":"LIVE",signalMode:SIGNAL_MODE,marketMode:MARKET_MODE,
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
  res.setHeader("X-Accel-Buffering","no"); // disable Nginx buffering on Railway — without this, SSE events are held in proxy buffer and the dashboard stays stuck on "connecting..."
  res.flushHeaders();
  sseClients.push(res);
  // Send init — on any serialization error, fall back to a minimal payload so the
  // client always receives *something* and transitions out of "CONNECTING..." state.
  try {
    const initPayload = sanitizeForBroadcast({
      type:"init",sessionPnL,dailyLoss,signals:signalHistory,
      gex:gexCache,expiry:getExpiry(),riskBudget:getRiskBudget(),
      logs:logHistory,orb:orbState,signalMode:SIGNAL_MODE,
      marketMode:MARKET_MODE,marketScore,marketModeAuto:MARKET_MODE_AUTO,
    });
    res.write("data: "+JSON.stringify(initPayload)+"\n\n");
  } catch(e) {
    console.error("[SSE INIT ERR] "+e.message+" — sending minimal init");
    try {
      res.write("data: "+JSON.stringify({
        type:"init",sessionPnL,dailyLoss,signals:[],
        gex:null,expiry:getExpiry(),riskBudget:getRiskBudget(),
        logs:[],orb:orbState,signalMode:SIGNAL_MODE,
      })+"\n\n");
    } catch(_) {}
  }
  // Heartbeat every 15s — keeps the connection alive under Railway's edge idle timeout so
  // the dashboard doesn't drop into "reconnecting" during quiet periods. Also tell the
  // browser to wait 3s before its own reconnect (belt-and-suspenders with client backoff).
  res.write("retry: 3000\n\n");
  const ping=setInterval(()=>{try{res.write(": ping\n\n");}catch(_){clearInterval(ping);}},15000);
  const cleanup=()=>{clearInterval(ping);sseClients=sseClients.filter(c=>c!==res);};
  req.on("close",cleanup); res.on("close",cleanup); res.on("error",cleanup);
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
  const all=loadDB("trades").reverse();
  const limit=req.query.limit?parseInt(req.query.limit):null;
  const rows=limit?all.slice(0,limit):all;
  res.json({count:rows.length,total:all.length,trades:rows});
});

app.get("/db/signals",(req,res)=>{
  const limit=parseInt(req.query.limit||"100");
  const rows=loadDB("signals").reverse().slice(0,limit);
  res.json({count:rows.length,signals:rows});
});

// Blocked-signal outcome analysis — are our entry guards blocking would-be winners?
// For each blocked directional signal, replay the same-day SPY path forward and check
// whether price moved far enough in the signal's direction (a "would-win") before moving
// against it by a stop-equivalent, grouped by which guard blocked it. PROXY: SPY-move
// stand-in for option P&L (no historical premiums), sampled at scan cadence — relative
// screen, not a backtest. Mirrors scripts/blocked-analysis.js.
function analyzeBlockedSignals(signals, {win=1.2, stop=0.5, windowMin=45, days=14}={}){
  const categorize = (reason="")=>{
    const r=reason.toLowerCase();
    if(/no orb breakout|no rsi|no vwap/.test(r)) return null;
    if(/pinned to gamma flip/.test(r)) return "VWAP-on-flip pin";
    if(/within \$0\.50 of gamma flip|regime indetermin/.test(r)) return "Gamma-flip proximity";
    if(/pin risk/.test(r)) return "Pin-risk score";
    if(/magnet/.test(r)) return "0DTE magnet proximity";
    if(/dex bullish|dex bearish|conflicts with/.test(r)) return "DEX direction (RETIRED)";
    if(/wall|upside target|downside target/.test(r)) return "Wall target / no room";
    if(/no gex cache|fail-closed/.test(r)) return "Fail-closed (no GEX)";
    if(/weekend|holiday/.test(r)) return "Weekend/holiday block";
    if(/chex/.test(r)) return "CHEX EOD filter";
    if(/cooldown/.test(r)) return "Direction cooldown";
    if(/max .*trades|trades\/day/.test(r)) return "Max trades/day";
    if(/daily loss/.test(r)) return "Daily loss limit";
    if(/rsi .*\[mode:/.test(r)){ const m=r.match(/\[mode:(\w+)/); return "RSI reject ("+(m?m[1].toUpperCase():"?")+")"; }
    if(/rsi/.test(r)) return "RSI reject";
    return "Other";
  };
  const outcome=(dir,entryPx,path,idx)=>{
    const endT=new Date(path[idx].ts).getTime()+windowMin*60000;
    let mfe=0,mae=0;
    for(let j=idx+1;j<path.length;j++){
      if(new Date(path[j].ts).getTime()>endT) break;
      const move=path[j].px-entryPx, fav=dir==="LONG"?move:-move, adv=-fav;
      if(fav>mfe)mfe=fav; if(adv>mae)mae=adv;
      if(fav>=win) return {verdict:"win",mfe,mae};
      if(adv>=stop) return {verdict:"loss",mfe,mae};
    }
    return {verdict:"neutral",mfe,mae};
  };
  const byDay={}; for(const s of signals){ (byDay[s.date] ||= []).push(s); }
  const dayKeys=Object.keys(byDay).sort().slice(-days);
  const cats={}; let analyzed=0;
  for(const day of dayKeys){
    const rows=byDay[day].filter(r=>r.spy_price!=null).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    const path=rows.map(r=>({ts:r.timestamp,px:r.spy_price}));
    rows.forEach((r,i)=>{
      if(r.fired) return;
      if(r.direction!=="LONG"&&r.direction!=="SHORT") return;
      const cat=categorize(r.blocked_reason); if(!cat) return;
      const o=outcome(r.direction,r.spy_price,path,i);
      const c=(cats[cat] ||= {n:0,win:0,loss:0,neutral:0,mfeSum:0,maeSum:0});
      c.n++; c[o.verdict]++; c.mfeSum+=o.mfe; c.maeSum+=o.mae; analyzed++;
    });
  }
  const table=Object.entries(cats).sort((a,b)=>b[1].n-a[1].n).map(([cat,c])=>({
    guard:cat, n:c.n,
    wouldWinPct:Math.round(c.win/c.n*100), wouldLossPct:Math.round(c.loss/c.n*100),
    neutralPct:Math.round(c.neutral/c.n*100),
    avgMFE:+(c.mfeSum/c.n).toFixed(2), avgMAE:+(c.maeSum/c.n).toFixed(2),
  }));
  return { params:{win,stop,windowMin,days}, daysCovered:dayKeys, analyzed, table,
    note:"high wouldWinPct = guard blocked winners (too conservative); high wouldLossPct = correctly filtered losers. SPY-move proxy, scan-cadence sampled." };
}

app.get("/db/blocked-analysis",(req,res)=>{
  const opts={
    win:      parseFloat(req.query.win    ?? "1.2"),
    stop:     parseFloat(req.query.stop   ?? "0.5"),
    windowMin:parseInt  (req.query.window ?? "45"),
    days:     parseInt  (req.query.days   ?? "14"),
  };
  res.json(analyzeBlockedSignals(loadDB("signals"), opts));
});

// Reversal-feature analysis — does any feature predict which entries reverse? For every
// directional signal we replay the forward SPY path (first-touch win/loss), then median-split
// each candidate feature and compare would-win% of the low vs high half. A big gap = the
// feature discriminates reversals. SEGMENTED BY GEX REGIME, because gamma-based signals only
// mean-revert in positive-GEX (pinning) regimes, not negative-GEX (trending) ones.
function analyzeReversalFeatures(signals, {win=1.0, stop=0.5, windowMin=30, days=21}={}){
  const outcome=(dir,px,path,idx)=>{
    const endT=new Date(path[idx].ts).getTime()+windowMin*60000;
    for(let j=idx+1;j<path.length;j++){
      if(new Date(path[j].ts).getTime()>endT) break;
      const fav=dir==="LONG"?path[j].px-px:px-path[j].px;
      if(fav>=win) return 1; if(-fav>=stop) return 0;
    }
    return null; // neutral — excluded from win-rate
  };
  const FEATURES=["percent_b","vwap_dist","gex_path_resist","dex","vex","chex","dex_pct","vex_pct","chex_pct","net_gex","rsi"];
  const byDay={}; for(const s of signals){ (byDay[s.date] ||= []).push(s); }
  const dayKeys=Object.keys(byDay).sort().slice(-days);
  // collect scored signals per regime
  const buckets={ positive:[], negative:[] };
  for(const day of dayKeys){
    const rows=byDay[day].filter(r=>r.spy_price!=null).sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    const path=rows.map(r=>({ts:r.timestamp,px:r.spy_price}));
    rows.forEach((r,i)=>{
      if(r.direction!=="LONG"&&r.direction!=="SHORT") return;
      const o=outcome(r.direction,r.spy_price,path,i);
      if(o===null) return;
      const reg=(r.gex_regime==="positive")?"positive":(r.gex_regime==="negative")?"negative":null;
      if(reg) buckets[reg].push({...r,_win:o});
    });
  }
  const analyzeReg=(rows)=>{
    const out={};
    for(const f of FEATURES){
      const vals=rows.filter(r=>typeof r[f]==="number").map(r=>({v:r[f],w:r._win}));
      if(vals.length<8){ out[f]={n:vals.length,note:"insufficient"}; continue; }
      vals.sort((a,b)=>a.v-b.v);
      const mid=Math.floor(vals.length/2);
      const lo=vals.slice(0,mid), hi=vals.slice(mid);
      const wr=arr=>Math.round(arr.reduce((s,x)=>s+x.w,0)/arr.length*100);
      out[f]={ n:vals.length, median:+vals[mid].v.toFixed(3),
        lowHalfWin:wr(lo), highHalfWin:wr(hi), gap:wr(hi)-wr(lo) };
    }
    return out;
  };
  return { params:{win,stop,windowMin,days}, daysCovered:dayKeys,
    counts:{positive:buckets.positive.length, negative:buckets.negative.length},
    positiveGEX:analyzeReg(buckets.positive), negativeGEX:analyzeReg(buckets.negative),
    note:"For each feature: would-win% of the low half vs high half of that feature. |gap| large (and n>=20) = predictive of reversal in that regime. Gamma features expected to matter in positiveGEX only." };
}

app.get("/db/reversal-analysis",(req,res)=>{
  res.json(analyzeReversalFeatures(loadDB("signals"), {
    win:      parseFloat(req.query.win    ?? "1.0"),
    stop:     parseFloat(req.query.stop   ?? "0.5"),
    windowMin:parseInt  (req.query.window ?? "30"),
    days:     parseInt  (req.query.days   ?? "21"),
  }));
});


app.get("/db/gex",(req,res)=>{
  const rows=loadDB("gex_snapshots").reverse().slice(0,50);
  res.json({count:rows.length,snapshots:rows});
});

// Raw console mirror (what Railway's stdout shows) — for remote diagnostics. Auth: Basic
// Auth OR the scoped X-Log-Token header. ?lines=N (default 300, max 1500), ?grep=regex
// (case-insensitive), ?level=error|warn|log. Newest last (chronological, easy to read).
app.get("/logs",(req,res)=>{
  let out = consoleBuffer;
  const lvl = req.query.level;
  if(lvl) out = out.filter(e=>e.level===lvl);
  if(req.query.grep){
    let re; try{ re=new RegExp(req.query.grep,"i"); }catch{ return res.status(400).json({error:"bad grep regex"}); }
    out = out.filter(e=>re.test(e.line));
  }
  const n = Math.min(parseInt(req.query.lines||"300"), CONSOLE_BUFFER_MAX);
  out = out.slice(-n);
  if(req.query.format==="text"){
    res.type("text/plain").send(out.map(e=>e.t+" ["+e.level+"] "+e.line).join("\n"));
  } else {
    res.json({ count:out.length, bufferSize:consoleBuffer.length, lines:out });
  }
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

// ── Historical backfill from Alpaca account activity ──────────────────────────
// Fetches the last 14 days of FILL activity from Alpaca, pairs SPY option buys
// with their corresponding sells to reconstruct round-trip trades, and inserts
// them into trades.json. Deduplicates by order_id so re-running is safe.
// Bot trades going forward are inserted by saveTradeToDB() — source:"bot".
async function backfillFromAlpaca(days=14) {
  const after = new Date(Date.now() - days*24*60*60*1000).toISOString();
  // Alpaca paginates fills via page_token; collect all pages
  let fills = [];
  let url = "/v2/account/activities?activity_types=FILL&after="+encodeURIComponent(after)+"&direction=asc&page_size=100";
  for (let page=0; page<20; page++) { // cap at 2000 fills
    const data = await aGet(url);
    const items = Array.isArray(data) ? data : [];
    fills = fills.concat(items);
    if (items.length < 100) break;
    url = "/v2/account/activities?activity_types=FILL&after="+encodeURIComponent(after)+"&direction=asc&page_size=100&page_token="+items[items.length-1].id;
  }

  // Filter to SPY options only
  const spyFills = fills.filter(f => /^SPY\d{6}[CP]\d{8}$/.test(f.symbol));

  // Group by (symbol, date) so we can pair buys and sells per day
  const groups = {};
  for (const f of spyFills) {
    const date = (f.transaction_time||"").slice(0,10);
    const key  = f.symbol+"_"+date;
    if (!groups[key]) groups[key] = { symbol:f.symbol, date, buys:[], sells:[] };
    if (f.side==="buy")  groups[key].buys.push(f);
    if (f.side==="sell") groups[key].sells.push(f);
  }

  const existing = loadDB("trades");
  const existingOrderIds = new Set(existing.map(t=>t.alpaca_order_id).filter(Boolean));
  const inserted = [];

  for (const g of Object.values(groups)) {
    // Sort chronologically
    g.buys.sort((a,b)=>new Date(a.transaction_time)-new Date(b.transaction_time));
    g.sells.sort((a,b)=>new Date(a.transaction_time)-new Date(b.transaction_time));

    // Walk buys, pair each with the next available sell
    const sells = [...g.sells];
    for (const buy of g.buys) {
      if (existingOrderIds.has(buy.order_id)) continue; // already in DB

      const entryPrice  = parseFloat(buy.price||0);
      const contracts   = parseInt(buy.qty||1);
      const totalCost   = parseFloat((entryPrice*100*contracts).toFixed(2));
      const sym         = buy.symbol;
      const right       = sym[9]; // C or P
      const direction   = right==="C"?"LONG":"SHORT";
      // Parse OCC expiry YYMMDD → YYYYMMDD
      const yy=sym.slice(3,5), mm=sym.slice(5,7), dd=sym.slice(7,9);
      const expiry = "20"+yy+mm+dd;
      const strikeRaw = parseInt(sym.slice(10))/1000;

      // Find matching sell (next sell not yet consumed)
      const sellIdx = sells.findIndex(s=>parseInt(s.qty||0)<=contracts);
      const sell = sellIdx>=0 ? sells.splice(sellIdx,1)[0] : null;

      let closePrice=null, pnl=null, pnlPct=null, durationMin=null, outcome=null, closeReason=null;
      if (sell) {
        closePrice = parseFloat(sell.price||0);
        pnl = parseFloat(((closePrice-entryPrice)*100*contracts).toFixed(2));
        pnlPct = totalCost>0 ? parseFloat(((pnl/totalCost)*100).toFixed(1)) : null;
        const ms = new Date(sell.transaction_time)-new Date(buy.transaction_time);
        durationMin = parseFloat((ms/60000).toFixed(1));
        outcome = pnl>=0?"WIN":"LOSS";
        closeReason = "ALPACA_HISTORICAL";
      }

      const row = {
        signal_id:      null,
        timestamp:      buy.transaction_time,
        date:           g.date,
        time:           (buy.transaction_time||"").slice(11,19),
        bot:            "ALPACA-ACCOUNT",
        source:         "alpaca-historical",
        alpaca_order_id:buy.order_id,
        symbol:         sym,
        direction,
        right_type:     right,
        strike:         strikeRaw,
        expiry,
        contracts,
        fill_price:     entryPrice,
        total_cost:     totalCost,
        stop_price:     null,
        tp1_price:      null,
        close_price:    closePrice,
        close_reason:   closeReason,
        max_price:      null, // not available for historical trades
        min_price:      null,
        max_pnl_pct:    null,
        min_pnl_pct:    null,
        pnl,
        pnl_pct:        pnlPct,
        duration_min:   durationMin,
        outcome,
        gex_regime:     null,
        gex_flip:       null,
        orb_high:       null,
        orb_low:        null,
        vwap_at_entry:  null,
        rsi_at_entry:   null,
        ema9_at_entry:  null,
        ema21_at_entry: null,
        tp1_mode:       null,
        risk_budget:    null,
        signal_mode:    null,
      };
      insertDB("trades", row);
      existingOrderIds.add(buy.order_id);
      inserted.push(sym+"_"+g.date);
    }
  }
  return { fills_fetched:spyFills.length, groups:Object.keys(groups).length, inserted:inserted.length, trades:inserted };
}

app.post("/admin/backfill-alpaca", async(req,res)=>{
  try {
    const days = parseInt(req.query.days||"14");
    log("ADMIN","Backfill requested — last "+days+" days of Alpaca activity");
    const result = await backfillFromAlpaca(days);
    log("ADMIN","Backfill complete — "+result.inserted+" new trades inserted from "+result.fills_fetched+" SPY fills");
    res.json({ok:true,...result});
  } catch(e) {
    log("ADMIN ERR","Backfill failed: "+e.message);
    res.status(500).json({ok:false,error:e.message});
  }
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
    version:APP_VERSION, mode:IS_PAPER?"PAPER":"LIVE",
    signalMode:SIGNAL_MODE, marketMode:MARKET_MODE, marketScore, marketModeAuto:MARKET_MODE_AUTO,
    SIGNAL_SCAN_MINS, GEX_REFRESH_MINS,
    noTradingView:true,
    exitStrategy:"price-monitor + DELETE /v2/positions",
    riskBudget:"$"+getRiskBudget(),
    optionsFeed:OPTIONS_FEED,
    realGreeks:gexCache?.hasRealGreeks||false,
    tp1Config:{mode:"trail-trigger",value:TRAIL_TRIGGER_DOLLARS>0?"$"+TRAIL_TRIGGER_DOLLARS:"+"+(TRAIL_TRIGGER_PCT*100)+"%"},
    strikeSelection:"immediate $1 strike in signal direction",
    expiry:"2DTE (Alpaca trading calendar)",
    trailingStop:{triggerPct:(TRAIL_TRIGGER_PCT*100)+"%",trailDistance:(TRAIL_DISTANCE_PCT*100)+"%"},
    sessionPnL:sessionPnL.toFixed(2), dailyLoss:dailyLoss.toFixed(2),
    tradeEcho:{enabled:!!TRADEECHO_PAT,requestCount:tradeEchoQuota?.count||0,requestLimit:TRADEECHO_MAX_REQUESTS_HOUR,hour:tradeEchoQuota?.hour||null,quotaBlocked:tradeEchoQuotaBlocked},
    classifierHealth: classifierHealth(),
    dailyLossLimit:(ACCOUNT_SIZE*MAX_DAILY_LOSS).toFixed(2),
    tradesDay:tradesDay+"/"+MAX_TRADES_DAY,
    orb:orbState,
    tradeEchoConfigured:!!TRADEECHO_PAT,
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
// RTH 9:30–16:00 ET — options only trade then, so the monitor has nothing to do outside it.
function isMarketHours(etDate){
  if(!isWeekday(etDate)) return false;
  const mins = etDate.getHours()*60 + etDate.getMinutes();
  return mins >= 9*60+30 && mins < 16*60;
}

// Signal engine: runs on 5-min bar close (every minute, fires when new bar available)
setInterval(async()=>{
  try {
    const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    if(!isWeekday(now)) return;
    const h=now.getHours(),m=now.getMinutes();
    // 5-min bars close at :00, :05, :10, :15, :20, :25, :30, :35, :40, :45, :50, :55
    if(m % SIGNAL_SCAN_MINS === 0){
      await runSignalEngine();
    }
    // Reset daily counters at market open and refresh daily EMA seed with yesterday's close
    if(h===9&&m===30) {
      tradesDay=0; sessionPnL=0; dailyLoss=0;
      orbState=null; lastBarTime=null;
      dirStops.LONG=0; dirStops.SHORT=0;
      dirCooldownUntil.LONG=0; dirCooldownUntil.SHORT=0;
      dirLossesToday.LONG=0; dirLossesToday.SHORT=0;
      dirLockedToday.LONG=false; dirLockedToday.SHORT=false;
      lastStopTime=0; lastTP1Time=0;
      MARKET_MODE="NEUTRAL"; marketScore=0; marketModeDate="";
      log("DAY","New trading day — counters reset");
      await fetchDailyEMAs();
      await fetchPrevDayData();
    }
  } catch(e) { console.error("[SCHEDULER ERR] signal engine tick:", e.message); }
},60000);

// GEX scheduler
setInterval(async()=>{
  try {
    const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    if(!isWeekday(now)) return;
    const h=now.getHours(),m=now.getMinutes();
    const today=now.toLocaleDateString("en-CA");
    if(!((h>9||(h===9&&m>=25))&&h<16)) return;
    const key=today+"_"+h+"_"+m;
    const tradeEchoRefreshMins=Math.max(GEX_REFRESH_MINS,15); // 4 data pulls/hour; leaves budget for MCP setup
    if(m % tradeEchoRefreshMins === 0 && !gexFired.has(key)){
      gexFired.add(key);
      log("GEX","TradeEcho scheduled refresh "+String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+" (every "+tradeEchoRefreshMins+"m; hard cap 20 MCP requests/hour)");
      await getGEX(true);
    }
  } catch(e) { console.error("[SCHEDULER ERR] GEX tick:", e.message); }
},60000);

// EOD 3:45 PM
setInterval(async()=>{
  try {
    const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
    if(!isWeekday(now)) return;
    const h=now.getHours(),m=now.getMinutes();
    if(h===15&&m===45){
      const key=now.toLocaleDateString("en-CA")+"_eod";
      if(!gexFired.has(key)){gexFired.add(key);await forceCloseAll();}
    }
  } catch(e) { console.error("[SCHEDULER ERR] EOD tick:", e.message); }
},60000);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT,async()=>{
  if(DASH_PASS) log("SECURITY","Password wall ACTIVE — Basic Auth required on all routes (user: "+DASH_USER+"). Rate limit "+RATE_MAX+"/min/IP.");
  else log("SECURITY","*** WARNING: DASHBOARD_PASS not set — app is PUBLIC. Set DASHBOARD_PASS in Railway to close it. *** (rate limit "+RATE_MAX+"/min/IP still active)");
  console.log(`
 ╔══════════════════════════════════════════════════════╗
 ║${("  SPX COMMAND v"+APP_VERSION.split("-")[0]+" · TradeEcho · AutoMode").padEnd(54).slice(0,54)}║
 ╠══════════════════════════════════════════════════════╣
 ║  Signal engine : 5-min bar close scan               ║
 ║  Indicators    : ORB(15m) + VWAP + RSI + EMA        ║
 ║  GEX source    : ${(TRADEECHO_PAT?"TradeEcho MCP":"DISABLED").padEnd(35)}║
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
  await fetchDailyEMAs(); // seed EMA9/21 from prior closes — always available from first bar
  await fetchPrevDayData(); // prev session close + 5-day ADR for market mode classifier
  reconstructDayState();    // rebuild sessionPnL/dailyLoss/tradesDay from today's trades (survives mid-day restarts)
  restoreModeState();       // resume last MARKET_MODE instead of snapping to NEUTRAL after a mid-day restart
  await recoverPositions(); // re-attach monitors to any open 1DTE positions from prior session
  const now=new Date(new Date().toLocaleString("en-US",{timeZone:"America/New_York"}));
  const h=now.getHours(),m=now.getMinutes();
  if((h>9||(h===9&&m>=30))&&h<16){
    log("GEX","Market open — calculating initial GEX...");
    await getGEX(true);
  } else {
    log("GEX","Market closed — signal engine starts at 9:45 AM ET");
  }
});
