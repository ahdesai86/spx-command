/**
 * SPX COMMAND — Alpaca Edition
 * ─────────────────────────────────────────────────────────────────────────────
 * TradingView webhook → SPXW 0DTE vertical debit spread → Alpaca Paper API
 *
 * No desktop app. No local sockets. No conid lookups.
 * Pure REST API — works fully on Railway (cloud).
 *
 * FLOW:
 *   1. TradingView fires webhook → POST /webhook
 *   2. Server parses signal, calculates strikes + position size
 *   3. Fetches live option chain from Alpaca to get exact OCC symbol
 *   4. Places bracket order (entry limit + stop + TP1) via Alpaca REST
 *   5. Dashboard receives real-time updates via SSE (/events)
 *   6. One-click execute from dashboard → POST /execute/:id
 *
 * ENV VARIABLES (set in Railway dashboard):
 *   ALPACA_KEY        — your Alpaca API key ID
 *   ALPACA_SECRET     — your Alpaca secret key
 *   ALPACA_BASE_URL   — https://paper-api.alpaca.markets  (paper)
 *                       https://api.alpaca.markets        (live — do NOT use until ready)
 *   ACCOUNT_SIZE      — 100000 (Alpaca paper default)
 *   RISK_PER_TRADE    — 0.02  (2%)
 *   MAX_DAILY_LOSS    — 0.06  (6%)
 *   SPREAD_WIDTH_PTS  — 10
 *   PREMIUM_STOP_PCT  — 0.50  (stop at 50% of debit paid)
 *   PORT              — 3001
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
const SPREAD_WIDTH_PTS = parseFloat(process.env.SPREAD_WIDTH_PTS || "10");
const PREMIUM_STOP_PCT = parseFloat(process.env.PREMIUM_STOP_PCT || "0.50");
const ORDER_RETRY_MAX  = parseInt(process.env.ORDER_RETRY_MAX    || "3");
const ORDER_RETRY_MS   = parseInt(process.env.ORDER_RETRY_MS     || "5000");
const PORT             = parseInt(process.env.PORT               || "3001");
const IS_PAPER         = ALPACA_BASE.includes("paper");

// ── State ─────────────────────────────────────────────────────────────────────
let sessionPnL    = 0;
let dailyLoss     = 0;
let signalHistory = [];
let sseClients    = [];

// ── Utilities ─────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const t = new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" });
  const line = "[" + t + " ET] [" + tag + "] " + msg;
  console.log(line);
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

async function alpacaGet(path, base = ALPACA_BASE) {
  const res = await fetch(base + path, { headers: alpacaHeaders() });
  if (!res.ok) {
    const err = await res.text();
    throw new Error("Alpaca GET " + path + " → " + res.status + ": " + err);
  }
  return res.json();
}

async function alpacaPost(path, body) {
  const res = await fetch(ALPACA_BASE + path, {
    method:  "POST",
    headers: alpacaHeaders(),
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error("Alpaca POST " + path + " → " + res.status + ": " + err);
  }
  return res.json();
}

async function alpacaDelete(path) {
  const res = await fetch(ALPACA_BASE + path, {
    method:  "DELETE",
    headers: alpacaHeaders(),
  });
  if (!res.ok && res.status !== 404) {
    const err = await res.text();
    throw new Error("Alpaca DELETE " + path + " → " + res.status + ": " + err);
  }
  return res.status;
}

// ── Alpaca account check ──────────────────────────────────────────────────────
async function checkAccount() {
  try {
    if (!ALPACA_KEY || !ALPACA_SECRET) {
      log("WARN", "No Alpaca API keys set — add ALPACA_KEY and ALPACA_SECRET in Railway env vars");
      return;
    }
    const acct = await alpacaGet("/v2/account");
    log("ALPACA", "Connected — " + (IS_PAPER ? "PAPER" : "LIVE") +
      " | Balance: $" + parseFloat(acct.portfolio_value).toLocaleString() +
      " | Buying power: $" + parseFloat(acct.buying_power).toLocaleString());
    broadcast({ type: "alpaca_status", connected: true, paper: IS_PAPER, balance: acct.portfolio_value });
  } catch (e) {
    log("ALPACA ERR", "Account check failed: " + e.message);
    broadcast({ type: "alpaca_status", connected: false });
  }
}

// ── Option symbol helpers ─────────────────────────────────────────────────────

/**
 * Build OCC option symbol for SPXW.
 * Format: SPXW{YYMMDD}{C|P}{strike padded to 8 digits}
 * Example: SPXW260603C05410000  (SPXW, Jun 3 2026, Call, strike 5410)
 */
