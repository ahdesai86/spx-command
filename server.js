/**
 * SPX COMMAND v6 — SPY Options + Self-Calculated GEX
 * ─────────────────────────────────────────────────────────────────────────────
 * TradingView webhook → SPY 0DTE vertical spread → Alpaca Paper API
 *
 * GEX CALCULATION (no third party needed):
 *   Pulls SPY option chain from Alpaca at scheduled times
 *   Calculates: GEX = Gamma × Open Interest × 100 × Spot Price per strike
 *   Derives:    Call walls, Put walls, Gamma flip, Net GEX, Regime
 *
 * GEX SCHEDULE (market hours only):
 *   9:25 AM  — pre-market levels before ORB builds
 *   10:30 AM — mid-morning refresh
 *   12:00 PM — lunch reset
 *   2:00 PM  — afternoon levels
 *
 * GEX FILTER + TARGETS:
 *   LONG  — only if price below nearest call wall (room to run)
 *           TP1 = nearest call wall, TP2 = next call wall
 *   SHORT — only if price above nearest put wall (room to fall)
 *           TP1 = nearest put wall, TP2 = next put wall
 *   SKIP  — if price within GEX_BUFFER of wall (already at resistance)
 *
 * ENV VARIABLES (set in Railway):
 *   ALPACA_KEY        ALPACA_SECRET     ALPACA_BASE_URL
 *   ACCOUNT_SIZE      RISK_PER_TRADE    MAX_DAILY_LOSS
 *   SPREAD_WIDTH_PTS  PREMIUM_STOP_PCT  GEX_BUFFER   PORT
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
const MAX_DAILY_LOSS   = parseFloat(process.env.MAX_DAILY_LOSS   || "0.06");
const SPREAD_WIDTH_PTS = parseFloat(process.env.SPREAD_WIDTH_PTS || "2");
const PREMIUM_STOP_PCT = parseFloat(process.env.PREMIUM_STOP_PCT || "0.50");
const GEX_BUFFER       = parseFloat(process.env.GEX_BUFFER       || "1.0");
const PORT             = parseInt(process.env.PORT               || "3001");
const IS_PAPER         = ALPACA_BASE.includes("paper");

// GEX fetch schedule ET — 4 times per day during market hours
const GEX_SCHEDULE = [
  { h: 9,  m: 25 },
  { h: 10, m: 30 },
  { h: 12, m: 0  },
  { h: 14, m: 0  },
];
const GEX_STALE_MS = 2 * 60 * 60 * 1000; // 2 hours

// ── State ─────────────────────────────────────────────────────────────────────
let sessionPnL       = 0;
let dailyLoss        = 0;
let signalHistory    = [];
let sseClients       = [];
let gexCache         = null;  // { callWalls, putWalls, gammaFlip, netGex, regime, spotPrice, updatedAt }
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

// ── Self-Calculated GEX ───────────────────────────────────────────────────────

/**
 * Get current SPY spot price from Alpaca
 */
async function getSPYSpot() {
  try {
    const res = await fetch(ALPACA_DATA + "/v2/stocks/SPY/quotes/latest", { headers: alpacaHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const quote = data.quote || {};
    return parseFloat(quote.ap || quote.bp || 0) || null;
  } catch (_) { return null; }
}

/**
 * Fetch SPY option chain for today's expiry from Alpaca.
 * Returns array of contracts with strike, type, greeks, open_interest.
 */
async function fetchSPYChain(expiryStr) {
  try {
    // expiryStr format: YYYY-MM-DD
    const url = ALPACA_DATA +
      "/v1beta1/options/contracts?underlying_symbols=SPY" +
      "&expiration_date=" + expiryStr +
      "&status=active&limit=1000";

    const res = await fetch(url, { headers: alpacaHeaders() });
    if (!res.ok) {
      log("GEX ERR", "Chain fetch failed: " + res.status);
      return [];
    }

    const data      = await res.json();
    const contracts = data.option_contracts || data.contracts || [];
    log("GEX", "Fetched " + contracts.length + " SPY contracts for " + expiryStr);
    return contracts;

  } catch (e) {
    log("GEX ERR", "fetchSPYChain: " + e.message);
    return [];
  }
}

/**
 * Fetch greeks + open interest for a batch of option symbols.
 * Uses Alpaca snapshots endpoint which returns gamma + OI.
 * Processes in batches of 100 to avoid URL length limits.
 */
async function fetchGreeksBatch(symbols) {
  const results = {};
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
      const snaps = data.snapshots || {};
      Object.assign(results, snaps);
    } catch (_) { continue; }
  }

  return results;
}

