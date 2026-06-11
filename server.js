/**
 * SPX COMMAND v7 — SPY Long Options + Full Auto Exit
 * ─────────────────────────────────────────────────────────────────────────────
 * TradingView webhook → SPY 0DTE long call/put → Alpaca Paper API
 *
 * KEY CHANGES FROM v6:
 *   • Long options only (no spread) — eliminates naked short margin issue
 *   • Configurable risk per trade: fixed $ amount OR % of account
 *   • Full auto exit: stop loss + TP1 + trailing stop + 3:45 PM force close
 *   • Fixed GEX chain endpoint
 *
 * RISK CONFIG (set ONE of these in Railway env vars):
 *   RISK_DOLLARS    = fixed dollar amount per trade (e.g. 500)
 *   RISK_PER_TRADE  = % of account (e.g. 0.02 = 2%)
 *   If both set, RISK_DOLLARS takes priority.
 *
 * EXIT LOGIC:
 *   Stop loss     = 50% of premium paid (configurable via PREMIUM_STOP_PCT)
 *   TP1           = 100% gain on premium (2× entry price)
 *   Trailing stop = after TP1 hit, stop moves to breakeven (entry price)
 *   Force close   = all open positions closed at 3:45 PM ET
 *
 * ENV VARIABLES:
 *   ALPACA_KEY         ALPACA_SECRET      ALPACA_BASE_URL
 *   ACCOUNT_SIZE       RISK_PER_TRADE     RISK_DOLLARS
 *   MAX_DAILY_LOSS     PREMIUM_STOP_PCT   GEX_BUFFER
 *   PORT
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");

// ── Config ────────────────────────────────────────────────────────────────────
const ALPACA_KEY       = process.env.ALPACA_KEY       || "";
const ALPACA_SECRET    = process.env.ALPACA_SECRET    || "";
const ALPACA_BASE      = (process.env.ALPACA_BASE_URL || "https://paper-api.alpaca.markets").replace(/\/$/, "");
const ALPACA_DATA      = "https://data.alpaca.markets";
const ACCOUNT_SIZE     = parseFloat(process.env.ACCOUNT_SIZE     || "100000");
const RISK_PER_TRADE   = parseFloat(process.env.RISK_PER_TRADE   || "0.02");
const RISK_DOLLARS     = parseFloat(process.env.RISK_DOLLARS     || "0");    // 0 = use % instead
const MAX_DAILY_LOSS   = parseFloat(process.env.MAX_DAILY_LOSS   || "0.06");
const PREMIUM_STOP_PCT = parseFloat(process.env.PREMIUM_STOP_PCT || "0.50");
const GEX_BUFFER       = parseFloat(process.env.GEX_BUFFER       || "1.0");
const PORT             = parseInt(process.env.PORT               || "3001");
const IS_PAPER         = ALPACA_BASE.includes("paper");

// GEX schedule ET
const GEX_SCHEDULE = [
  { h: 9,  m: 25 },
  { h: 10, m: 30 },
  { h: 12, m: 0  },
  { h: 14, m: 0  },
];
const GEX_STALE_MS = 2 * 60 * 60 * 1000;

// ── Risk calculation ──────────────────────────────────────────────────────────
/**
 * Calculate risk budget per trade.
 * Priority: RISK_DOLLARS (fixed $) > RISK_PER_TRADE (% of account)
 */
function getRiskBudget() {
  if (RISK_DOLLARS > 0) return RISK_DOLLARS;
  return ACCOUNT_SIZE * RISK_PER_TRADE;
}

/**
 * Calculate number of contracts based on risk budget and option premium.
 * Max loss = premium paid × 100 (per contract)
 */
function calcContracts(premium) {
  const budget = getRiskBudget();
  if (!premium || premium <= 0) return 1;
  const maxLossPerContract = premium * 100;
  return Math.max(1, Math.floor(budget / maxLossPerContract));
}

// ── State ─────────────────────────────────────────────────────────────────────
let sessionPnL       = 0;
let dailyLoss        = 0;
let signalHistory    = [];
let sseClients       = [];
let gexCache         = null;
let gexCacheTime     = 0;
let gexScheduleFired = new Set();
let gexLastDate      = "";

// ── Utilities ─────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const t = new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
  console.log("[" + t + " ET] [" + tag + "] " + msg);
  broadcast({ type: "log", time: t, tag, msg });
}

function broadcast(payload) {
  const data = "data: " + JSON.stringify(payload) + "\n\n";
  sseClients.forEach(c => { try { c.write(data); } catch (_) {} });
}

function alpacaHeaders() {
  return {
    "APCA-API-KEY-ID":     ALPACA_KEY,
    "APCA-API-SECRET-KEY": ALPACA_SECRET,
    "Content-Type":        "application/json",
    "Accept":              "application/json",
  };
}

