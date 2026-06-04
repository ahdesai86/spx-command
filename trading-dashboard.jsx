import { useState, useEffect, useRef, useCallback } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// Local dev:  SERVER = "http://localhost:3001"
// Production: SERVER = "https://your-app.up.railway.app"
// Claude artifact preview: DEMO_MODE = true (no outbound connections)
// ─────────────────────────────────────────────────────────────────────────────
const SERVER    = typeof window !== "undefined" && window.location.hostname === "localhost"
  ? "http://localhost:3001"
  : null;
const DEMO_MODE = !SERVER;

// ── Constants ─────────────────────────────────────────────────────────────────
const S = {
  PENDING:   { color: "#F5A623", label: "PENDING"           },
  EXECUTING: { color: "#00C2FF", label: "EXECUTING..."      },
  SENT:      { color: "#BF7FFF", label: "ORDERS SENT"       },
  FILLED:    { color: "#00E5A0", label: "FILLED · LIVE"     },
  TP1_HIT:   { color: "#00E5A0", label: "TARGET HIT ✓"      },
  STOPPED:   { color: "#FF3D5A", label: "STOPPED ✗"         },
  CANCELLED: { color: "#444",    label: "CANCELLED"         },
};

const DIR = {
  LONG:  { color: "#00E5A0", bg: "#00E5A012" },
  SHORT: { color: "#FF3D5A", bg: "#FF3D5A12" },
};

// ── Demo data ─────────────────────────────────────────────────────────────────
const DEMO_SIGNALS = [
  {
    id: 1001, time: "09:34:22", symbol: "SPXW", direction: "LONG",
    entry: 5418.0, stop: 5410.0, tp1: 5428.0, tp2: 5438.0,
    longStrike: 5415, shortStrike: 5425, right: "C", expiry: "20260603",
    spreadWidth: 10, estDebit: 4.60, premiumStop: 2.30, tp1Price: 9.20,
    estMaxLoss: "460", contracts: 1, rr: "2.4:1",
    trigger: "ORB Breakout + VWAP Reclaim", confidence: "HIGH",
    status: "PENDING",
    longSymbol: "SPXW260603C05415000", shortSymbol: "SPXW260603C05425000",
    fillDebit: null,
  },
  {
    id: 1002, time: "09:52:11", symbol: "SPXW", direction: "SHORT",
    entry: 5404.0, stop: 5412.0, tp1: 5394.0, tp2: 5384.0,
    longStrike: 5405, shortStrike: 5395, right: "P", expiry: "20260603",
    spreadWidth: 10, estDebit: 4.20, premiumStop: 2.10, tp1Price: 8.40,
    estMaxLoss: "420", contracts: 1, rr: "1.9:1",
    trigger: "VWAP Rejection + ORB Fade", confidence: "MEDIUM",
    status: "FILLED", fillPrice: 4.35, fillDebit: 4.35,
    longSymbol: "SPXW260603P05405000", shortSymbol: "SPXW260603P05395000",
    stopPrice: 2.18, tp1Price: 8.70,
  },
];

const DEMO_LOGS = [
  { time: "09:30:00", tag: "ALPACA", msg: "Connected — PAPER | Balance: $100,000 | Buying power: $100,000" },
  { time: "09:34:20", tag: "WEBHOOK", msg: "{direction:LONG, entry:5418, stop:5410, tp1:5428}" },
  { time: "09:34:21", tag: "SIGNAL", msg: "LONG SPXW 5415/5425 C exp:20260603 x1 | est debit $4.60" },
  { time: "09:52:10", tag: "WEBHOOK", msg: "{direction:SHORT, entry:5404, stop:5412, tp1:5394}" },
  { time: "09:52:11", tag: "SIGNAL", msg: "SHORT SPXW 5405/5395 P exp:20260603 x1 | est debit $4.20" },
  { time: "09:52:12", tag: "ALPACA", msg: "Verifying option symbols: SPXW260603P05405000 / SPXW260603P05395000" },
  { time: "09:52:13", tag: "ALPACA", msg: "Live prices — long leg mid: $4.20 | short: $2.10 | net debit: $2.10" },
  { time: "09:52:14", tag: "ORDER",  msg: "Spread orders sent for signal #1002" },
  { time: "09:52:18", tag: "FILL",   msg: "Long leg filled @ $4.35 | placing bracket..." },
  { time: "09:52:19", tag: "ALPACA", msg: "Bracket placed — stop @ $2.18 | TP1 @ $8.70" },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTodayStr() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}