/**
 * Calculate GEX from SPY option chain.
 *
 * Formula per strike:
 *   GEX = Gamma × Open Interest × 100 (multiplier) × Spot Price
 *   Call GEX = positive (dealers long gamma, dampen moves)
 *   Put  GEX = negative (dealers short gamma, amplify moves)
 *
 * Key levels derived:
 *   Call wall  = strike with highest positive GEX above spot
 *   Put wall   = strike with highest negative GEX below spot
 *   Gamma flip = strike closest to zero net GEX (crossover point)
 *   Net GEX    = sum of all GEX across all strikes
 *   Regime     = positive (range bound) or negative (trending/volatile)
 */
async function calculateGEX() {
  try {
    log("GEX", "Starting self-calculated GEX from Alpaca chain...");

    // Get spot price
    const spot = await getSPYSpot();
    if (!spot) {
      log("GEX ERR", "Could not get SPY spot price — market may be closed");
      return null;
    }
    log("GEX", "SPY spot: $" + spot.toFixed(2));

    // Get today's expiry string YYYY-MM-DD
    const d      = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    const expiry = d.getFullYear() + "-" +
      String(d.getMonth() + 1).padStart(2, "0") + "-" +
      String(d.getDate()).padStart(2, "0");

    // Fetch option chain
    const contracts = await fetchSPYChain(expiry);
    if (!contracts.length) {
      log("GEX ERR", "No contracts returned — market closed or no 0DTE contracts today");
      return null;
    }

    // Get OCC symbols for greek lookup
    const symbols = contracts.map(c => c.symbol).filter(Boolean);

    // Fetch greeks + snapshots in batches
    log("GEX", "Fetching greeks for " + symbols.length + " contracts...");
    const snapshots = await fetchGreeksBatch(symbols);

    // Build per-strike GEX map
    const strikeGEX = {};

    for (const contract of contracts) {
      const snap    = snapshots[contract.symbol];
      if (!snap) continue;

      const greeks  = snap.greeks || {};
      const gamma   = parseFloat(greeks.gamma || 0);
      const oi      = parseFloat(snap.openInterest || snap.open_interest || contract.open_interest || 0);
      const strike  = parseFloat(contract.strike_price || contract.strike || 0);
      const type    = (contract.type || contract.option_type || "").toUpperCase(); // "C" or "P" or "CALL" or "PUT"

      if (!strike || !gamma || !oi) continue;

      const isCall  = type === "C" || type === "CALL";
      const isPut   = type === "P" || type === "PUT";
      const gexVal  = gamma * oi * 100 * spot;

      if (!strikeGEX[strike]) strikeGEX[strike] = { call: 0, put: 0 };

      if (isCall) strikeGEX[strike].call += gexVal;
      if (isPut)  strikeGEX[strike].put  -= gexVal; // put GEX is negative
    }

    // Convert to sorted array
    const strikes = Object.keys(strikeGEX)
      .map(s => parseFloat(s))
      .sort((a, b) => a - b);

    if (!strikes.length) {
      log("GEX ERR", "No strike GEX calculated — greeks may not be available yet");
      return null;
    }

    // Calculate net GEX per strike and totals
    let netGexTotal = 0;
    const strikeLevels = strikes.map(strike => {
      const net = strikeGEX[strike].call + strikeGEX[strike].put;
      netGexTotal += net;
      return { strike, callGex: strikeGEX[strike].call, putGex: strikeGEX[strike].put, netGex: net };
    });

    // Find call walls (highest positive GEX ABOVE spot)
    const callWalls = strikeLevels
      .filter(s => s.strike > spot && s.callGex > 0)
      .sort((a, b) => b.callGex - a.callGex)
      .slice(0, 5)
      .map(s => ({ price: s.strike, gex: Math.round(s.callGex) }));

    // Find put walls (highest negative GEX BELOW spot)
    const putWalls = strikeLevels
      .filter(s => s.strike < spot && s.putGex < 0)
      .sort((a, b) => a.putGex - b.putGex)
      .slice(0, 5)
      .map(s => ({ price: s.strike, gex: Math.round(Math.abs(s.putGex)) }));

    // Find gamma flip — strike where cumulative GEX crosses zero
    let cumulative = 0;
    let gammaFlip  = spot; // default to spot if no flip found
    for (const level of strikeLevels) {
      const prev = cumulative;
      cumulative += level.netGex;
      if (prev < 0 && cumulative >= 0 || prev >= 0 && cumulative < 0) {
        gammaFlip = level.strike;
        break;
      }
    }

    const regime = netGexTotal >= 0 ? "positive" : "negative";

    const result = {
      callWalls,
      putWalls,
      gammaFlip:  parseFloat(gammaFlip.toFixed(2)),
      netGex:     Math.round(netGexTotal),
      regime,
      spotPrice:  spot,
      expiry,
      updatedAt:  new Date().toISOString(),
      source:     "alpaca-calculated",
    };

    log("GEX", "Calculated ✓ " +
      "| Regime: " + regime.toUpperCase() +
      " | Flip: $" + gammaFlip.toFixed(2) +
      " | Call walls: " + callWalls.slice(0,3).map(w => "$" + w.price).join(", ") +
      " | Put walls: "  + putWalls.slice(0,3).map(w => "$" + w.price).join(", ") +
      " | Net GEX: " + (netGexTotal >= 0 ? "+" : "") + Math.round(netGexTotal / 1e6) + "M"
    );

    broadcast({ type: "gex_update", ...result });
    return result;

  } catch (e) {
    log("GEX ERR", "calculateGEX failed: " + e.message);
    return null;
  }
}