async function alpacaGet(path, base) {
  base = base || ALPACA_BASE;
  const res = await fetch(base + path, { headers: alpacaHeaders() });
  if (!res.ok) { const e = await res.text(); throw new Error("Alpaca GET " + path + " " + res.status + ": " + e); }
  return res.json();
}

async function alpacaPost(path, body) {
  const res = await fetch(ALPACA_BASE + path, {
    method: "POST", headers: alpacaHeaders(), body: JSON.stringify(body),
  });
  if (!res.ok) { const e = await res.text(); throw new Error("Alpaca POST " + path + " " + res.status + ": " + e); }
  return res.json();
}

async function alpacaDelete(path) {
  const res = await fetch(ALPACA_BASE + path, { method: "DELETE", headers: alpacaHeaders() });
  if (!res.ok && res.status !== 404) { const e = await res.text(); throw new Error("Alpaca DELETE " + res.status + ": " + e); }
  return res.status;
}

// ── Price helpers ─────────────────────────────────────────────────────────────
// TradingView chart is on SPY — prices arrive directly in SPY range (~$590)
function nearestSPYStrike(spyPrice) {
  return Math.round(spyPrice); // SPY strikes at $1 intervals
}

// ── GEX self-calculation ──────────────────────────────────────────────────────
async function getSPYSpot() {
  try {
    const res = await fetch(ALPACA_DATA + "/v2/stocks/SPY/quotes/latest", { headers: alpacaHeaders() });
    if (!res.ok) return null;
    const data  = await res.json();
    const quote = data.quote || {};
    return parseFloat(quote.ap || quote.bp || 0) || null;
  } catch (_) { return null; }
}

async function fetchSPYChain(expiryStr) {
  try {
    // Correct Alpaca options chain endpoint
    let allContracts = [];
    let nextToken    = null;

    do {
      let url = ALPACA_DATA +
        "/v1beta1/options/contracts?underlying_symbols=SPY" +
        "&expiration_date=" + expiryStr +
        "&status=active&limit=250";
      if (nextToken) url += "&page_token=" + nextToken;

      const res = await fetch(url, { headers: alpacaHeaders() });
      if (!res.ok) {
        log("GEX ERR", "Chain fetch " + res.status + " — " + await res.text());
        break;
      }

      const data = await res.json();
      const contracts = data.option_contracts || [];
      allContracts = allContracts.concat(contracts);
      nextToken    = data.next_page_token || null;

    } while (nextToken);

    log("GEX", "Fetched " + allContracts.length + " SPY contracts for " + expiryStr);
    return allContracts;

  } catch (e) {
    log("GEX ERR", "fetchSPYChain: " + e.message);
    return [];
  }
}

async function fetchGreeksBatch(symbols) {
  const results   = {};
  const batchSize = 100;
  for (let i = 0; i < symbols.length; i += batchSize) {
    const batch = symbols.slice(i, i + batchSize);
    try {
      const res = await fetch(
        ALPACA_DATA + "/v1beta1/options/snapshots?symbols=" + batch.join(","),
        { headers: alpacaHeaders() }
      );
      if (!res.ok) continue;
      const data = await res.json();
      Object.assign(results, data.snapshots || {});
    } catch (_) { continue; }
  }
  return results;
}