function buildOCCSymbol(strike, right, expiryDate) {
  // expiryDate is a JS Date object
  const yy = String(expiryDate.getFullYear()).slice(2);
  const mm = String(expiryDate.getMonth() + 1).padStart(2, "0");
  const dd = String(expiryDate.getDate()).padStart(2, "0");
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, "0");
  return "SPXW" + yy + mm + dd + right + strikeStr;
}

/**
 * Get today's 0DTE expiry date.
 * SPXW expires every trading day Mon-Fri.
 * Returns a Date object for today (ET timezone aware).
 */
function get0DTEDate() {
  // Use ET timezone
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return now;
}

function get0DTEExpiry() {
  const d = get0DTEDate();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

function nearestStrike(price, direction, isShortLeg) {
  const base = Math.round(price / 5) * 5;
  if (!isShortLeg) return base;
  return direction === "LONG" ? base + SPREAD_WIDTH_PTS : base - SPREAD_WIDTH_PTS;
}

function calcContracts() {
  const budget   = ACCOUNT_SIZE * RISK_PER_TRADE;
  const estDebit = SPREAD_WIDTH_PTS * 0.45;
  const maxLoss  = estDebit * 100;
  return Math.max(1, Math.floor(budget / maxLoss));
}

/**
 * Verify option symbols exist on Alpaca by fetching their snapshot.
 * Returns true if both legs are tradeable.
 */
async function verifyOptionSymbols(longSymbol, shortSymbol) {
  try {
    const res = await fetch(
      ALPACA_DATA + "/v1beta1/options/snapshots?symbols=" + longSymbol + "," + shortSymbol,
      { headers: alpacaHeaders() }
    );
    if (!res.ok) return false;
    const data = await res.json();
    const snapshots = data.snapshots || {};
    return snapshots[longSymbol] != null && snapshots[shortSymbol] != null;
  } catch (_) {
    return false;
  }
}

/**
 * Get mid price for an option symbol from Alpaca market data.
 */
async function getOptionMidPrice(symbol) {
  try {
    const res = await fetch(
      ALPACA_DATA + "/v1beta1/options/snapshots?symbols=" + symbol,
      { headers: alpacaHeaders() }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const snap = (data.snapshots || {})[symbol];
    if (!snap || !snap.latestQuote) return null;
    const bid = parseFloat(snap.latestQuote.bp || 0);
    const ask = parseFloat(snap.latestQuote.ap || 0);
    if (bid <= 0 || ask <= 0) return null;
    return parseFloat(((bid + ask) / 2).toFixed(2));
  } catch (_) {
    return null;
  }
}

// ── Place bracket order on Alpaca ─────────────────────────────────────────────
/**
 * Alpaca options orders use the standard v2/orders endpoint.
 * For a vertical spread we place two separate orders:
 *   1. BUY long leg  (limit at mid)
 *   2. SELL short leg (limit at mid)
 * Then attach stop and TP as separate closing orders once filled.
 *
 * Note: Alpaca does not support multi-leg combo orders natively yet.
 * We place legs separately but treat them as a spread for P&L tracking.
 */
async function placeSpreadOrders(signal) {
  const expiryDate  = get0DTEDate();
  const longSymbol  = buildOCCSymbol(signal.longStrike,  signal.right, expiryDate);
  const shortSymbol = buildOCCSymbol(signal.shortStrike, signal.right, expiryDate);

  log("ALPACA", "Verifying option symbols: " + longSymbol + " / " + shortSymbol);

  // Verify symbols exist
  const valid = await verifyOptionSymbols(longSymbol, shortSymbol);
  if (!valid) {
    throw new Error("Option symbols not found on Alpaca — market may be closed or strikes invalid");
  }

  // Get live mid prices
  const longMid  = await getOptionMidPrice(longSymbol)  || signal.estDebit;
  const shortMid = await getOptionMidPrice(shortSymbol) || (signal.estDebit * 0.45);
  const netDebit = parseFloat((longMid - shortMid).toFixed(2));

  log("ALPACA", "Live prices — long leg mid: $" + longMid + " | short leg mid: $" + shortMid + " | net debit: $" + netDebit);

  // Buy long leg
  const buyOrder = await alpacaPost("/v2/orders", {
    symbol:        longSymbol,
    qty:           String(signal.contracts),
    side:          "buy",
    type:          "limit",
    limit_price:   String(longMid),
    time_in_force: "day",
    order_class:   "simple",
    client_order_id: "spxcmd_long_" + signal.id,
  });

  log("ALPACA", "Long leg order placed: " + buyOrder.id + " | " + longSymbol + " x" + signal.contracts + " @ $" + longMid);

  // Sell short leg (opens the short side of the spread)
  const sellOrder = await alpacaPost("/v2/orders", {
    symbol:        shortSymbol,
    qty:           String(signal.contracts),
    side:          "sell",
    type:          "limit",
    limit_price:   String(shortMid),
    time_in_force: "day",
    order_class:   "simple",
    client_order_id: "spxcmd_short_" + signal.id,
  });

  log("ALPACA", "Short leg order placed: " + sellOrder.id + " | " + shortSymbol + " x" + signal.contracts + " @ $" + shortMid);

  return {
    longSymbol,  shortSymbol,
    longOrderId:  buyOrder.id,
    shortOrderId: sellOrder.id,
    netDebit,
    longMid, shortMid,
  };
}

/**
 * Place closing bracket orders (stop + TP1) after entry fills.
 * Called after polling confirms entry is filled.
 */
async function placeBracketClosing(signal) {
  const expiryDate  = get0DTEDate();
  const longSymbol  = signal.longSymbol;
  const netDebit    = signal.fillDebit || signal.estDebit;
  const stopPrice   = parseFloat((netDebit * (1 - PREMIUM_STOP_PCT)).toFixed(2));
  const tp1Price    = parseFloat((netDebit * 2.0).toFixed(2));

  // Stop: sell long leg if premium drops 50%
  const stopOrder = await alpacaPost("/v2/orders", {
    symbol:        longSymbol,
    qty:           String(signal.contracts),
    side:          "sell",
    type:          "stop",
    stop_price:    String(stopPrice),
    time_in_force: "day",
    client_order_id: "spxcmd_stop_" + signal.id,
  });

  // TP1: sell long leg at 2x debit
  const tp1Order = await alpacaPost("/v2/orders", {
    symbol:        longSymbol,
    qty:           String(signal.contracts),
    side:          "sell",
    type:          "limit",
    limit_price:   String(tp1Price),
    time_in_force: "day",
    client_order_id: "spxcmd_tp1_" + signal.id,
  });

  log("ALPACA", "Bracket placed — stop @ $" + stopPrice + " | TP1 @ $" + tp1Price);

  return {
    stopOrderId:  stopOrder.id,
    tp1OrderId:   tp1Order.id,
    stopPrice,
    tp1Price,
  };
}

/**
 * Poll Alpaca order status until filled or timeout.
 */
async function pollOrderFill(orderId, maxWaitMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const order = await alpacaGet("/v2/orders/" + orderId);
    if (order.status === "filled") return order;
    if (["cancelled","expired","rejected"].includes(order.status)) {
      throw new Error("Order " + orderId + " " + order.status);
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return null; // timed out — order still pending
}

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check — Railway uses this to verify the service is running
app.get("/", (req, res) => {
  res.json({
    service: "SPX COMMAND",
    status:  "running",
    mode:    IS_PAPER ? "PAPER" : "LIVE",
    version: "4.0-alpaca",
    time:    new Date().toISOString(),
  });
});

// SSE — dashboard real-time feed
app.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  sseClients.push(res);
  log("SSE", "Dashboard connected (" + sseClients.length + " client(s))");

  // Send current state on connect
  res.write("data: " + JSON.stringify({
    type: "init",
    sessionPnL, dailyLoss,
    signals: signalHistory,
    expiry:  get0DTEExpiry(),
  }) + "\n\n");

  // Keepalive ping every 30s
  const ping = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) { clearInterval(ping); }
  }, 30000);

  req.on("close", () => {
    clearInterval(ping);
    sseClients = sseClients.filter(c => c !== res);
    log("SSE", "Dashboard disconnected (" + sseClients.length + " client(s))");
  });
});

