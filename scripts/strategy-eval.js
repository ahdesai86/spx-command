#!/usr/bin/env node
/**
 * Strategy evaluation — the measurement discipline the external review asked for (its #7/#8).
 * Answers three questions the bot currently can't:
 *
 *   1. EXPECTANCY by regime — win rate, avg win/loss, expectancy/trade, profit factor, tail loss.
 *   2. EXECUTION DRAG — how much the polling-exit + spread costs, by re-pricing every trade
 *      under 0 / realistic / stress slippage assumptions.
 *   3. FILTER MARGINAL VALUE — for each blocking guard, did what it blocked actually deserve
 *      to be blocked? (would-win% of blocked candidates vs the baseline fired win rate),
 *      segmented by regime — so we can RETIRE filters that block winners.
 *
 * HONEST LIMITS: we have no historical option tick data, so (2) is a haircut model on realized
 * trades and (3) uses a forward SPY-move proxy for blocked signals (same engine as
 * blocked-analysis). This is a relative screen to guide filter pruning — not a tick backtest.
 *
 * Usage: node scripts/strategy-eval.js [--url ...] [--user U --pass P | --read-only-token T] [--days 60]
 *        [--slip-real 0.06] [--slip-stress 0.12] [--win 1.2 --stop 0.5 --window 45]
 */
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,arr)=>{if(v.startsWith("--"))a.push([v.slice(2),arr[i+1]]);return a;},[]));
const URL=args.url??"https://spx-command-production.up.railway.app";
const USER=args.user??process.env.DASH_USER??"aayush_desai";
const PASS=args.pass??process.env.DASH_PASS??"";
const READONLY_TOKEN=args["read-only-token"]??process.env.READONLY_TOKEN??"";
const STRATEGY_ID=args["strategy-id"]??process.env.STRATEGY_ID??"orb-2dte-immediate-v1";
const DAYS=parseInt(args.days??"60");
const SLIP_REAL=parseFloat(args["slip-real"]??"0.06");   // 6% avg premium haircut per exit (measured ~4-8%)
const SLIP_STRESS=parseFloat(args["slip-stress"]??"0.12");// 12% stress
const WIN=parseFloat(args.win??"1.2"), STOP=parseFloat(args.stop??"0.5"), WINDOW=parseInt(args.window??"45");

async function get(path){
  const h={}; if(PASS) h.Authorization="Basic "+Buffer.from(USER+":"+PASS).toString("base64");
  else if(READONLY_TOKEN) h["X-Read-Only-Token"]=READONLY_TOKEN;
  const r=await fetch(URL+path,{headers:h});
  if(!r.ok) throw new Error(path+" HTTP "+r.status+" (need --user/--pass for /db/*)");
  return r.json();
}
const pct=(a,b)=>b?Math.round(a/b*100):0;
const sum=a=>a.reduce((x,y)=>x+y,0);
const avg=a=>a.length?sum(a)/a.length:0;