async function calculateGEX() {
  try {
    log("GEX", "Calculating GEX from Alpaca chain...");

    const spot = await getSPYSpot();
    if (!spot) { log("GEX ERR", "No SPY spot price — market may be closed"); return null; }
    log("GEX", "SPY spot: $" + spot.toFixed(2));

    const d      = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const expiry = d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");

    const contracts = await fetchSPYChain(expiry);
    if (!contracts.length) { log("GEX ERR", "No contracts — market closed or no 0DTE today"); return null; }

    const symbols   = contracts.map(c => c.symbol).filter(Boolean);
    log("GEX", "Fetching greeks for " + symbols.length + " contracts...");
    const snapshots = await fetchGreeksBatch(symbols);

    const strikeGEX = {};
    for (const contract of contracts) {
      const snap   = snapshots[contract.symbol];
      if (!snap) continue;
      const greeks = snap.greeks || {};
      const gamma  = parseFloat(greeks.gamma || 0);
      const oi     = parseFloat(snap.openInterest || snap.open_interest || contract.open_interest || 0);
      const strike = parseFloat(contract.strike_price || contract.strike || 0);
      const type   = (contract.type || contract.option_type || "").toUpperCase();
      if (!strike || !gamma || !oi) continue;
      const gexVal = gamma * oi * 100 * spot;
      if (!strikeGEX[strike]) strikeGEX[strike] = { call: 0, put: 0 };
      if (type === "C" || type === "CALL") strikeGEX[strike].call += gexVal;
      if (type === "P" || type === "PUT")  strikeGEX[strike].put  -= gexVal;
    }

    const strikes = Object.keys(strikeGEX).map(s => parseFloat(s)).sort((a, b) => a - b);
    if (!strikes.length) { log("GEX ERR", "No GEX calculated — greeks unavailable"); return null; }

    let netGexTotal = 0;
    const levels    = strikes.map(strike => {
      const net = strikeGEX[strike].call + strikeGEX[strike].put;
      netGexTotal += net;
      return { strike, callGex: strikeGEX[strike].call, putGex: strikeGEX[strike].put, netGex: net };
    });

    const callWalls = levels
      .filter(s => s.strike > spot && s.callGex > 0)
      .sort((a, b) => b.callGex - a.callGex)
      .slice(0, 5)
      .map(s => ({ price: s.strike, gex: Math.round(s.callGex) }));

    const putWalls = levels
      .filter(s => s.strike < spot && s.putGex < 0)
      .sort((a, b) => a.putGex - b.putGex)
      .slice(0, 5)
      .map(s => ({ price: s.strike, gex: Math.round(Math.abs(s.putGex)) }));

    let cumulative = 0, gammaFlip = spot;
    for (const level of levels) {
      const prev = cumulative;
      cumulative += level.netGex;
      if ((prev < 0 && cumulative >= 0) || (prev >= 0 && cumulative < 0)) {
        gammaFlip = level.strike;
        break;
      }
    }

    const result = {
      callWalls, putWalls,
      gammaFlip:  parseFloat(gammaFlip.toFixed(2)),
      netGex:     Math.round(netGexTotal),
      regime:     netGexTotal >= 0 ? "positive" : "negative",
      spotPrice:  spot,
      expiry, updatedAt: new Date().toISOString(),
      source: "alpaca-calculated",
    };

    log("GEX", "✓ Regime: " + result.regime.toUpperCase() +
      " | Flip: $" + result.gammaFlip +
      " | Calls: " + callWalls.slice(0,3).map(w => "$" + w.price).join(", ") +
      " | Puts: "  + putWalls.slice(0,3).map(w => "$" + w.price).join(", ") +
      " | Net: " + (netGexTotal >= 0 ? "+" : "") + Math.round(netGexTotal/1e6) + "M"
    );

    broadcast({ type: "gex_update", ...result });
    return result;

  } catch (e) {
    log("GEX ERR", "calculateGEX: " + e.message);
    return null;
  }
}

async function getGEX(forceRefresh) {
  forceRefresh = forceRefresh || false;
  const now    = Date.now();
  const today  = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  if (today !== gexLastDate) {
    gexScheduleFired = new Set();
    gexLastDate      = today;
    gexCache         = null;
    gexCacheTime     = 0;
    log("GEX", "New day — GEX cache reset");
  }

  if (!forceRefresh && gexCache && (now - gexCacheTime) < GEX_STALE_MS) {
    log("GEX", "Cache hit (age: " + Math.round((now - gexCacheTime)/60000) + "min)");
    return gexCache;
  }

  const result = await calculateGEX();
  if (result) { gexCache = result; gexCacheTime = now; }
  return gexCache;
}

function applyGEX(direction, entry, tp1, tp2) {
  if (!gexCache) return { allowed: true, reason: "No GEX — using ORB targets", tp1, tp2, gexTarget: null };

  const gex = gexCache;

  if (direction === "LONG") {
    const wallsAbove = gex.callWalls.filter(w => w.price > entry).sort((a, b) => a.price - b.price);
    if (!wallsAbove.length) return { allowed: true, reason: "No call wall above — using ORB target", tp1, tp2, gexTarget: null };
    const nearest = wallsAbove[0];
    const next    = wallsAbove[1] || { price: nearest.price + (nearest.price - entry) };
    if (nearest.price - entry < GEX_BUFFER) return {
      allowed: false,
      reason: "LONG blocked — $" + entry + " within $" + GEX_BUFFER + " of call wall $" + nearest.price,
      tp1, tp2, gexTarget: nearest.price,
    };
    return { allowed: true, reason: "LONG → call wall $" + nearest.price, tp1: nearest.price, tp2: next.price, gexTarget: nearest.price };
  }

  if (direction === "SHORT") {
    const wallsBelow = gex.putWalls.filter(w => w.price < entry).sort((a, b) => b.price - a.price);
    if (!wallsBelow.length) return { allowed: true, reason: "No put wall below — using ORB target", tp1, tp2, gexTarget: null };
    const nearest = wallsBelow[0];
    const next    = wallsBelow[1] || { price: nearest.price - (entry - nearest.price) };
    if (entry - nearest.price < GEX_BUFFER) return {
      allowed: false,
      reason: "SHORT blocked — $" + entry + " within $" + GEX_BUFFER + " of put wall $" + nearest.price,
      tp1, tp2, gexTarget: nearest.price,
    };
    return { allowed: true, reason: "SHORT → put wall $" + nearest.price, tp1: nearest.price, tp2: next.price, gexTarget: nearest.price };
  }

  return { allowed: true, reason: "No GEX applied", tp1, tp2, gexTarget: null };
}

