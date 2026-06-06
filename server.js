/**
 * SPX COMMAND v5 — SPY Options (ORB + VWAP)
 * ─────────────────────────────────────────────────────────────────────────────
 * TradingView webhook → SPY 0DTE options → Alpaca Paper API
 * GEX: disabled (FlashAlpha Basic plan required for SPY/SPX data)
 * Strategy: ORB breakout + VWAP + RSI confirmation
 *
 * ENV VARIABLES:
 *   ALPACA_KEY         — Alpaca API key ID
 *   ALPACA_SECRET      — Alpaca secret key
 *   ALPACA_BASE_URL    — https://paper-api.alpaca.markets
 *   ACCOUNT_SIZE       — 100000
 *   RISK_PER_TRADE     — 0.02
 *   MAX_DAILY_LOSS     — 0.06
 *   SPREAD_WIDTH_PTS   — 2  (SPY uses $2 wide spreads, not 10pt like SPXW)
 *   PREMIUM_STOP_PCT   — 0.50
 *   PORT               — 3001
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");

// ── Config ────────────────────────────────────────────────────────────────────
const ALPACA_KEY        = process.env.ALPACA_KEY        || "";
const ALPACA_SECRET     = process.env.ALPACA_SECRET     || "";
const ALPACA_BASE       = (process.env.ALPACA_BASE_URL  || "https://paper-api.alpaca.markets").replace(/\/$/, "");
const ALPACA_DATA       = "https://data.alpaca.markets";
const ACCOUNT_SIZE      = parseFloat(process.env.ACCOUNT_SIZE      || "100000");
const RISK_PER_TRADE    = parseFloat(process.env.RISK_PER_TRADE    || "0.02");
const MAX_DAILY_LOSS    = parseFloat(process.env.MAX_DAILY_LOSS    || "0.06");
const SPREAD_WIDTH_PTS  = parseFloat(process.env.SPREAD_WIDTH_PTS  || "2");
const PREMIUM_STOP_PCT  = parseFloat(process.env.PREMIUM_STOP_PCT  || "0.50");
const ORDER_RETRY_MAX   = parseInt(process.env.ORDER_RETRY_MAX     || "3");
const ORDER_RETRY_MS    = parseInt(process.env.ORDER_RETRY_MS      || "5000");
const PORT              = parseInt(process.env.PORT                || "3001");
const IS_PAPER          = ALPACA_BASE.includes("paper");

// ── State ─────────────────────────────────────────────────────────────────────
let sessionPnL    = 0;
let dailyLoss     = 0;
let signalHistory = [];
let sseClients    = [];
// GEX disabled — FlashAlpha Basic plan required for SPY/SPX data
// To enable: upgrade at flashalpha.com/pricing and uncomment GEX logic
const GEX_ENABLED = false;

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

// ── FlashAlpha GEX ────────────────────────────────────────────────────────────

/**
 * Fetch GEX levels from FlashAlpha API.
 * Returns { callWalls, putWalls, magnet, netGex, updatedAt }
 * callWalls and putWalls are arrays of price levels sorted by GEX magnitude.
 */

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

// ── SPY Option symbol helpers ─────────────────────────────────────────────────

/**
 * Build OCC option symbol for SPY.
 * Format: SPY{YYMMDD}{C|P}{strike padded to 8 digits with 3 decimal places}
 * Example: SPY260604C00540000 (SPY, Jun 4 2026, Call, strike $540)
 */
function buildSPYSymbol(strike, right, expiryDate) {
  const yy = String(expiryDate.getFullYear()).slice(2);
  const mm = String(expiryDate.getMonth() + 1).padStart(2, "0");
  const dd = String(expiryDate.getDate()).padStart(2, "0");
  // OCC format: strike * 1000, padded to 8 digits
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, "0");
  return "SPY" + yy + mm + dd + right + strikeStr;
}

function get0DTEDate() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
}

