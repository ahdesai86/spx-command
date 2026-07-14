#!/usr/bin/env node
/**
 * Blocked-signal outcome report.
 *
 * Question it answers: are our entry guards blocking trades that WOULD have won?
 * For every blocked directional signal, it replays the same-day SPY path forward and
 * asks whether price moved far enough in the signal's direction (a "would-win") before
 * moving against it by a stop-equivalent — grouped by WHICH guard did the blocking.
 *
 *   High would-win% on a guard  → that guard is too conservative (blocking winners)
 *   Low would-win%              → that guard is correctly filtering losers
 *
 * PROXY / LIMITATIONS: we don't have historical option premiums, so "win" is proxied by
 * a SPY move (default: +$1.20 in-direction before -$0.50 against ≈ a ~+50% option vs a
 * 25% stop). Prices are sampled at the 5-min scan cadence, so intrabar spikes aren't seen.
 * This is a RELATIVE screen across guards, not a P&L backtest. Tune thresholds via CLI.
 *
 * Usage:
 *   node scripts/blocked-analysis.js [--win 1.2] [--stop 0.5] [--window 45]
 *        [--url https://spx-command-production.up.railway.app] [--days 14]
 */

const args = Object.fromEntries(process.argv.slice(2).reduce((a,v,i,arr)=>{
  if(v.startsWith("--")) a.push([v.slice(2), arr[i+1]]); return a;
},[]));
const WIN_$   = parseFloat(args.win    ?? "1.2");
const STOP_$  = parseFloat(args.stop   ?? "0.5");
const WINDOW  = parseInt  (args.window ?? "45");   // minutes to look forward
const URL     = args.url  ?? "https://spx-command-production.up.railway.app";
const DAYS    = parseInt  (args.days   ?? "14");

// Classify a block reason into a guard category. Order matters (first match wins).
function categorize(reason=""){
  const r = reason.toLowerCase();
  if(/no orb breakout|no rsi|no vwap/.test(r))        return null;            // not a signal — skip
  if(/pinned to gamma flip/.test(r))                  return "VWAP-on-flip pin";
  if(/within \$0\.50 of gamma flip|regime indetermin/.test(r)) return "Gamma-flip proximity";
  if(/pin risk/.test(r))                              return "Pin-risk score";
  if(/magnet/.test(r))                                return "0DTE magnet proximity";
  if(/dex bullish|dex bearish|conflicts with/.test(r)) return "DEX direction (RETIRED)"; // removed guard — historical only
  if(/wall|upside target|downside target/.test(r))    return "Wall target / no room";
  if(/no gex cache|fail-closed/.test(r))              return "Fail-closed (no GEX)";
  if(/weekend|holiday/.test(r))                       return "Weekend/holiday block";
  if(/chex/.test(r))                                  return "CHEX EOD filter";
  if(/cooldown/.test(r))                              return "Direction cooldown";
  if(/max .*trades|trades\/day/.test(r))              return "Max trades/day";
  if(/daily loss/.test(r))                            return "Daily loss limit";
  if(/rsi .*\[mode:/.test(r)){
    const m = r.match(/\[mode:(\w+)/);
    return "RSI reject ("+(m?m[1].toUpperCase():"?")+")";
  }
  if(/rsi/.test(r))                                   return "RSI reject";
  return "Other";
}

// Evaluate a blocked signal against the forward same-day price path (first-touch race).
function outcome(dir, entryPx, path, idx){
  const endT = new Date(path[idx].ts).getTime() + WINDOW*60000;
  let mfe=0, mae=0;                       // max favorable / adverse excursion ($)
  for(let j=idx+1; j<path.length; j++){
    if(new Date(path[j].ts).getTime() > endT) break;
    const move = path[j].px - entryPx;                 // + = up
    const fav  = dir==="LONG" ?  move : -move;         // favorable in signal direction
    const adv  = -fav;
    if(fav>mfe) mfe=fav;
    if(adv>mae) mae=adv;
    if(fav >= WIN_$)  return { verdict:"WIN",  mfe, mae };   // hit target first
    if(adv >= STOP_$) return { verdict:"LOSS", mfe, mae };   // stopped first
  }
  return { verdict:"NEUTRAL", mfe, mae };
}

(async ()=>{
  const res = await fetch(URL+"/db/signals?limit=5000");
  const all = (await res.json()).signals || [];
  // group by day, build sorted price path
  const byDay = {};
  for(const s of all){ (byDay[s.date] ||= []).push(s); }
  const days = Object.keys(byDay).sort().slice(-DAYS);

  const cats = {}; // cat -> {win,loss,neutral,mfe[],mae[]}
  let analyzed=0;
  for(const day of days){
    const rows = byDay[day].filter(r=>r.spy_price!=null)
                           .sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
    const path = rows.map(r=>({ts:r.timestamp, px:r.spy_price}));
    rows.forEach((r,i)=>{
      if(r.fired) return;
      if(r.direction!=="LONG" && r.direction!=="SHORT") return;
      const cat = categorize(r.blocked_reason);
      if(!cat) return;
      const o = outcome(r.direction, r.spy_price, path, i);
      const c = (cats[cat] ||= {win:0,loss:0,neutral:0,mfe:[],mae:[]});
      c[o.verdict.toLowerCase()]++; c.mfe.push(o.mfe); c.mae.push(o.mae);
      analyzed++;
    });
  }

  const avg=a=>a.length?(a.reduce((x,y)=>x+y,0)/a.length):0;
  console.log("\nBLOCKED-SIGNAL OUTCOME REPORT");
  console.log(`days: ${days[0]}..${days[days.length-1]}  |  win=+$${WIN_$} before stop=-$${STOP_$}  |  window=${WINDOW}m  |  ${analyzed} blocked directional signals\n`);
  const head = ["Guard / block reason","n","would-WIN","would-LOSS","neutral","avgMFE","avgMAE"];
  const rows = Object.entries(cats).sort((a,b)=>(b[1].win+b[1].loss+b[1].neutral)-(a[1].win+a[1].loss+a[1].neutral))
    .map(([cat,c])=>{
      const n=c.win+c.loss+c.neutral;
      return [cat, String(n),
        c.win +` (${Math.round(c.win/n*100)}%)`,
        c.loss+` (${Math.round(c.loss/n*100)}%)`,
        c.neutral+` (${Math.round(c.neutral/n*100)}%)`,
        "$"+avg(c.mfe).toFixed(2), "$"+avg(c.mae).toFixed(2)];
    });
  const W = head.map((h,i)=>Math.max(h.length, ...rows.map(r=>r[i].length)));
  const fmt = r=>r.map((c,i)=>c.padEnd(W[i])).join("  ");
  console.log(fmt(head)); console.log(W.map(w=>"-".repeat(w)).join("  "));
  rows.forEach(r=>console.log(fmt(r)));
  console.log("\nRead: high would-WIN% = guard blocked winners (too conservative). high would-LOSS% = guard correctly filtered losers.");
  console.log("Proxy caveat: SPY-move approximation of option P&L, sampled at 5-min cadence — a relative screen, not a backtest.\n");
})().catch(e=>{ console.error("blocked-analysis failed:", e.message); process.exit(1); });