// ── Account check ─────────────────────────────────────────────────────────────
async function checkAccount() {
  try {
    if (!ALPACA_KEY || !ALPACA_SECRET) { log("WARN", "No Alpaca API keys set"); return; }
    const acct = await alpacaGet("/v2/account");
    log("ALPACA", "Connected — " + (IS_PAPER ? "PAPER" : "LIVE") +
      " | Balance: $" + parseFloat(acct.portfolio_value).toLocaleString() +
      " | Buying power: $" + parseFloat(acct.buying_power).toLocaleString());
    broadcast({ type: "alpaca_status", connected: true, paper: IS_PAPER,
      balance: acct.portfolio_value, buyingPower: acct.buying_power });
  } catch (e) {
    log("ALPACA ERR", e.message);
    broadcast({ type: "alpaca_status", connected: false });
  }
}

// ── SPY Option helpers ────────────────────────────────────────────────────────
function buildSPYSymbol(strike, right, expiryDate) {
  const yy        = String(expiryDate.getFullYear()).slice(2);
  const mm        = String(expiryDate.getMonth() + 1).padStart(2, "0");
  const dd        = String(expiryDate.getDate()).padStart(2, "0");
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, "0");
  return "SPY" + yy + mm + dd + right + strikeStr;
}

function get0DTEDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function get0DTEExpiry() {
  const d = get0DTEDate();
  return d.getFullYear() + String(d.getMonth()+1).padStart(2,"0") + String(d.getDate()).padStart(2,"0");
}