/**
 * Fetch + cache GEX. Uses cache if under 2 hours old.
 * forceRefresh = true bypasses cache (used by scheduler).
 */
async function getGEX(forceRefresh) {
  forceRefresh = forceRefresh || false;
  const now    = Date.now();
  const today  = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });

  // Reset schedule tracker on new day
  if (today !== gexLastDate) {
    gexScheduleFired = new Set();
    gexLastDate      = today;
    gexCache         = null;
    gexCacheTime     = 0;
    log("GEX", "New trading day — GEX cache reset");
  }

  // Return cache if fresh and not forcing refresh
  if (!forceRefresh && gexCache && (now - gexCacheTime) < GEX_STALE_MS) {
    const ageMin = Math.round((now - gexCacheTime) / 60000);
    log("GEX", "Using cache (age: " + ageMin + "min) | regime: " + gexCache.regime);
    return gexCache;
  }

  // Calculate fresh GEX
  const result = await calculateGEX();
  if (result) {
    gexCache     = result;
    gexCacheTime = now;
  }
  return gexCache;
}

/**
 * Apply GEX filter + dynamic targets.
 * Returns { allowed, reason, tp1, tp2, gexTarget }
 */
function applyGEX(direction, entry, tp1, tp2) {
  if (!gexCache) {
    return { allowed: true, reason: "GEX not available — using ORB targets", tp1, tp2, gexTarget: null };
  }

  const gex = gexCache;

  if (direction === "LONG") {
    const wallsAbove = gex.callWalls
      .filter(w => w.price > entry)
      .sort((a, b) => a.price - b.price);

    if (!wallsAbove.length) {
      return { allowed: true, reason: "No call wall above — using ORB target", tp1, tp2, gexTarget: null };
    }

    const nearest = wallsAbove[0];
    const next    = wallsAbove[1] || { price: nearest.price + (nearest.price - entry) };

    if (nearest.price - entry < GEX_BUFFER) {
      return {
        allowed: false,
        reason:  "LONG blocked — price $" + entry + " within $" + GEX_BUFFER + " of call wall $" + nearest.price,
        tp1, tp2, gexTarget: nearest.price,
      };
    }

    return {
      allowed:   true,
      reason:    "LONG → call wall $" + nearest.price + " | regime: " + gex.regime,
      tp1:       nearest.price,
      tp2:       next.price,
      gexTarget: nearest.price,
    };
  }

  if (direction === "SHORT") {
    const wallsBelow = gex.putWalls
      .filter(w => w.price < entry)
      .sort((a, b) => b.price - a.price);

    if (!wallsBelow.length) {
      return { allowed: true, reason: "No put wall below — using ORB target", tp1, tp2, gexTarget: null };
    }

    const nearest = wallsBelow[0];
    const next    = wallsBelow[1] || { price: nearest.price - (entry - nearest.price) };

    if (entry - nearest.price < GEX_BUFFER) {
      return {
        allowed: false,
        reason:  "SHORT blocked — price $" + entry + " within $" + GEX_BUFFER + " of put wall $" + nearest.price,
        tp1, tp2, gexTarget: nearest.price,
      };
    }

    return {
      allowed:   true,
      reason:    "SHORT → put wall $" + nearest.price + " | regime: " + gex.regime,
      tp1:       nearest.price,
      tp2:       next.price,
      gexTarget: nearest.price,
    };
  }

  return { allowed: true, reason: "No GEX filter applied", tp1, tp2, gexTarget: null };
}