// Webhook — TradingView posts here
app.post("/webhook", (req, res) => {
  const raw = req.body;
  log("WEBHOOK", JSON.stringify(raw));

  const required = ["symbol", "direction", "entry", "stop", "tp1", "tp2"];
  const missing  = required.filter(k => raw[k] == null);
  if (missing.length) return res.status(400).json({ error: "Missing fields", missing });

  if (dailyLoss >= ACCOUNT_SIZE * MAX_DAILY_LOSS) {
    log("GUARD", "Daily loss limit $" + (ACCOUNT_SIZE * MAX_DAILY_LOSS).toFixed(0) + " reached — signal rejected");
    return res.json({ status: "rejected", reason: "daily_loss_limit" });
  }

  const entry      = parseFloat(raw.entry);
  const stop       = parseFloat(raw.stop);
  const tp1        = parseFloat(raw.tp1);
  const tp2        = parseFloat(raw.tp2);
  const direction  = raw.direction.toUpperCase();
  const right      = direction === "LONG" ? "C" : "P";
  const longStrike  = nearestStrike(entry, direction, false);
  const shortStrike = nearestStrike(entry, direction, true);
  const contracts   = calcContracts();
  const estDebit    = parseFloat((SPREAD_WIDTH_PTS * 0.45).toFixed(2));
  const premiumStop = parseFloat((estDebit * (1 - PREMIUM_STOP_PCT)).toFixed(2));
  const tp1Price    = parseFloat((estDebit * 2.0).toFixed(2));
  const ptRisk      = Math.abs(entry - stop);
  const ptReward    = Math.abs(tp1 - entry);

  const signal = {
    id:           Date.now(),
    time:         new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" }),
    symbol:       "SPXW",
    direction,    entry, stop, tp1, tp2,
    right,        longStrike, shortStrike,
    expiry:       get0DTEExpiry(),
    contracts,
    spreadWidth:  SPREAD_WIDTH_PTS,
    estDebit,     premiumStop, tp1Price,
    estMaxLoss:   (estDebit * 100 * contracts).toFixed(0),
    rr:           (ptReward / ptRisk).toFixed(1) + ":1",
    trigger:      raw.trigger    || "TradingView Alert",
    confidence:   raw.confidence || "MEDIUM",
    status:       "PENDING",
    // Filled in after execution:
    longSymbol:   null,
    shortSymbol:  null,
    longOrderId:  null,
    shortOrderId: null,
    stopOrderId:  null,
    tp1OrderId:   null,
    fillDebit:    null,
  };

  signalHistory.unshift(signal);
  broadcast({ type: "new_signal", signal });
  log("SIGNAL",
    direction + " SPXW " + longStrike + "/" + shortStrike + " " + right +
    " exp:" + signal.expiry +
    " x" + contracts +
    " | est debit $" + estDebit +
    " | stop $" + premiumStop +
    " | tp1 $" + tp1Price
  );

  // ── AUTO-EXECUTE immediately — no dashboard click needed ──────────────────
  res.json({ status: "received", signal });
  executeSignal(signal.id);
});