async function getOptionMidPrice(symbol) {
  try {
    const res  = await fetch(ALPACA_DATA + "/v1beta1/options/snapshots?symbols=" + symbol, { headers: alpacaHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const snap = (data.snapshots || {})[symbol];
    if (!snap || !snap.latestQuote) return null;
    const bid  = parseFloat(snap.latestQuote.bp || 0);
    const ask  = parseFloat(snap.latestQuote.ap || 0);
    if (bid <= 0 || ask <= 0) return null;
    return parseFloat(((bid + ask) / 2).toFixed(2));
  } catch (_) { return null; }
}

// ── Place long option order ───────────────────────────────────────────────────
async function placeLongOption(signal) {
  const expiryDate = get0DTEDate();
  const symbol     = buildSPYSymbol(signal.strike, signal.right, expiryDate);

  log("ALPACA", "Fetching price for: " + symbol);

  // Get live mid price
  const midPrice = await getOptionMidPrice(symbol);
  if (!midPrice) throw new Error("Could not get option price for " + symbol + " — market may be closed");

  // Calculate contracts based on risk budget
  const contracts = calcContracts(midPrice);
  const totalCost = parseFloat((midPrice * 100 * contracts).toFixed(2));

  log("ALPACA", "Mid price: $" + midPrice +
    " | Risk budget: $" + getRiskBudget().toFixed(0) +
    " | Contracts: " + contracts +
    " | Total cost: $" + totalCost);

  // Place limit order at mid price
  const order = await alpacaPost("/v2/orders", {
    symbol:           symbol,
    qty:              String(contracts),
    side:             "buy",
    type:             "limit",
    limit_price:      String(midPrice),
    time_in_force:    "day",
    client_order_id:  "spxcmd_" + signal.id,
  });

  log("ALPACA", "Order placed: " + order.id + " | " + symbol + " x" + contracts + " @ $" + midPrice);
  return { symbol, orderId: order.id, midPrice, contracts, totalCost };
}

// ── Place exit orders ─────────────────────────────────────────────────────────
async function placeExitOrders(signal) {
  const entryPrice = signal.fillPrice || signal.midPrice;
  const stopPrice  = parseFloat((entryPrice * (1 - PREMIUM_STOP_PCT)).toFixed(2));
  const tp1Price   = parseFloat((entryPrice * 2.0).toFixed(2));
  const contracts  = signal.contracts;

  log("EXIT", "Placing exits — entry: $" + entryPrice +
    " | stop: $" + stopPrice +
    " | tp1: $" + tp1Price);

  // Stop loss order
  const stopOrder = await alpacaPost("/v2/orders", {
    symbol:          signal.optionSymbol,
    qty:             String(contracts),
    side:            "sell",
    type:            "stop",
    stop_price:      String(stopPrice),
    time_in_force:   "day",
    client_order_id: "spxcmd_stop_" + signal.id,
  });

  // TP1 limit order
  const tp1Order = await alpacaPost("/v2/orders", {
    symbol:          signal.optionSymbol,
    qty:             String(contracts),
    side:            "sell",
    type:            "limit",
    limit_price:     String(tp1Price),
    time_in_force:   "day",
    client_order_id: "spxcmd_tp1_" + signal.id,
  });

  log("EXIT", "Stop: " + stopOrder.id + " | TP1: " + tp1Order.id);
  return { stopOrderId: stopOrder.id, tp1OrderId: tp1Order.id, stopPrice, tp1Price };
}

/**
 * Move stop to breakeven after TP1 hits.
 * Cancels old stop and places new stop at entry price.
 */
async function trailStopToBreakeven(signal) {
  const breakeven = signal.fillPrice || signal.midPrice;

  log("TRAIL", "Moving stop to breakeven $" + breakeven + " for signal #" + signal.id);

  // Cancel existing stop
  if (signal.stopOrderId) {
    try { await alpacaDelete("/v2/orders/" + signal.stopOrderId); } catch (_) {}
  }

  // Place new stop at breakeven
  const newStop = await alpacaPost("/v2/orders", {
    symbol:          signal.optionSymbol,
    qty:             String(signal.contracts),
    side:            "sell",
    type:            "stop",
    stop_price:      String(parseFloat(breakeven.toFixed(2))),
    time_in_force:   "day",
    client_order_id: "spxcmd_trail_" + signal.id,
  });

  signal.stopOrderId = newStop.id;
  signal.stopPrice   = breakeven;
  signal.trailedToBreakeven = true;

  log("TRAIL", "Stop moved to breakeven $" + breakeven + " | new order: " + newStop.id);
  broadcast({ type: "signal_update", id: signal.id, stopPrice: breakeven, trailedToBreakeven: true });
}

/**
 * Force close all open positions — called at 3:45 PM ET.
 */
async function forceCloseAll() {
  const active = signalHistory.filter(s => ["FILLED","TP1_HIT"].includes(s.status));
  if (!active.length) { log("EOD", "No open positions to close"); return; }

  log("EOD", "Force closing " + active.length + " open position(s) at 3:45 PM ET");

  for (const sig of active) {
    try {
      // Cancel all open exit orders first
      const orderIds = [sig.stopOrderId, sig.tp1OrderId].filter(Boolean);
      for (const oid of orderIds) {
        try { await alpacaDelete("/v2/orders/" + oid); } catch (_) {}
      }

      // Close position at market
      await alpacaPost("/v2/orders", {
        symbol:          sig.optionSymbol,
        qty:             String(sig.contracts),
        side:            "sell",
        type:            "market",
        time_in_force:   "day",
        client_order_id: "spxcmd_eod_" + sig.id,
      });

      sig.status = "EOD_CLOSED";
      broadcast({ type: "signal_update", id: sig.id, status: "EOD_CLOSED" });
      log("EOD", "Closed: " + sig.optionSymbol + " x" + sig.contracts);

    } catch (e) {
      log("EOD ERR", "Failed to close signal #" + sig.id + ": " + e.message);
    }
  }
}

async function pollOrderFill(orderId, maxWaitMs) {
  maxWaitMs   = maxWaitMs || 60000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const order = await alpacaGet("/v2/orders/" + orderId);
    if (order.status === "filled") return order;
    if (["cancelled","expired","rejected"].includes(order.status)) throw new Error("Order " + orderId + " " + order.status);
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// ── Auto-execute ──────────────────────────────────────────────────────────────
async function executeSignal(id) {
  const signal = signalHistory.find(s => s.id === id);
  if (!signal)                     return log("ERROR", "executeSignal: #" + id + " not found");
  if (signal.status !== "PENDING") return log("WARN",  "executeSignal: #" + id + " not pending");
  if (!ALPACA_KEY || !ALPACA_SECRET) return log("ERROR", "Alpaca keys not configured");

  signal.status = "EXECUTING";
  broadcast({ type: "signal_update", id, status: "EXECUTING" });
  log("AUTO", "Executing #" + id + " | " + signal.direction + " SPY " + signal.strike + " " + signal.right);

  try {
    // Place long option order
    const result         = await placeLongOption(signal);
    signal.optionSymbol  = result.symbol;
    signal.orderId       = result.orderId;
    signal.midPrice      = result.midPrice;
    signal.contracts     = result.contracts;
    signal.totalCost     = result.totalCost;
    signal.status        = "SENT";

    broadcast({ type: "signal_update", id, status: "SENT",
      optionSymbol: result.symbol, orderId: result.orderId,
      midPrice: result.midPrice, contracts: result.contracts,
      totalCost: result.totalCost });

    // Poll for fill then attach exits
    pollOrderFill(result.orderId, 60000).then(async (filled) => {
      if (!filled) { log("ORDER", "Unfilled after 60s — signal #" + id); return; }

      const fillPrice  = parseFloat(filled.filled_avg_price || result.midPrice);
      signal.fillPrice = fillPrice;
      signal.status    = "FILLED";
      broadcast({ type: "signal_update", id, status: "FILLED", fillPrice });
      log("FILL", "Filled @ $" + fillPrice + " | placing exits...");

      try {
        const exits        = await placeExitOrders(signal);
        signal.stopOrderId = exits.stopOrderId;
        signal.tp1OrderId  = exits.tp1OrderId;
        signal.stopPrice   = exits.stopPrice;
        signal.tp1Price    = exits.tp1Price;
        broadcast({ type: "signal_update", id,
          stopOrderId: exits.stopOrderId, tp1OrderId: exits.tp1OrderId,
          stopPrice: exits.stopPrice, tp1Price: exits.tp1Price });
        log("EXIT", "Exits placed — stop $" + exits.stopPrice + " | tp1 $" + exits.tp1Price);
      } catch (e) { log("ERROR", "Exit placement failed: " + e.message); }

    }).catch(e => {
      log("ERROR", "Poll failed: " + e.message);
      signal.status = "PENDING";
      broadcast({ type: "signal_update", id, status: "PENDING" });
    });

  } catch (e) {
    signal.status = "PENDING";
    broadcast({ type: "signal_update", id, status: "PENDING" });
    log("ERROR", "Execute failed #" + id + ": " + e.message);
  }
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
// CORS — open for all origins
const corsConfig = {
  origin: "*",
  methods: ["GET","POST","DELETE","OPTIONS"],
  allowedHeaders: ["Content-Type","Accept","Authorization"],
  exposedHeaders: ["Content-Type"],
  credentials: false,
};
app.use(cors(corsConfig));
app.options("*", cors(corsConfig));
app.use(express.json());

// Serve dashboard at /dashboard — same origin, no CORS issues
const path = require("path");
const fs   = require("fs");
app.get("/dashboard", (req, res) => {
  const file = path.join(__dirname, "dashboard.html");
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).send("Dashboard not found — upload dashboard.html to the same folder as server.js");
  }
});

app.get("/", (req, res) => res.json({
  service: "SPX COMMAND", status: "running",
  mode: IS_PAPER ? "PAPER" : "LIVE",
  version: "7.0-long-options",
  riskMode: RISK_DOLLARS > 0 ? "fixed-$" + RISK_DOLLARS : "pct-" + (RISK_PER_TRADE*100) + "%",
  time: new Date().toISOString(),
}));

// SSE
app.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  sseClients.push(res);
  res.write("data: " + JSON.stringify({
    type: "init", sessionPnL, dailyLoss,
    signals: signalHistory, gex: gexCache,
    expiry: get0DTEExpiry(),
    riskBudget: getRiskBudget(),
  }) + "\n\n");
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) { clearInterval(ping); } }, 30000);
  req.on("close", () => { clearInterval(ping); sseClients = sseClients.filter(c => c !== res); });
});