// ── Alpaca account check ──────────────────────────────────────────────────────
async function checkAccount() {
  try {
    if (!ALPACA_KEY || !ALPACA_SECRET) {
      log("WARN", "No Alpaca API keys — add ALPACA_KEY and ALPACA_SECRET in Railway env vars");
      return;
    }
    const acct = await alpacaGet("/v2/account");
    log("ALPACA", "Connected — " + (IS_PAPER ? "PAPER" : "LIVE") +
      " | Balance: $" + parseFloat(acct.portfolio_value).toLocaleString() +
      " | Buying power: $" + parseFloat(acct.buying_power).toLocaleString());
    broadcast({ type: "alpaca_status", connected: true, paper: IS_PAPER, balance: acct.portfolio_value });
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
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

function nearestSPYStrike(price, direction, isShortLeg) {
  const base = Math.round(price);
  if (!isShortLeg) return base;
  return direction === "LONG" ? base + SPREAD_WIDTH_PTS : base - SPREAD_WIDTH_PTS;
}

function calcContracts() {
  const budget   = ACCOUNT_SIZE * RISK_PER_TRADE;
  const estDebit = SPREAD_WIDTH_PTS * 0.45;
  const maxLoss  = estDebit * 100;
  return Math.max(1, Math.floor(budget / maxLoss));
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

async function verifyOptionSymbols(longSymbol, shortSymbol) {
  try {
    const res  = await fetch(ALPACA_DATA + "/v1beta1/options/snapshots?symbols=" + longSymbol + "," + shortSymbol, { headers: alpacaHeaders() });
    if (!res.ok) return false;
    const data = await res.json();
    const snaps = data.snapshots || {};
    return snaps[longSymbol] != null && snaps[shortSymbol] != null;
  } catch (_) { return false; }
}

// ── Place orders ──────────────────────────────────────────────────────────────
async function placeSpreadOrders(signal) {
  const expiryDate  = get0DTEDate();
  const longSymbol  = buildSPYSymbol(signal.longStrike,  signal.right, expiryDate);
  const shortSymbol = buildSPYSymbol(signal.shortStrike, signal.right, expiryDate);

  log("ALPACA", "Verifying: " + longSymbol + " / " + shortSymbol);

  const valid = await verifyOptionSymbols(longSymbol, shortSymbol);
  if (!valid) throw new Error("SPY option symbols not found — market may be closed");

  const longMid  = await getOptionMidPrice(longSymbol)  || signal.estDebit;
  const shortMid = await getOptionMidPrice(shortSymbol) || parseFloat((signal.estDebit * 0.45).toFixed(2));
  const netDebit = parseFloat((longMid - shortMid).toFixed(2));

  log("ALPACA", "Prices — long: $" + longMid + " | short: $" + shortMid + " | net debit: $" + netDebit);

  const buyOrder = await alpacaPost("/v2/orders", {
    symbol: longSymbol, qty: String(signal.contracts),
    side: "buy", type: "limit", limit_price: String(longMid),
    time_in_force: "day", order_class: "simple",
    client_order_id: "spxcmd_long_" + signal.id,
  });
  log("ALPACA", "Long leg: " + buyOrder.id);

  const sellOrder = await alpacaPost("/v2/orders", {
    symbol: shortSymbol, qty: String(signal.contracts),
    side: "sell", type: "limit", limit_price: String(shortMid),
    time_in_force: "day", order_class: "simple",
    client_order_id: "spxcmd_short_" + signal.id,
  });
  log("ALPACA", "Short leg: " + sellOrder.id);

  return { longSymbol, shortSymbol, longOrderId: buyOrder.id, shortOrderId: sellOrder.id, netDebit, longMid, shortMid };
}

async function placeBracketClosing(signal) {
  const netDebit  = signal.fillDebit || signal.estDebit;
  const stopPrice = parseFloat((netDebit * (1 - PREMIUM_STOP_PCT)).toFixed(2));
  const tp1Price  = parseFloat((netDebit * 2.0).toFixed(2));

  const stopOrder = await alpacaPost("/v2/orders", {
    symbol: signal.longSymbol, qty: String(signal.contracts),
    side: "sell", type: "stop", stop_price: String(stopPrice),
    time_in_force: "day", client_order_id: "spxcmd_stop_" + signal.id,
  });

  const tp1Order = await alpacaPost("/v2/orders", {
    symbol: signal.longSymbol, qty: String(signal.contracts),
    side: "sell", type: "limit", limit_price: String(tp1Price),
    time_in_force: "day", client_order_id: "spxcmd_tp1_" + signal.id,
  });

  log("ALPACA", "Bracket — stop $" + stopPrice + " | tp1 $" + tp1Price);
  return { stopOrderId: stopOrder.id, tp1OrderId: tp1Order.id, stopPrice, tp1Price };
}

async function pollOrderFill(orderId, maxWaitMs) {
  maxWaitMs    = maxWaitMs || 30000;
  const start  = Date.now();
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
  log("AUTO", "Executing #" + id + " | " + signal.direction + " SPY " + signal.longStrike + "/" + signal.shortStrike);

  try {
    const result        = await placeSpreadOrders(signal);
    signal.longSymbol   = result.longSymbol;
    signal.shortSymbol  = result.shortSymbol;
    signal.longOrderId  = result.longOrderId;
    signal.shortOrderId = result.shortOrderId;
    signal.fillDebit    = result.netDebit;
    signal.status       = "SENT";

    broadcast({ type: "signal_update", id, status: "SENT",
      longSymbol: result.longSymbol, shortSymbol: result.shortSymbol,
      longOrderId: result.longOrderId, shortOrderId: result.shortOrderId,
      fillDebit: result.netDebit });

    pollOrderFill(result.longOrderId, 60000).then(async (filled) => {
      if (!filled) { log("ORDER", "Long leg unfilled after 60s — signal #" + id); return; }
      const fillPrice  = parseFloat(filled.filled_avg_price || result.longMid);
      signal.fillPrice = fillPrice;
      signal.status    = "FILLED";
      broadcast({ type: "signal_update", id, status: "FILLED", fillPrice });
      log("FILL", "Filled @ $" + fillPrice + " | attaching bracket...");
      try {
        const bracket      = await placeBracketClosing(signal);
        signal.stopOrderId = bracket.stopOrderId;
        signal.tp1OrderId  = bracket.tp1OrderId;
        signal.stopPrice   = bracket.stopPrice;
        signal.tp1Price    = bracket.tp1Price;
        broadcast({ type: "signal_update", id,
          stopOrderId: bracket.stopOrderId, tp1OrderId: bracket.tp1OrderId,
          stopPrice: bracket.stopPrice, tp1Price: bracket.tp1Price });
      } catch (e) { log("ERROR", "Bracket failed: " + e.message); }
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
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.json({
  service: "SPX COMMAND", status: "running",
  mode: IS_PAPER ? "PAPER" : "LIVE",
  version: "6.0-gex-self-calc", time: new Date().toISOString(),
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
  }) + "\n\n");
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) { clearInterval(ping); } }, 30000);
  req.on("close", () => { clearInterval(ping); sseClients = sseClients.filter(c => c !== res); });
});

// GEX endpoint — returns latest calculated levels
app.get("/gex", async (req, res) => {
  const force = req.query.refresh === "true";
  if (force) {
    log("GEX", "Manual refresh triggered via /gex?refresh=true");
    const fresh = await getGEX(true);
    return res.json(fresh || { error: "GEX calculation failed — market may be closed" });
  }
  res.json(gexCache || { error: "GEX not yet calculated", hint: "Add ?refresh=true to force a fetch" });
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

  const entry      = parseFloat(raw.entry);
  const stop       = parseFloat(raw.stop);
  const tp1        = parseFloat(raw.tp1);
  const tp2        = parseFloat(raw.tp2);
  const direction  = raw.direction.toUpperCase();
  const right      = direction === "LONG" ? "C" : "P";
  const longStrike  = nearestSPYStrike(entry, direction, false);
  const shortStrike = nearestSPYStrike(entry, direction, true);
  const contracts   = calcContracts();
  const estDebit    = parseFloat((SPREAD_WIDTH_PTS * 0.45).toFixed(2));
  const premiumStop = parseFloat((estDebit * (1 - PREMIUM_STOP_PCT)).toFixed(2));
  const ptRisk      = Math.abs(entry - stop);
  const ptReward    = Math.abs(tp1 - entry);

  // Apply GEX filter using cached levels (never recalculate on signal)
  const gexResult = applyGEX(direction, entry, tp1, tp2);

  if (!gexResult.allowed) {
    log("GEX", "Signal BLOCKED — " + gexResult.reason);
    broadcast({ type: "signal_blocked", reason: gexResult.reason, direction, entry });
    return res.json({ status: "blocked", reason: gexResult.reason });
  }

  log("GEX", "Signal ALLOWED — " + gexResult.reason);

  const signal = {
    id:          Date.now(),
    time:        new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" }),
    symbol:      "SPY",
    direction,   entry, stop,
    tp1:         gexResult.tp1,
    tp2:         gexResult.tp2,
    gexTarget:   gexResult.gexTarget,
    gexReason:   gexResult.reason,
    right,       longStrike, shortStrike,
    expiry:      get0DTEExpiry(),
    contracts,
    spreadWidth: SPREAD_WIDTH_PTS,
    estDebit,    premiumStop,
    estMaxLoss:  (estDebit * 100 * contracts).toFixed(0),
    rr:          (ptReward / ptRisk).toFixed(1) + ":1",
    trigger:     raw.trigger    || "TradingView Alert",
    confidence:  raw.confidence || "MEDIUM",
    status:      "PENDING",
    longSymbol:  null, shortSymbol:  null,
    longOrderId: null, shortOrderId: null,
    stopOrderId: null, tp1OrderId:   null,
    fillDebit:   null,
    gexSnapshot: gexCache ? {
      callWalls:  gexCache.callWalls.slice(0, 3),
      putWalls:   gexCache.putWalls.slice(0, 3),
      gammaFlip:  gexCache.gammaFlip,
      netGex:     gexCache.netGex,
      regime:     gexCache.regime,
    } : null,
  };

  signalHistory.unshift(signal);
  broadcast({ type: "new_signal", signal });
  log("SIGNAL",
    direction + " SPY " + longStrike + "/" + shortStrike + " " + right +
    " | tp1 $" + gexResult.tp1.toFixed(2) +
    " | est debit $" + estDebit +
    " | " + contracts + " contracts" +
    (gexCache ? " | " + gexCache.regime + " GEX regime" : " | no GEX")
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
  const orderIds = [sig.longOrderId, sig.shortOrderId, sig.stopOrderId, sig.tp1OrderId].filter(Boolean);
  for (const oid of orderIds) { try { await alpacaDelete("/v2/orders/" + oid); } catch (_) {} }
  sig.status = "CANCELLED";
  broadcast({ type: "signal_update", id, status: "CANCELLED" });
  log("CANCEL", "Signal #" + id + " — " + orderIds.length + " orders cancelled");
  res.json({ status: "cancelled" });
});

// Sync — check fills
app.get("/sync", async (req, res) => {
  const active  = signalHistory.filter(s => ["SENT","FILLED"].includes(s.status));
  const updates = [];
  for (const sig of active) {
    try {
      if (sig.tp1OrderId) {
        const tp1 = await alpacaGet("/v2/orders/" + sig.tp1OrderId);
        if (tp1.status === "filled") {
          const pnl = (parseFloat(tp1.filled_avg_price) - (sig.fillDebit || sig.estDebit)) * 100 * sig.contracts;
          sig.status = "TP1_HIT"; sig.closePnl = pnl; sessionPnL += pnl;
          broadcast({ type: "signal_update", id: sig.id, status: "TP1_HIT", pnl });
          updates.push({ id: sig.id, status: "TP1_HIT", pnl });
          log("TP1", "Signal #" + sig.id + " | P&L $" + pnl.toFixed(0));
        }
      }
      if (sig.stopOrderId && sig.status !== "TP1_HIT") {
        const sl = await alpacaGet("/v2/orders/" + sig.stopOrderId);
        if (sl.status === "filled") {
          const pnl = (parseFloat(sl.filled_avg_price) - (sig.fillDebit || sig.estDebit)) * 100 * sig.contracts;
          sig.status = "STOPPED"; sig.closePnl = pnl; sessionPnL += pnl; dailyLoss += Math.abs(pnl);
          broadcast({ type: "signal_update", id: sig.id, status: "STOPPED", pnl });
          updates.push({ id: sig.id, status: "STOPPED", pnl });
          log("STOP", "Signal #" + sig.id + " | P&L $" + pnl.toFixed(0));
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
  underlying:     "SPY",
  gexSource:      "self-calculated (Alpaca chain)",
  sessionPnL:     sessionPnL.toFixed(2),
  dailyLoss:      dailyLoss.toFixed(2),
  dailyLossLimit: (ACCOUNT_SIZE * MAX_DAILY_LOSS).toFixed(2),
  expiry:         get0DTEExpiry(),
  gex: gexCache ? {
    regime:    gexCache.regime,
    gammaFlip: gexCache.gammaFlip,
    netGex:    gexCache.netGex,
    callWalls: gexCache.callWalls.slice(0, 3).map(w => "$" + w.price),
    putWalls:  gexCache.putWalls.slice(0, 3).map(w => "$" + w.price),
    updatedAt: gexCache.updatedAt,
  } : null,
  signals: {
    total:   signalHistory.length,
    pending: signalHistory.filter(s => s.status === "PENDING").length,
    active:  signalHistory.filter(s => ["SENT","FILLED","EXECUTING"].includes(s.status)).length,
    closed:  signalHistory.filter(s => ["TP1_HIT","STOPPED","CANCELLED"].includes(s.status)).length,
    blocked: signalHistory.filter(s => s.status === "BLOCKED").length,
  },
}));

// ── Schedulers ────────────────────────────────────────────────────────────────

// Auto-sync every 60s during market hours
setInterval(async () => {
  const now  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h    = now.getHours(), m = now.getMinutes();
  const mktOpen = (h > 9 || (h === 9 && m >= 30)) && h < 16;
  if (!mktOpen) return;
  if (!signalHistory.filter(s => ["SENT","FILLED"].includes(s.status)).length) return;
  try { await fetch("http://localhost:" + PORT + "/sync"); } catch (_) {}
}, 60000);

// GEX scheduler — runs every minute, fires at scheduled times
setInterval(async () => {
  const now   = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h     = now.getHours();
  const m     = now.getMinutes();
  const today = now.toLocaleDateString("en-CA");

  // Only during market hours
  const mktOpen = (h > 9 || (h === 9 && m >= 25)) && h < 16;
  if (!mktOpen) return;

  const key         = today + "_" + h + "_" + m;
  const isScheduled = GEX_SCHEDULE.some(s => s.h === h && s.m === m);

  if (isScheduled && !gexScheduleFired.has(key)) {
    gexScheduleFired.add(key);
    log("GEX", "Scheduled refresh at " + String(h).padStart(2,"0") + ":" + String(m).padStart(2,"0") + " ET");
    await getGEX(true);
  }
}, 60000);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log([
    "",
    " ╔══════════════════════════════════════════════════════╗",
    " ║   SPX COMMAND v6 · SPY + Self-Calculated GEX        ║",
    " ╠══════════════════════════════════════════════════════╣",
    " ║  Health  : GET  /                                    ║",
    " ║  Webhook : POST /webhook                             ║",
    " ║  Events  : GET  /events  (SSE)                       ║",
    " ║  GEX     : GET  /gex  (?refresh=true to force)       ║",
    " ║  Execute : POST /execute/:id                         ║",
    " ║  Cancel  : POST /cancel/:id                          ║",
    " ║  Sync    : GET  /sync                                ║",
    " ║  Status  : GET  /status                              ║",
    " ╠══════════════════════════════════════════════════════╣",
    " ║  Broker  : Alpaca (" + (IS_PAPER ? "PAPER" : "LIVE ") + ")                          ║",
    " ║  GEX     : Self-calculated from Alpaca chain         ║",
    " ║  Risk    : " + (RISK_PER_TRADE*100) + "% per trade ($" + (ACCOUNT_SIZE*RISK_PER_TRADE).toFixed(0) + ")                  ║",
    " ║  Spread  : $" + SPREAD_WIDTH_PTS + " wide · GEX buffer $" + GEX_BUFFER + "               ║",
    " ╚══════════════════════════════════════════════════════╝",
    "",
  ].join("\n"));
  await checkAccount();
  // Pre-fetch GEX if market is open right now
  const now  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h    = now.getHours(), m = now.getMinutes();
  const mktOpen = (h > 9 || (h === 9 && m >= 30)) && h < 16;
  if (mktOpen) {
    log("GEX", "Market is open — calculating initial GEX...");
    await getGEX(true);
  } else {
    log("GEX", "Market closed — GEX will calculate at 9:25 AM ET Monday");
  }
});