function get0DTEExpiry() {
  const d  = get0DTEDate();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

/**
 * For SPY, strike spacing is $1. Round to nearest $1.
 * Long leg = ATM (nearest $1 to entry)
 * Short leg = OTM by SPREAD_WIDTH_PTS ($2 default)
 */
function nearestSPYStrike(price, direction, isShortLeg) {
  const base = Math.round(price);  // SPY strikes at $1 intervals
  if (!isShortLeg) return base;
  return direction === "LONG" ? base + SPREAD_WIDTH_PTS : base - SPREAD_WIDTH_PTS;
}

function calcContracts() {
  const budget   = ACCOUNT_SIZE * RISK_PER_TRADE;   // $2000
  const estDebit = SPREAD_WIDTH_PTS * 0.45;          // ~$0.90 for $2 wide spread
  const maxLoss  = estDebit * 100;                   // $90 per contract
  return Math.max(1, Math.floor(budget / maxLoss));
}

async function getOptionMidPrice(symbol) {
  try {
    const res = await fetch(ALPACA_DATA + "/v1beta1/options/snapshots?symbols=" + symbol, { headers: alpacaHeaders() });
    if (!res.ok) return null;
    const data = await res.json();
    const snap = (data.snapshots || {})[symbol];
    if (!snap || !snap.latestQuote) return null;
    const bid = parseFloat(snap.latestQuote.bp || 0);
    const ask = parseFloat(snap.latestQuote.ap || 0);
    if (bid <= 0 || ask <= 0) return null;
    return parseFloat(((bid + ask) / 2).toFixed(2));
  } catch (_) { return null; }
}

async function verifyOptionSymbols(longSymbol, shortSymbol) {
  try {
    const res = await fetch(ALPACA_DATA + "/v1beta1/options/snapshots?symbols=" + longSymbol + "," + shortSymbol, { headers: alpacaHeaders() });
    if (!res.ok) return false;
    const data = await res.json();
    const snaps = data.snapshots || {};
    return snaps[longSymbol] != null && snaps[shortSymbol] != null;
  } catch (_) { return false; }
}

// ── Place SPY spread orders ───────────────────────────────────────────────────
async function placeSpreadOrders(signal) {
  const expiryDate  = get0DTEDate();
  const longSymbol  = buildSPYSymbol(signal.longStrike,  signal.right, expiryDate);
  const shortSymbol = buildSPYSymbol(signal.shortStrike, signal.right, expiryDate);

  log("ALPACA", "Verifying SPY option symbols: " + longSymbol + " / " + shortSymbol);

  const valid = await verifyOptionSymbols(longSymbol, shortSymbol);
  if (!valid) throw new Error("SPY option symbols not found — market may be closed or strikes invalid");

  const longMid  = await getOptionMidPrice(longSymbol)  || signal.estDebit;
  const shortMid = await getOptionMidPrice(shortSymbol) || parseFloat((signal.estDebit * 0.45).toFixed(2));
  const netDebit = parseFloat((longMid - shortMid).toFixed(2));

  log("ALPACA", "Live mid prices — long: $" + longMid + " | short: $" + shortMid + " | net debit: $" + netDebit);

  const buyOrder = await alpacaPost("/v2/orders", {
    symbol:           longSymbol,
    qty:              String(signal.contracts),
    side:             "buy",
    type:             "limit",
    limit_price:      String(longMid),
    time_in_force:    "day",
    order_class:      "simple",
    client_order_id:  "spxcmd_long_" + signal.id,
  });

  log("ALPACA", "Long leg placed: " + buyOrder.id + " | " + longSymbol + " x" + signal.contracts + " @ $" + longMid);

  const sellOrder = await alpacaPost("/v2/orders", {
    symbol:           shortSymbol,
    qty:              String(signal.contracts),
    side:             "sell",
    type:             "limit",
    limit_price:      String(shortMid),
    time_in_force:    "day",
    order_class:      "simple",
    client_order_id:  "spxcmd_short_" + signal.id,
  });

  log("ALPACA", "Short leg placed: " + sellOrder.id + " | " + shortSymbol + " x" + signal.contracts + " @ $" + shortMid);

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

  log("ALPACA", "Bracket placed — stop $" + stopPrice + " | tp1 $" + tp1Price);
  return { stopOrderId: stopOrder.id, tp1OrderId: tp1Order.id, stopPrice, tp1Price };
}

async function pollOrderFill(orderId, maxWaitMs) {
  maxWaitMs = maxWaitMs || 30000;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const order = await alpacaGet("/v2/orders/" + orderId);
    if (order.status === "filled") return order;
    if (["cancelled","expired","rejected"].includes(order.status)) throw new Error("Order " + orderId + " " + order.status);
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// ── Core execute function ─────────────────────────────────────────────────────
async function executeSignal(id) {
  const signal = signalHistory.find(s => s.id === id);
  if (!signal)                     return log("ERROR", "executeSignal: #" + id + " not found");
  if (signal.status !== "PENDING") return log("WARN",  "executeSignal: #" + id + " not pending (" + signal.status + ")");
  if (!ALPACA_KEY || !ALPACA_SECRET) return log("ERROR", "Alpaca keys not configured");

  signal.status = "EXECUTING";
  broadcast({ type: "signal_update", id, status: "EXECUTING" });
  log("AUTO", "Auto-executing #" + id + " | " + signal.direction + " SPY " + signal.longStrike + "/" + signal.shortStrike);

  try {
    const result       = await placeSpreadOrders(signal);
    signal.longSymbol  = result.longSymbol;
    signal.shortSymbol = result.shortSymbol;
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
      } catch (e) { log("ERROR", "Bracket failed #" + id + ": " + e.message); }
    }).catch(e => {
      log("ERROR", "Poll failed #" + id + ": " + e.message);
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
  version: "5.0-spy-gex", time: new Date().toISOString(),
}));