// GEX endpoint
app.get("/gex", async (req, res) => {
  if (req.query.refresh === "true") {
    log("GEX", "Manual refresh triggered");
    const fresh = await getGEX(true);
    return res.json(fresh || { error: "GEX calculation failed — market may be closed" });
  }
  res.json(gexCache || { error: "GEX not yet calculated", hint: "?refresh=true to force fetch" });
});

// Webhook
app.post("/webhook", async (req, res) => {
  const raw = req.body;
  log("WEBHOOK", JSON.stringify(raw));

  const required = ["symbol", "direction", "entry", "stop", "tp1", "tp2"];
  const missing  = required.filter(k => raw[k] == null);
  if (missing.length) return res.status(400).json({ error: "Missing fields", missing });

  if (dailyLoss >= ACCOUNT_SIZE * MAX_DAILY_LOSS) {
    log("GUARD", "Daily loss limit reached — signal rejected");
    return res.json({ status: "rejected", reason: "daily_loss_limit" });
  }

  const direction  = raw.direction.toUpperCase();
  const right      = direction === "LONG" ? "C" : "P";

  // TradingView is on SPY chart — prices arrive directly in SPY range
  const spyEntry   = parseFloat(raw.entry);
  const spyStop    = parseFloat(raw.stop);
  const spyTP1     = parseFloat(raw.tp1);
  const spyTP2     = parseFloat(raw.tp2);
  const strike     = nearestSPYStrike(spyEntry);

  const ptRisk     = Math.abs(spyEntry - spyStop);
  const ptReward   = Math.abs(spyTP1 - spyEntry);

  log("PRICE", "SPY entry: $" + spyEntry + " | Strike: $" + strike);

  // Apply GEX filter using cached levels
  const gexResult  = applyGEX(direction, spyEntry, spyTP1, spyTP2);

  if (!gexResult.allowed) {
    log("GEX", "Signal BLOCKED — " + gexResult.reason);
    broadcast({ type: "signal_blocked", reason: gexResult.reason, direction, entry: spyEntry });
    return res.json({ status: "blocked", reason: gexResult.reason });
  }

  log("GEX", "Signal ALLOWED — " + gexResult.reason);

  const signal = {
    id:          Date.now(),
    time:        new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" }),
    symbol:      "SPY",
    direction,   right,
    strike,
    spyEntry,
    stop:        spyStop,
    tp1:         gexResult.tp1,
    tp2:         gexResult.tp2,
    gexTarget:   gexResult.gexTarget,
    gexReason:   gexResult.reason,
    expiry:      get0DTEExpiry(),
    riskBudget:  getRiskBudget(),
    contracts:   1,             // updated after price fetch
    midPrice:    null,          // updated after price fetch
    totalCost:   null,
    rr:          ptRisk > 0 ? (ptReward / ptRisk).toFixed(1) + ":1" : "N/A",
    trigger:     raw.trigger    || "TradingView Alert",
    confidence:  raw.confidence || "MEDIUM",
    status:      "PENDING",
    optionSymbol: null,
    orderId:      null,
    fillPrice:    null,
    stopOrderId:  null,
    tp1OrderId:   null,
    stopPrice:    null,
    tp1Price:     null,
    trailedToBreakeven: false,
    gexSnapshot: gexCache ? {
      callWalls: gexCache.callWalls.slice(0,3),
      putWalls:  gexCache.putWalls.slice(0,3),
      gammaFlip: gexCache.gammaFlip,
      regime:    gexCache.regime,
    } : null,
  };

  signalHistory.unshift(signal);
  broadcast({ type: "new_signal", signal });
  log("SIGNAL",
    direction + " SPY $" + strike + " " + right +
    " | spy entry $" + spyEntry +
    " | risk budget $" + getRiskBudget().toFixed(0) +
    " | tp1 $" + gexResult.tp1.toFixed(2) +
    (gexCache ? " | " + gexCache.regime + " GEX" : " | no GEX")
  );

  res.json({ status: "received", signal });
  executeSignal(signal.id);
});

