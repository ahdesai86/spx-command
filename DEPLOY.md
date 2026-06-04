# SPX COMMAND — Deploy to Railway in 15 Minutes

## What You Need Before Starting
- [ ] Alpaca account + paper trading API keys (app.alpaca.markets)
- [ ] GitHub account (free)
- [ ] Railway account (railway.app — free to sign up)
- [ ] TradingView account (for webhooks)

---

## Step 1 — Push to GitHub (3 min)

1. Go to github.com → New repository → name it `spx-command` → Create
2. Upload these files to the repo:
   - `server.js`
   - `package.json`
   - `railway.json`
   (Drag and drop them on the GitHub repo page)

---

## Step 2 — Deploy to Railway (5 min)

1. Go to **railway.app** → Login with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `spx-command` repo
4. Railway auto-detects Node.js and starts deploying
5. Wait ~60 seconds for the build to finish
6. Click your service → **Settings → Generate Domain**
   - You get a URL like: `https://spx-command-production.up.railway.app`
   - This is your permanent webhook URL — save it

---

## Step 3 — Add Environment Variables (2 min)

In Railway: click your service → **Variables** tab → Add each one:

```
ALPACA_KEY        =  your_key_id_here
ALPACA_SECRET     =  your_secret_here
ALPACA_BASE_URL   =  https://paper-api.alpaca.markets
ACCOUNT_SIZE      =  100000
RISK_PER_TRADE    =  0.02
MAX_DAILY_LOSS    =  0.06
SPREAD_WIDTH_PTS  =  10
PREMIUM_STOP_PCT  =  0.50
PORT              =  3001
```

After adding variables Railway auto-redeploys. Wait 30s.

---

## Step 4 — Verify It's Working (1 min)

Open your Railway URL in browser:
```
https://spx-command-production.up.railway.app/
```

You should see:
```json
{
  "service": "SPX COMMAND",
  "status": "running",
  "mode": "PAPER"
}
```

Check status:
```
https://spx-command-production.up.railway.app/status
```

Should show your Alpaca account connected and balance $100,000.

---

## Step 5 — Connect Dashboard (2 min)

Open `trading-dashboard.jsx` and find line 8:
```js
const SERVER = typeof window !== "undefined" && window.location.hostname === "localhost"
  ? "http://localhost:3001"
  : null;
```

Change `null` to your Railway URL:
```js
  : "https://spx-command-production.up.railway.app";
```

Then deploy the dashboard to Vercel (free):
1. Upload dashboard to a new GitHub repo `spx-dashboard`
2. Go to vercel.com → New Project → import `spx-dashboard`
3. Deploy — get URL like `https://spx-dashboard.vercel.app`

---

## Step 6 — TradingView Webhook (2 min)

In TradingView, create an alert on your NY ORB + VWAP signal:

**Webhook URL:**
```
https://spx-command-production.up.railway.app/webhook
```

**Alert Message (LONG):**
```json
{
  "symbol":     "SPX",
  "direction":  "LONG",
  "entry":      {{close}},
  "stop":       {{plot("Stop Loss")}},
  "tp1":        {{plot("TP1")}},
  "tp2":        {{plot("TP2")}},
  "trigger":    "ORB Breakout",
  "confidence": "HIGH"
}
```

**Alert Message (SHORT):**
```json
{
  "symbol":     "SPX",
  "direction":  "SHORT",
  "entry":      {{close}},
  "stop":       {{plot("Stop Loss")}},
  "tp1":        {{plot("TP1")}},
  "tp2":        {{plot("TP2")}},
  "trigger":    "VWAP Rejection",
  "confidence": "HIGH"
}
```

---

## Step 7 — Test End-to-End

Send a test webhook with curl (or Postman):
```bash
curl -X POST https://spx-command-production.up.railway.app/webhook \
  -H "Content-Type: application/json" \
  -d '{
    "symbol":     "SPX",
    "direction":  "LONG",
    "entry":      5400,
    "stop":       5392,
    "tp1":        5416,
    "tp2":        5432,
    "trigger":    "Manual Test",
    "confidence": "HIGH"
  }'
```

Expected response:
```json
{ "status": "received", "signal": { ... } }
```

Then open your dashboard — signal card should appear.
Click **EXECUTE LONG** — orders should appear in Alpaca paper app.

---

## Monitoring Your Trades

**Alpaca app (iOS/Android):**
- Download "Alpaca: Commission-Free Trading"
- Log in → switch to Paper mode
- Positions tab: see open SPXW spreads with live P&L
- Orders tab: see all open bracket orders

**Railway logs:**
- Railway dashboard → your service → **Logs** tab
- See every webhook, order placement, fill, stop/TP in real time

**Your dashboard:**
- Signal cards update via SSE as orders fill
- Session P&L updates automatically

---

## Going Live (When Ready)

Only change needed:
```
ALPACA_BASE_URL = https://api.alpaca.markets
ACCOUNT_SIZE    = your_real_account_size
```

Update in Railway Variables → auto-redeploys. That's it.

---

## Monthly Cost Summary

| Service  | Cost   | Purpose                    |
|----------|--------|----------------------------|
| Railway  | $5/mo  | Runs server.js 24/7        |
| Vercel   | Free   | Hosts React dashboard      |
| Alpaca   | Free   | Paper/live trading API     |
| Total    | $5/mo  | Full cloud stack           |