// ── Core execute function — called automatically on every signal ──────────────
async function executeSignal(id) {
  const signal = signalHistory.find(s => s.id === id);
  if (!signal)                     return log("ERROR", "executeSignal: signal #" + id + " not found");
  if (signal.status !== "PENDING") return log("ERROR", "executeSignal: signal #" + id + " not pending (" + signal.status + ")");

  if (!ALPACA_KEY || !ALPACA_SECRET) {
    log("ERROR", "Alpaca API keys not configured — add ALPACA_KEY and ALPACA_SECRET in Railway env vars");
    return;
  }

  signal.status = "EXECUTING";
  broadcast({ type: "signal_update", id, status: "EXECUTING" });
  log("AUTO", "Auto-executing signal #" + id + " — " + signal.direction + " SPXW " + signal.longStrike + "/" + signal.shortStrike);

  try {
    const result = await placeSpreadOrders(signal);

    signal.longSymbol   = result.longSymbol;
    signal.shortSymbol  = result.shortSymbol;
    signal.longOrderId  = result.longOrderId;
    signal.shortOrderId = result.shortOrderId;
    signal.fillDebit    = result.netDebit;
    signal.status       = "SENT";

    broadcast({
      type: "signal_update", id, status: "SENT",
      longSymbol:  result.longSymbol,
      shortSymbol: result.shortSymbol,
      longOrderId:  result.longOrderId,
      shortOrderId: result.shortOrderId,
      fillDebit:    result.netDebit,
    });

    log("AUTO", "Orders placed — polling for fill...");

    pollOrderFill(result.longOrderId, 60000).then(async (filled) => {
      if (!filled) {
        log("ORDER", "Long leg unfilled after 60s — signal #" + id + " remains open");
        return;
      }
      const fillPrice  = parseFloat(filled.filled_avg_price || result.longMid);
      signal.fillPrice = fillPrice;
      signal.status    = "FILLED";
      broadcast({ type: "signal_update", id, status: "FILLED", fillPrice });
      log("FILL", "Filled @ $" + fillPrice + " | placing bracket...");

      try {
        const bracket      = await placeBracketClosing(signal);
        signal.stopOrderId = bracket.stopOrderId;
        signal.tp1OrderId  = bracket.tp1OrderId;
        signal.stopPrice   = bracket.stopPrice;
        signal.tp1Price    = bracket.tp1Price;
        broadcast({
          type: "signal_update", id,
          stopOrderId: bracket.stopOrderId,
          tp1OrderId:  bracket.tp1OrderId,
          stopPrice:   bracket.stopPrice,
          tp1Price:    bracket.tp1Price,
        });
        log("AUTO", "Bracket attached — stop $" + bracket.stopPrice + " | tp1 $" + bracket.tp1Price);
      } catch (bracketErr) {
        log("ERROR", "Bracket failed for signal #" + id + ": " + bracketErr.message);
      }
    }).catch(err => {
      log("ERROR", "Fill poll error signal #" + id + ": " + err.message);
      signal.status = "PENDING";
      broadcast({ type: "signal_update", id, status: "PENDING" });
    });

  } catch (err) {
    signal.status = "PENDING";
    broadcast({ type: "signal_update", id, status: "PENDING" });
    log("ERROR", "Auto-execute failed signal #" + id + ": " + err.message);
  }
}