// Manual execute
app.post("/execute/:id", async (req, res) => {
  const id     = parseInt(req.params.id);
  const signal = signalHistory.find(s => s.id === id);
  if (!signal)                     return res.status(404).json({ error: "Signal not found" });
  if (signal.status !== "PENDING") return res.status(400).json({ error: "Not pending: " + signal.status });
  res.json({ status: "executing", id });
  executeSignal(id);
});

// Cancel
app.post("/cancel/:id", async (req, res) => {
  const id  = parseInt(req.params.id);
  const sig = signalHistory.find(s => s.id === id);
  if (!sig) return res.status(404).json({ error: "Not found" });
  const orderIds = [sig.orderId, sig.stopOrderId, sig.tp1OrderId].filter(Boolean);
  for (const oid of orderIds) { try { await alpacaDelete("/v2/orders/" + oid); } catch (_) {} }
  sig.status = "CANCELLED";
  broadcast({ type: "signal_update", id, status: "CANCELLED" });
  log("CANCEL", "Signal #" + id + " — " + orderIds.length + " orders cancelled");
  res.json({ status: "cancelled" });
});

// Force close all — manual trigger
app.post("/closeall", async (req, res) => {
  await forceCloseAll();
  res.json({ status: "done" });
});

// Sync — check fills and trail stops
app.get("/sync", async (req, res) => {
  const active  = signalHistory.filter(s => ["SENT","FILLED","TP1_HIT"].includes(s.status));
  const updates = [];

  for (const sig of active) {
    try {
      // Check TP1
      if (sig.tp1OrderId && sig.status === "FILLED") {
        const tp1 = await alpacaGet("/v2/orders/" + sig.tp1OrderId);
        if (tp1.status === "filled") {
          const pnl    = (parseFloat(tp1.filled_avg_price) - sig.fillPrice) * 100 * sig.contracts;
          sig.status   = "TP1_HIT";
          sig.closePnl = pnl;
          sessionPnL  += pnl;
          broadcast({ type: "signal_update", id: sig.id, status: "TP1_HIT", pnl });
          updates.push({ id: sig.id, status: "TP1_HIT", pnl });
          log("TP1", "Signal #" + sig.id + " hit | P&L $" + pnl.toFixed(0));

          // Trail stop to breakeven
          if (!sig.trailedToBreakeven) {
            try { await trailStopToBreakeven(sig); } catch (e) { log("TRAIL ERR", e.message); }
          }
        }
      }

      // Check stop
      if (sig.stopOrderId && ["FILLED","TP1_HIT"].includes(sig.status)) {
        const sl = await alpacaGet("/v2/orders/" + sig.stopOrderId);
        if (sl.status === "filled") {
          const pnl    = (parseFloat(sl.filled_avg_price) - sig.fillPrice) * 100 * sig.contracts;
          sig.status   = "STOPPED";
          sig.closePnl = pnl;
          sessionPnL  += pnl;
          dailyLoss   += Math.abs(Math.min(0, pnl));
          broadcast({ type: "signal_update", id: sig.id, status: "STOPPED", pnl });
          updates.push({ id: sig.id, status: "STOPPED", pnl });
          log("STOP", "Signal #" + sig.id + " stopped | P&L $" + pnl.toFixed(0));
        }
      }
    } catch (e) { log("SYNC ERR", "Signal #" + sig.id + ": " + e.message); }
  }

  res.json({ synced: active.length, updates });
});