// SSE
app.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();
  sseClients.push(res);
  res.write("data: " + JSON.stringify({ type: "init", sessionPnL, dailyLoss, signals: signalHistory, expiry: get0DTEExpiry() }) + "\n\n");
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch (_) { clearInterval(ping); } }, 30000);
  req.on("close", () => { clearInterval(ping); sseClients = sseClients.filter(c => c !== res); });
});

// GEX endpoint — returns latest GEX levels
app.get("/gex", async (req, res) => {
  res.json({ status: "disabled", message: "GEX requires FlashAlpha Basic plan", info: "flashalpha.com/pricing" });
});

// Webhook — TradingView posts here
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

  // GEX disabled — use ORB targets directly
  const finalTP1 = tp1;
  const finalTP2 = tp2;

  const signal = {
    id:           Date.now(),
    time:         new Date().toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" }),
    symbol:       "SPY",
    direction,    entry, stop,
    tp1:          finalTP1,
    tp2:          finalTP2,
    right,        longStrike, shortStrike,
    expiry:       get0DTEExpiry(),
    contracts,
    spreadWidth:  SPREAD_WIDTH_PTS,
    estDebit,     premiumStop,
    estMaxLoss:   (estDebit * 100 * contracts).toFixed(0),
    rr:           (ptReward / ptRisk).toFixed(1) + ":1",
    trigger:      raw.trigger    || "TradingView Alert",
    confidence:   raw.confidence || "MEDIUM",
    status:       "PENDING",
    longSymbol:   null, shortSymbol:  null,
    longOrderId:  null, shortOrderId: null,
    stopOrderId:  null, tp1OrderId:   null,
    fillDebit:    null,
  };

  res.json({ status: "received", signal });
  executeSignal(signal.id);
});

// Manual execute fallback
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

// Sync
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
  mode: IS_PAPER ? "PAPER" : "LIVE", broker: "Alpaca", underlying: "SPY",
  sessionPnL: sessionPnL.toFixed(2), dailyLoss: dailyLoss.toFixed(2),
  dailyLossLimit: (ACCOUNT_SIZE * MAX_DAILY_LOSS).toFixed(2),
  expiry: get0DTEExpiry(),
  gex: null,
  signals: {
    total:   signalHistory.length,
    pending: signalHistory.filter(s => s.status === "PENDING").length,
    active:  signalHistory.filter(s => ["SENT","FILLED","EXECUTING"].includes(s.status)).length,
    closed:  signalHistory.filter(s => ["TP1_HIT","STOPPED","CANCELLED"].includes(s.status)).length,
    blocked: signalHistory.filter(s => s.status === "BLOCKED").length,
  },
}));

// Auto-sync every 60s during market hours
setInterval(async () => {
  const now  = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  const h    = now.getHours(), m = now.getMinutes();
  const mktOpen = (h > 9 || (h === 9 && m >= 30)) && h < 16;
  if (!mktOpen) return;
  if (!signalHistory.filter(s => ["SENT","FILLED"].includes(s.status)).length) return;
  try { await fetch("http://localhost:" + PORT + "/sync"); } catch (_) {}
}, 60000);


// Start
app.listen(PORT, async () => {
  console.log([
    "",
    " ╔══════════════════════════════════════════════════════╗",
    " ║   SPX COMMAND v5 · SPY Options + FlashAlpha GEX     ║",
    " ╠══════════════════════════════════════════════════════╣",
    " ║  Health  : GET  /                                    ║",
    " ║  Webhook : POST /webhook                             ║",
    " ║  Events  : GET  /events  (SSE)                       ║",
    " ║  GEX     : GET  /gex                                 ║",
    " ║  Execute : POST /execute/:id                         ║",
    " ║  Cancel  : POST /cancel/:id                          ║",
    " ║  Sync    : GET  /sync                                ║",
    " ║  Status  : GET  /status                              ║",
    " ╠══════════════════════════════════════════════════════╣",
    " ║  Broker     : Alpaca (" + (IS_PAPER ? "PAPER" : "LIVE ") + ")                        ║",
    " ║  Underlying : SPY 0DTE vertical debit spread         ║",
    " ║  GEX        : Disabled (upgrade FlashAlpha)          ║",
    " ║  Risk/trade : " + (RISK_PER_TRADE * 100) + "% ($" + (ACCOUNT_SIZE * RISK_PER_TRADE).toFixed(0) + ")                         ║",
    " ║  Spread     : $2 wide · ORB + VWAP signals only       ║",
    " ╚══════════════════════════════════════════════════════╝",
    "",
  ].join("\n"));
  await checkAccount();
  log("GEX", "GEX disabled — upgrade FlashAlpha to Basic plan to enable");
});