function fmtExpiry(raw) {
  if (!raw || raw.length !== 8) return raw || getTodayStr();
  return raw.slice(4,6) + "/" + raw.slice(6) + "/" + raw.slice(0,4);
}

function fmtPnl(v) {
  if (v == null) return null;
  return (v >= 0 ? "+" : "") + "$" + Math.abs(v).toFixed(0);
}

// ── API calls ─────────────────────────────────────────────────────────────────
async function apiCall(method, path, body) {
  if (DEMO_MODE) return { status: "demo" };
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(SERVER + path, opts);
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || r.status); }
  return r.json();
}

// ── SSE hook ──────────────────────────────────────────────────────────────────
function useSSE(onEvent) {
  const esRef = useRef(null);
  const cbRef = useRef(onEvent);
  cbRef.current = onEvent;

  const connect = useCallback(() => {
    if (DEMO_MODE) return;
    if (esRef.current) esRef.current.close();
    const es = new EventSource(SERVER + "/events");
    esRef.current = es;
    es.onmessage = e => { try { cbRef.current(JSON.parse(e.data)); } catch(_) {} };
    es.onerror   = () => { es.close(); setTimeout(connect, 3000); };
  }, []);

  useEffect(() => { connect(); return () => esRef.current?.close(); }, [connect]);
  return { reconnect: connect };
}

// ── Sub-components ────────────────────────────────────────────────────────────

function Pip({ on, color, pulse }) {
  return <div style={{
    width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
    background: on ? color : "#222",
    boxShadow: on ? "0 0 6px " + color : "none",
    animation: on && pulse ? "pip 2s infinite" : "none",
  }} />;
}

function Tag({ label, color, dim }) {
  return <span style={{
    background: color + (dim ? "12" : "18"),
    color: dim ? color + "99" : color,
    border: "1px solid " + color + "30",
    borderRadius: 3, padding: "1px 7px",
    fontSize: 10, fontFamily: "var(--mono)",
    letterSpacing: 0.7, fontWeight: 700,
  }}>{label}</span>;
}

function StatusBar({ sseOk, alpacaOk, demo }) {
  if (demo) return (
    <div style={{ display:"flex", alignItems:"center", gap:7,
      background:"#F5A62312", border:"1px solid #F5A62330",
      borderRadius:6, padding:"5px 11px" }}>
      <Pip on color="#F5A623" pulse />
      <span style={{ color:"#F5A623", fontFamily:"var(--mono)", fontSize:10 }}>
        DEMO · run locally or on Railway for live trading
      </span>
    </div>
  );
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8,
      background: alpacaOk ? "#00E5A012" : "#F5A62312",
      border:"1px solid " + (alpacaOk ? "#00E5A030" : "#F5A62330"),
      borderRadius:6, padding:"5px 11px" }}>
      <Pip on={sseOk} color="#BF7FFF" pulse />
      <span style={{ color:"#444", fontFamily:"var(--mono)", fontSize:10 }}>RAILWAY</span>
      <span style={{ color:"#333" }}>·</span>
      <Pip on={alpacaOk} color="#00E5A0" pulse={alpacaOk} />
      <span style={{ color: alpacaOk ? "#00E5A0" : "#F5A623",
        fontFamily:"var(--mono)", fontSize:10 }}>
        {alpacaOk ? "ALPACA PAPER · LIVE" : "ALPACA · CONNECTING..."}
      </span>
    </div>
  );
}