// Status
app.get("/status", (req, res) => res.json({
  mode:           IS_PAPER ? "PAPER" : "LIVE",
  broker:         "Alpaca",
  underlying:     "SPY (long options)",
  version:        "7.0-long-options",
  riskMode:       RISK_DOLLARS > 0 ? "Fixed $" + RISK_DOLLARS + " per trade" : (RISK_PER_TRADE*100) + "% of account",
  riskBudget:     "$" + getRiskBudget().toFixed(0) + " per trade",
  sessionPnL:     sessionPnL.toFixed(2),
  dailyLoss:      dailyLoss.toFixed(2),
  dailyLossLimit: (ACCOUNT_SIZE * MAX_DAILY_LOSS).toFixed(2),
  expiry:         get0DTEExpiry(),
  gex: gexCache ? {
    regime:    gexCache.regime,
    gammaFlip: gexCache.gammaFlip,
    netGex:    gexCache.netGex,
    callWalls: gexCache.callWalls.slice(0,3).map(w => "$" + w.price),
    putWalls:  gexCache.putWalls.slice(0,3).map(w => "$" + w.price),
    updatedAt: gexCache.updatedAt,
  } : null,
  signals: {
    total:   signalHistory.length,
    pending: signalHistory.filter(s => s.status === "PENDING").length,
    active:  signalHistory.filter(s => ["SENT","FILLED","TP1_HIT"].includes(s.status)).length,
    closed:  signalHistory.filter(s => ["STOPPED","EOD_CLOSED","CANCELLED"].includes(s.status)).length,
    blocked: signalHistory.filter(s => s.status === "BLOCKED").length,
  },
}));

// ── Schedulers ────────────────────────────────────────────────────────────────

// Sync every 60s during market hours
setInterval(async () => {
  const now  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h    = now.getHours(), m = now.getMinutes();
  if (!((h > 9 || (h === 9 && m >= 30)) && h < 16)) return;
  if (!signalHistory.filter(s => ["SENT","FILLED","TP1_HIT"].includes(s.status)).length) return;
  try { await fetch("http://localhost:" + PORT + "/sync"); } catch (_) {}
}, 60000);

// GEX scheduler — every minute, fires at scheduled times
setInterval(async () => {
  const now   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h     = now.getHours(), m = now.getMinutes();
  const today = now.toLocaleDateString("en-CA");
  if (!((h > 9 || (h === 9 && m >= 25)) && h < 16)) return;
  const key   = today + "_" + h + "_" + m;
  if (GEX_SCHEDULE.some(s => s.h === h && s.m === m) && !gexScheduleFired.has(key)) {
    gexScheduleFired.add(key);
    log("GEX", "Scheduled refresh at " + String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + " ET");
    await getGEX(true);
  }
}, 60000);

// 3:45 PM ET force close scheduler
setInterval(async () => {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h   = now.getHours(), m = now.getMinutes();
  if (h === 15 && m === 45) {
    const key = now.toLocaleDateString("en-CA") + "_eod";
    if (!gexScheduleFired.has(key)) {
      gexScheduleFired.add(key);
      log("EOD", "3:45 PM ET — forcing close of all open positions");
      await forceCloseAll();
    }
  }
}, 60000);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log([
    "",
    " ╔══════════════════════════════════════════════════════╗",
    " ║   SPX COMMAND v7 · SPY Long Options + Auto Exit     ║",
    " ╠══════════════════════════════════════════════════════╣",
    " ║  Health   : GET  /                                   ║",
    " ║  Webhook  : POST /webhook                            ║",
    " ║  Events   : GET  /events  (SSE)                      ║",
    " ║  GEX      : GET  /gex  (?refresh=true)               ║",
    " ║  Execute  : POST /execute/:id                        ║",
    " ║  Cancel   : POST /cancel/:id                         ║",
    " ║  CloseAll : POST /closeall  (manual EOD)             ║",
    " ║  Sync     : GET  /sync                               ║",
    " ║  Status   : GET  /status                             ║",
    " ╠══════════════════════════════════════════════════════╣",
    " ║  Broker   : Alpaca (" + (IS_PAPER?"PAPER":"LIVE ") + ")                         ║",
    " ║  Trades   : SPY long calls/puts (0DTE)               ║",
    " ║  Risk     : " + (RISK_DOLLARS>0?"$"+RISK_DOLLARS+" fixed":"("+RISK_PER_TRADE*100+"% = $"+getRiskBudget().toFixed(0)+")") + " per trade              ║",
    " ║  Exit     : stop + TP1 + trail + 3:45PM close        ║",
    " ║  Chart    : SPY (no conversion needed)               ║",
    " ╚══════════════════════════════════════════════════════╝",
    "",
  ].join("\n"));
  await checkAccount();
  const now  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h    = now.getHours(), m = now.getMinutes();
  if ((h > 9 || (h === 9 && m >= 30)) && h < 16) {
    log("GEX", "Market open — calculating initial GEX...");
    await getGEX(true);
  } else {
    log("GEX", "Market closed — GEX calculates at 9:25 AM ET");
  }
});