(async()=>{
  const allTrades=(await get("/db/trades?limit=1000")).trades||[];
  const allSigs=(await get("/db/signals?limit=5000")).signals||[];
  // Cohort isolation is intentional: legacy records have no strategy_id and must
  // never be blended into the new 2DTE/immediate-strike measurement.
  const trades=allTrades.filter(t=>t.strategy_id===STRATEGY_ID&&t.pnl!=null);
  const sigs=allSigs.filter(s=>s.strategy_id===STRATEGY_ID);
  if(!trades.length&&!sigs.length) throw new Error("No journal rows for strategy_id="+STRATEGY_ID+" yet — wait for new signals/trades after deployment");
  const days=[...new Set([...trades,...sigs].map(r=>r.date).filter(Boolean))].sort().slice(-DAYS);
  const T=trades.filter(t=>days.includes(t.date));

  // ── 1. Expectancy by regime ────────────────────────────────────────────────
  console.log("\n════ COHORT: "+STRATEGY_ID+" ════");
  console.log("\n════ 1. EXPECTANCY  ("+(days[0]||"no closed trades")+" … "+(days[days.length-1]||"yet")+", "+T.length+" trades) ════");
  const byRegime={ALL:T};
  for(const t of T){ const k=t.mode_at_fill||t.market_mode||"?"; (byRegime[k]||=[]).push(t); }
  console.log("regime      n    win%   avgW    avgL    expectancy/trade   profitFactor   worst");
  for(const [k,rows] of Object.entries(byRegime)){
    const w=rows.filter(t=>t.pnl>0),l=rows.filter(t=>t.pnl<0);
    const exp=avg(rows.map(t=>t.pnl)), pf=Math.abs(sum(w.map(t=>t.pnl))/(sum(l.map(t=>t.pnl))||-1));
    const worst=Math.min(0,...rows.map(t=>t.pnl));
    console.log(k.padEnd(10)+String(rows.length).padStart(4)+"   "+String(pct(w.length,rows.length)).padStart(3)+
      "%  $"+avg(w.map(t=>t.pnl)).toFixed(0).padStart(5)+"  $"+avg(l.map(t=>t.pnl)).toFixed(0).padStart(6)+
      "     $"+exp.toFixed(0).padStart(6)+"/trade      "+pf.toFixed(2).padStart(5)+"       $"+worst.toFixed(0));
  }

  // ── 2. Execution drag (slippage/spread haircut on each exit) ────────────────
  console.log("\n════ 2. EXECUTION-DRAG SENSITIVITY (slippage on the exit fill) ════");
  // Actual quote-to-fill drag is available for the new cohort. Keep the prior
  // sensitivity as a stress overlay, not as a substitute for observed execution.
  const entryObs=T.filter(t=>t.entry_execution?.quote&&t.entry_execution.fill_vs_mid!=null);
  const exitObs=T.filter(t=>t.exit_execution?.quote&&t.exit_execution.fill_vs_mid!=null);
  const entryDrag=sum(entryObs.map(t=>Math.abs(t.entry_execution.fill_vs_mid||0)*100*(t.contracts||0)));
  const exitDrag=sum(exitObs.map(t=>Math.abs(t.exit_execution.fill_vs_mid||0)*100*(t.contracts||0)));
  console.log("  observed entry midpoint drag: $"+entryDrag.toFixed(0)+" across "+entryObs.length+" fills");
  console.log("  observed exit midpoint drag:  $"+exitDrag.toFixed(0)+" across "+exitObs.length+" exits");
  const entryLatency=entryObs.map(t=>t.entry_execution.fill_latency_ms).filter(Number.isFinite);
  if(entryLatency.length) console.log("  entry fill latency avg: "+Math.round(avg(entryLatency))+" ms across "+entryLatency.length+" fills");
  // Per 1% of exit slippage: cost = 1% × exit premium × contracts × 100, summed.
  const per1pct=sum(T.map(t=>0.01*(t.close_price||t.fill_price||0)*100*(t.contracts||1)));
  const base=sum(T.map(t=>t.pnl||0));
  console.log("  as-recorded net over "+T.length+" trades: $"+base.toFixed(0));
  console.log("  each +1% of exit slippage costs ≈ $"+per1pct.toFixed(0)+" across the sample");
  console.log("  → realistic "+(SLIP_REAL*100)+"% ≈ −$"+(per1pct*SLIP_REAL*100).toFixed(0)+" | stress "+(SLIP_STRESS*100)+"% ≈ −$"+(per1pct*SLIP_STRESS*100).toFixed(0));
  console.log("  (rough upper bound: shows polling-exit slippage is material at current sizing)");

  // ── 3. Filter marginal value ────────────────────────────────────────────────
  // baseline: fired-signal win rate via forward SPY path (comparable to blocked scoring)
  const bySymDay={}; for(const s of sigs){ if(s.spy_price!=null) (bySymDay[s.date]||=[]).push(s); }
  for(const d in bySymDay) bySymDay[d].sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp));
  const path=d=>bySymDay[d]||[];
  function fwd(dir,px,day,ts){ const p=path(day); const i=p.findIndex(x=>x.timestamp===ts); if(i<0)return null;
    const end=new Date(ts).getTime()+WINDOW*60000; let mfe=0,mae=0;
    for(let j=i+1;j<p.length;j++){ if(new Date(p[j].ts||p[j].timestamp).getTime()>end)break;
      const mv=p[j].px-px||p[j].spy_price-px, fav=dir==="LONG"?mv:-mv; if(fav>mfe)mfe=fav; if(-fav>mae)mae=-fav;
      if(fav>=WIN)return"win"; if(-fav>=STOP)return"loss"; } return "neutral"; }
  function cat(r=""){ r=r.toLowerCase();
    if(/no orb|no rsi|no vwap/.test(r))return null;
    if(/pinned to gamma flip/.test(r))return "VWAP-flip pin";
    if(/within \$0.50 of gamma flip/.test(r))return "gamma-flip prox";
    if(/magnet .* above|magnet .* below/.test(r))return "magnet-direction";
    if(/already at 0dte magnet/.test(r))return "magnet-proximity";
    if(/reversal risk/.test(r))return "reversal (path/wall)";
    if(/lockout/.test(r))return "daily dir lockout";
    if(/cooldown/.test(r))return "direction cooldown";
    if(/chex/.test(r))return "CHEX EOD";
    if(/pin risk/.test(r))return "pin-risk";
    if(/wall|target/.test(r))return "wall/no-target";
    if(/dex bullish|conflicts with/.test(r))return "DEX (retired)";
    if(/rsi/.test(r))return "RSI reject";
    return "other"; }

  const fired=sigs.filter(s=>s.fired&&days.includes(s.date)&&(s.direction==="LONG"||s.direction==="SHORT"));
  let fw=0,fl=0; for(const s of fired){ const o=fwd(s.direction,s.spy_price,s.date,s.timestamp); if(o==="win")fw++;else if(o==="loss")fl++; }
  const baseWin=pct(fw,fw+fl);
  console.log("\n════ 3. FILTER MARGINAL VALUE  (baseline fired would-win = "+baseWin+"%) ════");
  console.log("  a filter EARNS its keep if what it blocked would-win < "+baseWin+"% (it blocked losers).");
  console.log("  guard                  nBlocked  wouldWIN%   verdict");
  const cats={};
  for(const s of sigs){ if(s.fired||!days.includes(s.date))continue; if(s.direction!=="LONG"&&s.direction!=="SHORT")continue;
    const c=s.decision_code||cat(s.blocked_reason); if(!c)continue; const o=fwd(s.direction,s.spy_price,s.date,s.timestamp);
    const b=(cats[c]||={n:0,win:0,loss:0,neu:0}); b.n++; b[o==="win"?"win":o==="loss"?"loss":"neu"]++; }
  for(const [c,b] of Object.entries(cats).sort((a,b)=>b[1].n-a[1].n)){
    const ww=pct(b.win,b.win+b.loss);
    const verdict = b.win+b.loss<8 ? "insufficient n" : ww<baseWin-5 ? "EARNS KEEP (blocks losers)" : ww>baseWin+5 ? "TOO CONSERVATIVE (blocks winners)" : "neutral / marginal";
    console.log("  "+c.padEnd(22)+String(b.n).padStart(5)+"      "+String(ww).padStart(3)+"%      "+verdict);
  }
  console.log("\n  Proxy caveat: SPY-move stand-in for option P&L, 5-min sampled. Relative screen, not a backtest.");
  console.log("  Overfitting watch: any guard with n<8 is unproven; retire/keep only on 50+ samples per regime.\n");
})().catch(e=>{console.error("strategy-eval failed:",e.message);process.exit(1);});