// Execute — manual fallback (dashboard or direct API call)
app.post("/execute/:id", async (req, res) => {
  const id     = parseInt(req.params.id);
  const signal = signalHistory.find(s => s.id === id);
  if (!signal)                     return res.status(404).json({ error: "Signal not found" });
  if (signal.status !== "PENDING") return res.status(400).json({ error: "Signal not pending — status: " + signal.status });
  res.json({ status: "executing", id });
  executeSignal(id);
});

// Cancel — cancels all open orders for a signal
app.post("/cancel/:id", async (req, res) => {
  const id  = parseInt(req.params.id);
  const sig = signalHistory.find(s => s.id === id);
  if (!sig) return res.status(404).json({ error: "Not found" });

  const orderIds = [sig.longOrderId, sig.shortOrderId, sig.stopOrderId, sig.tp1OrderId].filter(Boolean);

  for (const oid of orderIds) {
    try {
      await alpacaDelete("/v2/orders/" + oid);
      log("CANCEL", "Cancelled Alpaca order " + oid);
    } catch (e) {
      log("WARN", "Could not cancel " + oid + ": " + e.message);
    }
  }

  sig.status = "CANCELLED";
  broadcast({ type: "signal_update", id, status: "CANCELLED" });
  log("CANCEL", "Signal #" + id + " cancelled — " + orderIds.length + " orders cancelled on Alpaca");
  res.json({ status: "cancelled", cancelled: orderIds.length });
});