function StatBar({ sessionPnL, dailyLoss, accountSize }) {
  const lossLimit = accountSize * 0.06;
  const pColor    = sessionPnL >= 0 ? "#00E5A0" : "#FF3D5A";
  const items = [
    { k:"SESSION P&L",  v:(sessionPnL>=0?"+":"")+"$"+Math.abs(sessionPnL).toFixed(0), c:pColor },
    { k:"DAILY LOSS",   v:"$"+Math.abs(dailyLoss).toFixed(0), c:dailyLoss>0?"#FF3D5A":"#333" },
    { k:"LOSS LIMIT",   v:"$"+lossLimit.toFixed(0)+" (6%)", c:"#555" },
    { k:"ACCOUNT",      v:"$"+accountSize.toLocaleString(), c:"#ccc" },
    { k:"0DTE EXPIRY",  v:getTodayStr(), c:"#BF7FFF" },
  ];
  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(5,1fr)",
      background:"#0a0a0a", border:"1px solid #1a1a1a",
      borderRadius:8, overflow:"hidden", marginBottom:12 }}>
      {items.map(({k,v,c},i) => (
        <div key={k} style={{ padding:"10px 14px",
          borderRight: i<4 ? "1px solid #1a1a1a" : "none" }}>
          <div style={{ color:"#2a2a2a", fontSize:8, fontFamily:"var(--mono)",
            letterSpacing:1.2, marginBottom:4 }}>{k}</div>
          <div style={{ color:c, fontSize:13, fontFamily:"var(--mono)", fontWeight:700 }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function SpreadChip({ signal }) {
  if (!signal.longStrike) return null;
  return (
    <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap",
      padding:"6px 10px", marginBottom:8,
      background:"#0a0a0a", borderRadius:5, border:"1px solid #1a1a1a" }}>
      <span style={{ color:"#2a2a2a", fontSize:8, fontFamily:"var(--mono)", letterSpacing:1 }}>SPREAD</span>
      <span style={{ color:"#ddd", fontSize:12, fontFamily:"var(--mono)", fontWeight:700 }}>
        {signal.longStrike}/{signal.shortStrike} {signal.right}
      </span>
      <span style={{ color:"#222" }}>·</span>
      <span style={{ color:"#555", fontSize:10, fontFamily:"var(--mono)" }}>{signal.spreadWidth}pt</span>
      <span style={{ color:"#222" }}>·</span>
      <span style={{ color:"#F5A623", fontSize:11, fontFamily:"var(--mono)" }}>
        {signal.fillDebit ? "fill $"+signal.fillDebit : "est $"+signal.estDebit}
      </span>
      {signal.longSymbol && (
        <>
          <span style={{ color:"#222" }}>·</span>
          <span style={{ color:"#BF7FFF", fontSize:9, fontFamily:"var(--mono)" }}>
            {signal.longSymbol}
          </span>
        </>
      )}
    </div>
  );
}

function PriceGrid({ items }) {
  return (
    <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)", gap:4, marginBottom:6 }}>
      {items.map(({k,v,c,dashed}) => (
        <div key={k} style={{ background: dashed?"#0a0a0a55":"#0a0a0a",
          borderRadius:4, padding:"6px 8px",
          border:"1px " + (dashed?"dashed":"solid") + " #1a1a1a" }}>
          <div style={{ color:"#252525", fontSize:8, fontFamily:"var(--mono)",
            letterSpacing:1, marginBottom:3 }}>{k}</div>
          <div style={{ color:c, fontSize:12, fontFamily:"var(--mono)", fontWeight:600 }}>{v||"—"}</div>
        </div>
      ))}
    </div>
  );
}

function SignalCard({ signal, onExecute, onCancel }) {
  const [execBusy,   setExecBusy]   = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [execErr,    setExecErr]    = useState(null);
  const [demoFilled, setDemoFilled] = useState(false);

  const s       = S[signal.status] || { color:"#555", label:signal.status };
  const dir     = DIR[signal.direction] || { color:"#999", bg:"#11111a" };
  const isPend  = signal.status === "PENDING" && !demoFilled;
  const isActive= ["SENT","FILLED","EXECUTING"].includes(signal.status) || demoFilled;
  const isClosed= ["TP1_HIT","STOPPED","CANCELLED"].includes(signal.status);
  const pnl     = signal.closePnl;

  const doExecute = async () => {
    setExecBusy(true); setExecErr(null);
    try {
      await onExecute(signal.id);
      if (DEMO_MODE) setDemoFilled(true);
    } catch(e) { setExecErr(e.message); }
    finally { setExecBusy(false); }
  };

  const doCancel = async () => {
    setCancelBusy(true);
    try { await onCancel(signal.id); } finally { setCancelBusy(false); }
  };

  return (
    <div style={{
      background:"linear-gradient(160deg,#0d0d0d,#111)",
      border:"1px solid " + dir.color + "20",
      borderLeft:"3px solid " + (isClosed ? s.color : dir.color),
      borderRadius:9, padding:14,
      opacity: isClosed ? 0.65 : 1,
      transition:"opacity 0.3s",
    }}>
      {/* Header */}
      <div style={{ display:"flex", justifyContent:"space-between",
        alignItems:"flex-start", marginBottom:9 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap", marginBottom:4 }}>
            <span style={{ fontFamily:"var(--mono)", fontSize:16,
              fontWeight:700, color:"#eee", letterSpacing:2 }}>SPXW</span>
            <Tag label={signal.direction} color={dir.color} />
            <Tag label={signal.confidence} color={signal.confidence==="HIGH"?"#BF7FFF":"#F5A623"} />
            {signal.fillDebit && <Tag label={"fill $"+signal.fillDebit} color="#00E5A0" />}
            {pnl != null && <Tag label={fmtPnl(pnl)} color={pnl>=0?"#00E5A0":"#FF3D5A"} />}
          </div>
          <div style={{ color:"#2d2d2d", fontSize:10, fontFamily:"var(--mono)" }}>
            {signal.trigger} · {signal.time} ET
          </div>
        </div>
        <div style={{
          background: s.color+"15", color:s.color,
          border:"1px solid "+s.color+"30",
          borderRadius:4, padding:"3px 9px", fontSize:9,
          fontFamily:"var(--mono)", letterSpacing:0.8,
          display:"flex", alignItems:"center", gap:5, flexShrink:0,
        }}>
          {(isActive && !demoFilled) && <Pip on color={s.color} pulse />}
          {demoFilled ? "DEMO FILLED" : s.label}
        </div>
      </div>

      <SpreadChip signal={signal} />

      <PriceGrid items={[
        { k:"ENTRY",  v:signal.entry?.toFixed(2),  c:"#ccc" },
        { k:"STOP",   v:signal.stop?.toFixed(2),   c:"#FF3D5A" },
        { k:"TP1",    v:signal.tp1?.toFixed(2),    c:"#00C2FF" },
        { k:"TP2",    v:signal.tp2?.toFixed(2),    c:"#BF7FFF" },
      ]} />

      <PriceGrid items={[
        { k:"PREM ENTRY", v:signal.estDebit    ? "$"+signal.estDebit    : "—", c:"#ccc",     dashed:true },
        { k:"PREM STOP",  v:signal.premiumStop ? "$"+signal.premiumStop : "—", c:"#FF3D5A",  dashed:true },
        { k:"PREM TP1",   v:signal.tp1Price    ? "$"+signal.tp1Price    : "—", c:"#00C2FF",  dashed:true },
        { k:"MAX LOSS",   v:signal.estMaxLoss  ? "$"+signal.estMaxLoss  : "—", c:"#FF3D5A",  dashed:true },
      ]} />

      {/* Metrics */}
      <div style={{ display:"flex", background:"#0a0a0a",
        border:"1px solid #1a1a1a", borderRadius:5,
        overflow:"hidden", marginBottom:10 }}>
        {[
          { k:"R:R",       v:signal.rr||"—",              c:"#F5A623" },
          { k:"CONTRACTS", v:signal.contracts||1,          c:"#00E5A0" },
          { k:"WIDTH",     v:(signal.spreadWidth||10)+"pt",c:"#555"    },
          { k:"EXPIRY",    v:fmtExpiry(signal.expiry),     c:"#BF7FFF" },
        ].map(({k,v,c},i) => (
          <div key={k} style={{ flex:1, padding:"8px 0", textAlign:"center",
            borderRight: i<3?"1px solid #1a1a1a":"none" }}>
            <div style={{ color:"#222", fontSize:8, fontFamily:"var(--mono)",
              letterSpacing:1, marginBottom:3 }}>{k}</div>
            <div style={{ color:c, fontSize:12, fontFamily:"var(--mono)", fontWeight:700 }}>{v}</div>
          </div>
        ))}
      </div>

      {execErr && (
        <div style={{ background:"#FF3D5A0a", border:"1px solid #FF3D5A25",
          borderRadius:4, padding:"6px 10px", marginBottom:8,
          color:"#FF3D5A", fontSize:10, fontFamily:"var(--mono)" }}>
          ✗ {execErr}
        </div>
      )}

      {isPend && (
        <div style={{ display:"flex", gap:6 }}>
          <button onClick={doExecute} disabled={execBusy} style={{
            flex:2, padding:"9px 0",
            background: execBusy ? "#111" : "linear-gradient(135deg,"+dir.color+"cc,"+dir.color+"66)",
            border:"none", borderRadius:5,
            color: execBusy ? "#333" : "#000",
            fontFamily:"var(--mono)", fontWeight:700, fontSize:11,
            cursor: execBusy?"not-allowed":"pointer", letterSpacing:1,
            boxShadow: execBusy?"none":"0 3px 12px "+dir.color+"33",
            transition:"all 0.2s",
          }}>
            {execBusy ? "PLACING ORDERS..." : "▶ EXECUTE " + signal.direction}
          </button>
          <button onClick={doCancel} disabled={cancelBusy} style={{
            flex:1, padding:"9px 0",
            background:"transparent", border:"1px solid #FF3D5A25",
            borderRadius:5, color: cancelBusy?"#333":"#FF3D5A",
            fontFamily:"var(--mono)", fontSize:10,
            cursor: cancelBusy?"not-allowed":"pointer", letterSpacing:1,
          }}>
            {cancelBusy ? "..." : "✕ SKIP"}
          </button>
        </div>
      )}

      {signal.status === "EXECUTING" && (
        <div style={{ padding:"8px", textAlign:"center",
          background:"#00C2FF0a", border:"1px solid #00C2FF20",
          borderRadius:5, color:"#00C2FF",
          fontFamily:"var(--mono)", fontSize:10, letterSpacing:0.8 }}>
          ⟳ Verifying option chain + placing orders on Alpaca...
        </div>
      )}

      {isActive && signal.status !== "EXECUTING" && (
        <div style={{ display:"flex", gap:7, alignItems:"center",
          padding:"8px 11px",
          background:"#00E5A00a", border:"1px solid #00E5A020", borderRadius:5 }}>
          <Pip on color="#00E5A0" pulse />
          <span style={{ color:"#00E5A0", fontFamily:"var(--mono)", fontSize:10, flex:1 }}>
            {DEMO_MODE
              ? "Demo filled · In production: orders live on Alpaca paper account"
              : signal.status==="SENT"
                ? "Orders sent · Awaiting fill confirmation from Alpaca..."
                : "Position live · Bracket orders active · Monitor in Alpaca app"}
          </span>
          {!DEMO_MODE && (
            <button onClick={doCancel} style={{
              background:"#FF3D5A0a", border:"1px solid #FF3D5A25",
              borderRadius:4, color:"#FF3D5A", padding:"2px 8px",
              fontFamily:"var(--mono)", fontSize:9, cursor:"pointer",
            }}>CLOSE</button>
          )}
        </div>
      )}

      {isClosed && (
        <div style={{ padding:"8px 11px",
          background:s.color+"08", border:"1px solid "+s.color+"20",
          borderRadius:5, color:s.color,
          fontFamily:"var(--mono)", fontSize:10, letterSpacing:0.7 }}>
          {signal.status==="TP1_HIT"   && "✓ TARGET HIT · Both legs closed · Check Alpaca app for final P&L"}
          {signal.status==="STOPPED"   && "✗ STOP HIT · Premium stop triggered · Position closed on Alpaca"}
          {signal.status==="CANCELLED" && "— Cancelled · No position taken"}
        </div>
      )}
    </div>
  );
}

function EventLog({ logs }) {
  const ref = useRef();
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [logs]);

  const TC = { ALPACA:"#00E5A0", WEBHOOK:"#F5A623", SIGNAL:"#00C2FF",
    "ALPACA ERR":"#FF3D5A", ORDER:"#00E5A0", FILL:"#BF7FFF",
    RETRY:"#F5A623", ERROR:"#FF3D5A", CANCEL:"#FF3D5A",
    SYNC:"#555", GUARD:"#FF3D5A", WARN:"#F5A623" };

  return (
    <div style={{ background:"#080808", border:"1px solid #181818",
      borderRadius:8, padding:12, height:155 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:6 }}>
        <span style={{ color:"#222", fontSize:9, fontFamily:"var(--mono)", letterSpacing:2 }}>
          {DEMO_MODE?"DEMO LOG":"LIVE LOG · RAILWAY → ALPACA"}
        </span>
        <span style={{ color:"#1a1a1a", fontSize:9, fontFamily:"var(--mono)" }}>
          {logs.length} events
        </span>
      </div>
      <div ref={ref} style={{ overflowY:"auto", height:108 }}>
        {logs.length === 0
          ? <span style={{ color:"#1a1a1a", fontSize:10, fontFamily:"var(--mono)" }}>
              Waiting for connection to {SERVER || "localhost:3001"}...
            </span>
          : [...logs].reverse().map((l,i) => (
              <div key={i} style={{ fontSize:10, fontFamily:"var(--mono)",
                marginBottom:2, display:"flex", gap:7 }}>
                <span style={{ color:"#1e1e1e", flexShrink:0 }}>{l.time}</span>
                <span style={{ color:TC[l.tag]||"#333", flexShrink:0 }}>[{l.tag}]</span>
                <span style={{ color:"#444" }}>{l.msg}</span>
              </div>
            ))
        }
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [signals,    setSignals]    = useState(DEMO_MODE ? DEMO_SIGNALS : []);
  const [logs,       setLogs]       = useState(DEMO_MODE ? DEMO_LOGS    : []);
  const [alpacaOk,   setAlpacaOk]   = useState(false);
  const [sseOk,      setSseOk]      = useState(false);
  const [sessionPnL, setSessionPnL] = useState(0);
  const [dailyLoss,  setDailyLoss]  = useState(0);
  const [clock,      setClock]      = useState("");
  const accountSize = 100000;

  useEffect(() => {
    const t = () => setClock(new Date().toLocaleTimeString("en-US",{hour12:false,timeZone:"America/New_York"})+" ET");
    t(); const id = setInterval(t, 1000); return () => clearInterval(id);
  }, []);

  const handleEvent = useCallback(ev => {
    setSseOk(true);
    switch(ev.type) {
      case "init":
        if (ev.signals) setSignals(ev.signals);
        setSessionPnL(parseFloat(ev.sessionPnL)||0);
        setDailyLoss(parseFloat(ev.dailyLoss)||0);
        break;
      case "alpaca_status": setAlpacaOk(ev.connected); break;
      case "new_signal":    setSignals(p => [ev.signal,...p]); break;
      case "signal_update":
        setSignals(p => p.map(s => s.id===ev.id ? {...s,...ev} : s));
        if (ev.pnl!=null) {
          setSessionPnL(p => p + ev.pnl);
          if (ev.pnl<0) setDailyLoss(p => p + Math.abs(ev.pnl));
        }
        break;
      case "log":
        setLogs(p => [...p.slice(-299), ev]);
        break;
    }
  }, []);

  useSSE(handleEvent);

  const handleExecute = async (id) => { await apiCall("POST", "/execute/"+id); };
  const handleCancel  = async (id) => {
    await apiCall("POST", "/cancel/"+id);
    if (DEMO_MODE) setSignals(p => p.map(s => s.id===id ? {...s,status:"CANCELLED"} : s));
  };

  const pending = signals.filter(s=>s.status==="PENDING").length;
  const active  = signals.filter(s=>["SENT","FILLED","EXECUTING"].includes(s.status)).length;
  const closed  = signals.filter(s=>["TP1_HIT","STOPPED","CANCELLED"].includes(s.status)).length;

  return (
    <div style={{ minHeight:"100vh", background:"#060606",
      "--mono":"'JetBrains Mono', 'Fira Code', monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Bebas+Neue&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        @keyframes pip{0%,100%{opacity:1}50%{opacity:0.2}}
        @keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
        ::-webkit-scrollbar{width:2px}
        ::-webkit-scrollbar-thumb{background:#1a1a1a;border-radius:1px}
        button:hover{filter:brightness(1.15)}
      `}</style>

      {/* Top bar */}
      <div style={{ background:"#080808", borderBottom:"1px solid #141414",
        padding:"9px 18px", position:"sticky", top:0, zIndex:100,
        display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          <span style={{ fontFamily:"'Bebas Neue', sans-serif",
            fontSize:20, letterSpacing:3, color:"#eee" }}>
            <span style={{ color:"#00E5A0" }}>SPX</span> COMMAND
          </span>
          <span style={{ color:"#1e1e1e", fontSize:9,
            fontFamily:"var(--mono)", letterSpacing:1.5 }}>
            SPXW · 0DTE · ALPACA
          </span>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:7 }}>
          <div style={{ display:"flex", gap:5 }}>
            {pending>0 && <Tag label={pending+" PENDING"} color="#F5A623" />}
            {active >0 && <Tag label={active +" ACTIVE"}  color="#00E5A0" />}
            {closed >0 && <Tag label={closed +" CLOSED"}  color="#333"   />}
          </div>
          <StatusBar sseOk={sseOk} alpacaOk={alpacaOk} demo={DEMO_MODE} />
          <span style={{ color:"#252525", fontSize:11, fontFamily:"var(--mono)" }}>{clock}</span>
        </div>
      </div>

      <div style={{ padding:"14px 18px", maxWidth:960, margin:"0 auto" }}>

        {/* Demo banner */}
        {DEMO_MODE && (
          <div style={{ background:"#F5A62308", border:"1px solid #F5A62320",
            borderRadius:6, padding:"9px 13px", marginBottom:11,
            display:"flex", gap:10, alignItems:"flex-start" }}>
            <span style={{ color:"#F5A623", fontSize:10,
              fontFamily:"var(--mono)", fontWeight:700, flexShrink:0 }}>DEMO</span>
            <span style={{ color:"#333", fontSize:10, fontFamily:"var(--mono)" }}>
              Showing sample data. To go live: deploy{" "}
              <span style={{ color:"#F5A623" }}>server.js</span> to Railway,
              add your Alpaca API keys, then open this dashboard at{" "}
              <span style={{ color:"#F5A623" }}>your-app.up.railway.app</span>
              {" "}pointing{" "}
              <span style={{ color:"#F5A623" }}>SERVER</span> to your Railway URL.
            </span>
          </div>
        )}

        <StatBar sessionPnL={sessionPnL} dailyLoss={dailyLoss} accountSize={accountSize} />

        {/* Signals */}
        <div style={{ marginBottom:12 }}>
          <div style={{ display:"flex", justifyContent:"space-between",
            alignItems:"center", marginBottom:8 }}>
            <span style={{ color:"#1e1e1e", fontSize:9,
              fontFamily:"var(--mono)", letterSpacing:2 }}>LIVE SIGNALS</span>
            {signals.length>0 && <span style={{ color:"#1a1a1a", fontSize:9,
              fontFamily:"var(--mono)" }}>{signals.length} total</span>}
          </div>
          {signals.length===0 ? (
            <div style={{ textAlign:"center", padding:"40px 20px",
              color:"#1a1a1a", fontSize:11, fontFamily:"var(--mono)",
              border:"1px dashed #141414", borderRadius:8 }}>
              Waiting for TradingView webhook alerts...
            </div>
          ) : (
            <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
              {signals.map(s => (
                <div key={s.id} style={{ animation:"in 0.2s ease" }}>
                  <SignalCard signal={s} onExecute={handleExecute} onCancel={handleCancel} />
                </div>
              ))}
            </div>
          )}
        </div>

        <EventLog logs={logs} />

        {/* Config strip */}
        <div style={{ marginTop:10, padding:"9px 13px",
          background:"#080808", border:"1px solid #141414", borderRadius:6,
          display:"flex", gap:18, flexWrap:"wrap" }}>
          {[
            ["MODE",       DEMO_MODE?"DEMO":"LIVE"],
            ["BROKER",     "Alpaca (" + (DEMO_MODE?"paper":"paper") + ")"],
            ["INSTRUMENT", "SPXW 0DTE vertical spread"],
            ["RISK/TRADE", "2% · $2,000"],
            ["STOP",       "50% of debit"],
            ["HOSTING",    DEMO_MODE?"localhost":"Railway"],
          ].map(([k,v]) => (
            <div key={k}>
              <span style={{ color:"#1a1a1a", fontSize:8,
                fontFamily:"var(--mono)", letterSpacing:1 }}>{k} </span>
              <span style={{ color:"#2a2a2a", fontSize:9,
                fontFamily:"var(--mono)" }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
