#!/usr/bin/env node
/**
 * Schwab READ-ONLY capability probe (local, loopback-callback friendly).
 *
 * THE QUESTION: does Schwab actually return populated greeks + openInterest for 0DTE
 * SPY contracts? Alpaca's failure mode was greeks appearing for later expiries but NOT
 * same-day. We verify with a real API response BEFORE building anything — a prior
 * unverified "this will give us greeks" recommendation cost $99 for nothing.
 *
 * HARD RULE: /marketdata/* endpoints ONLY. There is no /trader/ code path here.
 * This script cannot place a trade.
 *
 * SETUP (do not paste secrets into chat — export them in your own terminal):
 *   export SCHWAB_APP_KEY="your_app_key"
 *   export SCHWAB_APP_SECRET="your_app_secret"
 *   node scripts/schwab-probe.js
 *
 * Tokens are written to scripts/.schwab_tokens.json (gitignored) so re-runs skip the login.
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const APP_KEY    = process.env.SCHWAB_APP_KEY || "";
const APP_SECRET = process.env.SCHWAB_APP_SECRET || "";
const REDIRECT   = process.env.SCHWAB_REDIRECT_URI || "https://127.0.0.1:8182";
const BASE       = "https://api.schwabapi.com";
const TOKENS     = path.join(__dirname, ".schwab_tokens.json");

const basic = () => Buffer.from(APP_KEY + ":" + APP_SECRET).toString("base64");
const ask = q => new Promise(r => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(q, a => { rl.close(); r(a.trim()); });
});
const loadTokens = () => { try { return JSON.parse(fs.readFileSync(TOKENS, "utf8")); } catch { return null; } };
const saveTokens = t => fs.writeFileSync(TOKENS, JSON.stringify({ ...t, saved_at: Date.now() }, null, 2));

/**
 * Pull the auth code out of whatever the user pasted. Accepts a full redirect URL, a
 * URL with params in the fragment, or a bare code string. On failure it prints exactly
 * what WAS found, so we can diagnose instead of guess.
 */