// Sync — pull latest order statuses from Alpaca
app.get("/sync", async (req, res) => {
  const active = signalHistory.filter(s => ["SENT","FILLED"].includes(s.status));
  const updates = [];

  for (const sig of active) {
    try {
      if (sig.tp1OrderId) {
        const tp1 = await alpacaGet("/v2/orders/" + sig.tp1OrderId);
        if (tp1.status === "filled") {
          const pnl = (parseFloat(tp1.filled_avg_price) - (sig.fillDebit || sig.estDebit)) * 100 * sig.contracts;
          sig.status   = "TP1_HIT";
          sig.closePnl = pnl;
          sessionPnL  += pnl;
          broadcast({ type: "signal_update", id: sig.id, status: "TP1_HIT", pnl });
          updates.push({ id: sig.id, status: "TP1_HIT", pnl });
          log("TP1", "Signal #" + sig.id + " TP1 hit | P&L $" + pnl.toFixed(0));
        }
      }
      if (sig.stopOrderId && sig.status !== "TP1_HIT") {
        const sl = await alpacaGet("/v2/orders/" + sig.stopOrderId);
        if (sl.status === "filled") {
          const pnl = (parseFloat(sl.filled_avg_price) - (sig.fillDebit || sig.estDebit)) * 100 * sig.contracts;
          sig.status   = "STOPPED";
          sig.closePnl = pnl;
          sessionPnL  += pnl;
          dailyLoss   += Math.abs(pnl);
          broadcast({ type: "signal_update", id: sig.id, status: "STOPPED", pnl });
          updates.push({ id: sig.id, status: "STOPPED", pnl });
          log("STOP", "Signal #" + sig.id + " stopped | P&L $" + pnl.toFixed(0));
        }
      }
    } catch (e) {
      log("SYNC ERR", "Signal #" + sig.id + ": " + e.message);
    }
  }

  res.json({ synced: active.length, updates });
});

// Status
app.get("/status", (req, res) => {
  res.json({
    mode:           IS_PAPER ? "PAPER" : "LIVE",
    broker:         "Alpaca",
    sessionPnL:     sessionPnL.toFixed(2),
    dailyLoss:      dailyLoss.toFixed(2),
    dailyLossLimit: (ACCOUNT_SIZE * MAX_DAILY_LOSS).toFixed(2),
    expiry:         get0DTEExpiry(),
    signals: {
      total:    signalHistory.length,
      pending:  signalHistory.filter(s => s.status === "PENDING").length,
      active:   signalHistory.filter(s => ["SENT","FILLED","EXECUTING"].includes(s.status)).length,
      closed:   signalHistory.filter(s => ["TP1_HIT","STOPPED","CANCELLED"].includes(s.status)).length,
    },
  });
});

// Auto-sync every 60s during market hours
setInterval(async () => {
  const now    = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const hour   = now.getHours();
  const minute = now.getMinutes();
  const isMarketHours = (hour > 9 || (hour === 9 && minute >= 30)) && hour < 16;
  if (!isMarketHours) return;
  const active = signalHistory.filter(s => ["SENT","FILLED"].includes(s.status));
  if (active.length === 0) return;
  try {
    const res = await fetch("http://localhost:" + PORT + "/sync");
    const data = await res.json();
    if (data.updates && data.updates.length > 0) {
      log("SYNC", data.updates.length + " order(s) updated");
    }
  } catch (_) {}
}, 60000);

// Start
app.listen(PORT, async () => {
  console.log([
    "",
    " ╔══════════════════════════════════════════════════════╗",
    " ║   SPX COMMAND v4 · Alpaca Edition                   ║",
    " ╠══════════════════════════════════════════════════════╣",
    " ║  Health  : GET  /                                    ║",
    " ║  Webhook : POST /webhook                             ║",
    " ║  Events  : GET  /events  (SSE)                       ║",
    " ║  Execute : POST /execute/:id                         ║",
    " ║  Cancel  : POST /cancel/:id                          ║",
    " ║  Sync    : GET  /sync                                ║",
    " ║  Status  : GET  /status                              ║",
    " ╠══════════════════════════════════════════════════════╣",
    " ║  Broker     : Alpaca (" + (IS_PAPER ? "PAPER" : "LIVE ") + ")                        ║",
    " ║  Instrument : SPXW 0DTE vertical debit spread        ║",
    " ║  Risk/trade : " + (RISK_PER_TRADE * 100) + "% ($" + (ACCOUNT_SIZE * RISK_PER_TRADE).toFixed(0) + ")                          ║",
    " ║  Daily limit: " + (MAX_DAILY_LOSS * 100) + "% ($" + (ACCOUNT_SIZE * MAX_DAILY_LOSS).toFixed(0) + ")                        ║",
    " ╚══════════════════════════════════════════════════════╝",
    "",
  ].join("\n"));

  await checkAccount();
});