function extractCode(pasted) {
  let s = (pasted || "").trim().replace(/^['"]|['"]$/g, "");
  if (!s) throw new Error("Nothing pasted.");

  // Bare code (no scheme) — Schwab codes are long and contain no spaces
  if (!/^https?:\/\//i.test(s)) {
    if (s.length > 20 && !/\s/.test(s)) { console.log("(accepted as a bare code)"); return s; }
    throw new Error(
      "That is neither a URL nor a code.\n" +
      "  You pasted: " + s.slice(0, 120) + "\n" +
      "  Expected something like: https://127.0.0.1:8182/?code=XXXX&session=YYYY");
  }

  let u;
  try { u = new URL(s); }
  catch (e) { throw new Error("URL parse failed: " + e.message + "\n  You pasted: " + s.slice(0, 160)); }

  const q = Object.fromEntries(u.searchParams.entries());
  const frag = u.hash.startsWith("#")
    ? Object.fromEntries(new URLSearchParams(u.hash.slice(1)).entries()) : {};
  const code = q.code || frag.code;
  if (code) return code;

  // No code — report precisely what came back
  const lines = ["No ?code= in that URL.", "  host : " + u.host, "  path : " + u.pathname];
  lines.push("  query params : " + (Object.keys(q).length ? JSON.stringify(q) : "(none)"));
  if (Object.keys(frag).length) lines.push("  fragment params : " + JSON.stringify(frag));
  if (q.error || frag.error) {
    lines.push("", "  >>> Schwab returned an ERROR: " + (q.error || frag.error));
    if (q.error_description || frag.error_description)
      lines.push("      " + (q.error_description || frag.error_description));
  }
  lines.push("", "Most likely causes:");
  if (u.host.includes("schwab") || u.pathname.includes("authorize"))
    lines.push("  * You pasted the LOGIN url, not the redirect. Complete the login first,");
    lines.push("    then copy the URL the browser lands on (it starts with " + REDIRECT + ").");
  lines.push("  * The login/consent didn't finish — you must click through to the account approval.");
  lines.push("  * App is not in 'Ready For Use' status in the Schwab developer portal.");
  lines.push("  * Callback URL in the portal doesn't exactly match: " + REDIRECT);
  throw new Error(lines.join("\n"));
}

async function postToken(params) {
  const r = await fetch(BASE + "/v1/oauth/token", {
    method: "POST",
    headers: { Authorization: "Basic " + basic(), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`token ${r.status}: ${txt.slice(0, 400)}`);
  return JSON.parse(txt);
}

async function getAccessToken() {
  const t = loadTokens();
  // Reuse a still-valid access token
  if (t?.access_token && (Date.now() - t.saved_at) / 1000 < (t.expires_in || 1800) - 120) {
    return t.access_token;
  }
  // Try refresh (refresh tokens last ~7 days)
  if (t?.refresh_token) {
    try {
      const nt = await postToken({ grant_type: "refresh_token", refresh_token: t.refresh_token });
      saveTokens({ ...t, ...nt });
      console.log("(refreshed access token)\n");
      return nt.access_token;
    } catch (e) { console.log("Refresh failed (" + e.message + ") — doing full login.\n"); }
  }
  // Full 3-legged OAuth via loopback callback
  const authUrl = BASE + "/v1/oauth/authorize?client_id=" + encodeURIComponent(APP_KEY) +
                  "&redirect_uri=" + encodeURIComponent(REDIRECT);
  console.log("\n1. Open this URL in your browser and log in to Schwab:\n\n   " + authUrl + "\n");
  console.log("2. Approve the account link. Your browser will then try to load\n   " + REDIRECT +
              "/?code=...  and show a CONNECTION ERROR. That is expected and fine —\n   nothing is listening on that port.\n");
  console.log("3. Copy the ENTIRE URL from the browser address bar and paste it below.\n   Do this promptly — the code expires in ~30 seconds.\n");
  const pasted = await ask("Paste the full redirect URL (or just the code) here: ");
  const code = extractCode(pasted);
  const t2 = await postToken({ grant_type: "authorization_code", code, redirect_uri: REDIRECT });
  saveTokens(t2);
  console.log("\nTokens saved to scripts/.schwab_tokens.json (refresh token valid ~7 days).\n");
  return t2.access_token;
}

// Schwab uses -999.0 as a sentinel meaning "greek not available"
const isNum = v => typeof v === "number" && isFinite(v) && v !== -999;

async function probe(token, date) {
  const url = BASE + "/marketdata/v1/chains?symbol=SPY&contractType=ALL&strikeCount=6" +
              "&includeUnderlyingQuote=true&fromDate=" + date + "&toDate=" + date;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const txt = await r.text();
  if (!r.ok) { console.log(`\n=== ${date} === FETCH FAILED ${r.status}\n${txt.slice(0, 500)}\n`); return null; }
  const j = JSON.parse(txt);

  const contracts = [];
  for (const mapName of ["callExpDateMap", "putExpDateMap"]) {
    const m = j[mapName] || {};
    for (const exp of Object.keys(m))
      for (const strike of Object.keys(m[exp]))
        for (const c of m[exp][strike]) contracts.push({ exp, strike: parseFloat(strike), ...c });
  }
  const withGreeks = contracts.filter(c => isNum(c.delta) && isNum(c.gamma));
  const withOI     = contracts.filter(c => typeof c.openInterest === "number" && c.openInterest > 0);
  const ok = withGreeks.length > 0 && withOI.length > 0;

  console.log(`\n=== EXPIRY ${date} ===`);
  console.log(`contracts returned : ${contracts.length}`);
  console.log(`underlying last    : ${j.underlying?.last ?? "—"}`);
  console.log(`GREEKS             : ${withGreeks.length ? "PRESENT" : "MISSING"}  (${withGreeks.length}/${contracts.length})`);
  console.log(`OPEN INTEREST      : ${withOI.length ? "PRESENT" : "MISSING"}  (${withOI.length}/${contracts.length})`);
  if (contracts.length) {
    console.log("\nsample contracts:");
    console.log("  " + "symbol".padEnd(22) + "bid".padStart(7) + "ask".padStart(7) +
                "delta".padStart(9) + "gamma".padStart(9) + "iv".padStart(8) + "OI".padStart(9));
    for (const c of contracts.slice(0, 6)) {
      console.log("  " + String(c.symbol).padEnd(22) +
        String(c.bid ?? "—").padStart(7) + String(c.ask ?? "—").padStart(7) +
        String(c.delta ?? "—").padStart(9) + String(c.gamma ?? "—").padStart(9) +
        String(c.volatility ?? "—").padStart(8) + String(c.openInterest ?? "—").padStart(9));
    }
  }
  return { date, ok, greeks: withGreeks.length, oi: withOI.length, n: contracts.length };
}

// Next Friday — a later weekly expiry, for the critical 0DTE-vs-weekly comparison
function nextFriday() {
  const d = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  d.setDate(d.getDate() + ((5 - d.getDay() + 7) % 7 || 7));
  return d.toLocaleDateString("en-CA");
}

(async () => {
  if (!APP_KEY || !APP_SECRET) {
    console.error("Missing credentials. In your terminal:\n" +
      '  export SCHWAB_APP_KEY="..."\n  export SCHWAB_APP_SECRET="..."\n' +
      "  node scripts/schwab-probe.js\n\nRedirect URI in use: " + REDIRECT +
      "\n(override with SCHWAB_REDIRECT_URI if your portal Callback URL differs)");
    process.exit(1);
  }
  const token = await getAccessToken();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const args = process.argv.slice(2).filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const dates = args.length ? args : [today, nextFriday()];

  const results = [];
  for (const d of dates) results.push(await probe(token, d));

  console.log("\n" + "=".repeat(66));
  console.log("VERDICT");
  console.log("=".repeat(66));
  for (const r of results.filter(Boolean)) {
    console.log(`  ${r.date}  greeks ${r.greeks}/${r.n}, OI ${r.oi}/${r.n}  →  ${r.ok ? "OK" : "MISSING"}`);
  }
  const zero = results.find(r => r && r.date === today);
  const later = results.find(r => r && r.date !== today);
  console.log("");
  if (zero?.ok) {
    console.log("  GO — Schwab returns greeks + OI for 0DTE. The integration is worth building.");
  } else if (zero && later?.ok && !zero.ok) {
    console.log("  NO-GO — greeks present on the later expiry but MISSING on 0DTE.");
    console.log("  This is EXACTLY the Alpaca trap repeating. Do not build the integration.");
    console.log("  Pivot to local Black-Scholes (compute greeks from bid/ask mid + underlying).");
  } else {
    console.log("  NO-GO / INCONCLUSIVE — see the per-expiry detail above.");
    console.log("  (Markets closed? Try again during RTH — 0DTE chains may be empty overnight.)");
  }
  console.log("");
})().catch(e => { console.error("\nprobe failed: " + e.message + "\n"); process.exit(1); });
