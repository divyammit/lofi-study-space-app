# Deploying Lo-Fi Study Space to the internet

This guide puts the app online with two free services:

- **Neon** hosts the PostgreSQL database.
- **Render** runs the Node server, which also serves the React app. You get an `https://….onrender.com` link to share.

Free tiers and their limits change over time, so check each site's current pricing page.
At the time of writing, Render's free web services go to sleep after about 15 minutes without
visitors, so the first visit after a quiet spell can take up to a minute to load.

---

## 1. Create the database (Neon)

1. Go to **neon.tech** and sign up (GitHub login works).
2. Create a project. Name it `lofi-study-space` and pick the region closest to your users.
3. On the project dashboard, open **Connect** (or "Connection string") and copy the string.
   It looks like
   `postgresql://user:password@ep-something.aws.neon.tech/neondb?sslmode=require`
4. Keep it private: anyone with this string can read and change your database.

You can use the same string in `server/.env` for local development (with `DATABASE_SSL=true`).

## 2. Put the code on GitHub

1. Create a new **empty** repository on github.com (no README), e.g. `lofi-study-space`.
2. In a terminal, inside the project folder:

```bash
git init
git add .
git commit -m "Lo-Fi Study Space"
git branch -M main
git remote add origin https://github.com/<your-username>/lofi-study-space.git
git push -u origin main
```

`.gitignore` already keeps `node_modules`, `client/dist` and `server/.env` out of the repo.
Before pushing, check that `server/.env` does **not** appear in `git status`.

Add your teammates as collaborators under the repo's Settings → Collaborators.

## 3. Create the web service (Render)

1. Go to **render.com**, sign up with GitHub, and click **New → Web Service**.
2. Connect your `lofi-study-space` repository.
3. Fill in:

| Setting | Value |
|---|---|
| Runtime / Language | Node |
| Root directory | *(leave empty)* |
| Build command | `npm run build` |
| Start command | `npm start` |
| Instance type | Free |
| Health check path | `/api/health` *(under Advanced)* |

4. Add these **environment variables**:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` |
| `DATABASE_URL` | the Neon string from step 1 |
| `DATABASE_SSL` | `true` |
| `JWT_SECRET` | a long random string (see below) |

Generate a secret with:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

5. Click **Create Web Service**. The first build takes a few minutes. When the log shows
   `Lo-Fi Study Space server on http://localhost:10000` (Render picks the port), it's live.
6. Open the `https://<your-service>.onrender.com` link, create an account, and share the link.

(Alternative: Render's **New → Blueprint** can read the included `render.yaml`. It fills in
everything except `DATABASE_URL`, which it asks you for.)

## 4. Updating the live site

Every `git push` to `main` makes Render rebuild and redeploy automatically.
The database schema updates itself on start, because every statement in `schema.sql` uses `IF NOT EXISTS`.
If you later change an existing column, write an `ALTER TABLE` statement in `schema.sql` instead of editing the `CREATE TABLE`.

## 5. Checking it works

- `https://<your-service>.onrender.com/api/health` should return `{"ok":true}`.
- Sign up in one browser and again in an incognito window, add each other as friends,
  and open a room: the second window should see it appear without refreshing.
- In Neon's **SQL Editor** you can inspect the data, e.g.
  `SELECT username, created_at FROM users;` or
  `SELECT u.username, sum(s.minutes) FROM study_sessions s JOIN users u ON u.id = s.user_id GROUP BY u.username;`

## Optional: frontend on Vercel, API on Render

Vercel can't run this backend: it only runs short-lived serverless functions, and our server
needs to stay on to hold live Socket.IO connections and room state. You can still put the
**frontend** on Vercel, with the **backend** on Render (steps 1–3 above).

1. Finish steps 1–3 first and note your Render address, e.g. `https://lofi-api.onrender.com`.
2. In `vercel.json` (in the top folder of the project), replace `YOUR-RENDER-SERVICE.onrender.com`
   with your Render address. Commit and push. This makes Vercel forward `/api/...` to Render,
   so login cookies stay on your Vercel domain.
3. On **vercel.com**: **Add New → Project**, import the same GitHub repo, then:

| Setting | Value |
|---|---|
| Root Directory | leave empty (the project's top folder) |
| Framework Preset / Build / Output | leave as they are: `vercel.json` sets them |
| Environment variable | `VITE_SOCKET_URL` = your Render address (no trailing slash) |

   If you changed Build, Output or Root Directory in the dashboard earlier, set them back to their
   defaults (turn the "Override" switches off).

4. Deploy, and note your Vercel address (e.g. `https://lofi-study-space.vercel.app`).
5. Back on Render, add two environment variables and redeploy:

| Key | Value |
|---|---|
| `CLIENT_ORIGIN` | your Vercel address (no trailing slash) |
| `TRUST_PROXY` | `2` |

6. Open the Vercel address and test with two accounts, as in step 5 of this guide.

How it works: normal requests go Browser → Vercel → Render. The live connection goes
straight from the browser to Render, using a 2-minute token the app fetches through `/api`,
because Vercel doesn't forward WebSocket connections.

Common Vercel errors:

| Error | Cause / fix |
|---|---|
| "No Output Directory named 'public' (or 'dist') found" | `vercel.json` is missing from the top folder, or Root Directory / Output was overridden in the dashboard |
| Build runs but API calls return 404 | `vercel.json` still has the placeholder Render address |
| Can log in, but Study Street stays "Connecting…" | `VITE_SOCKET_URL` missing on Vercel (redeploy after adding it), or `CLIENT_ORIGIN` missing/wrong on Render |
| Everyone gets "Too many attempts" | Set `TRUST_PROXY=2` on Render |

## Making calls reliable (TURN relay, needed for real-world calls)

**Symptom this fixes:** people can join a call and see each other's names, but nobody hears or sees anyone,
and the tiles say "Can't connect".

**Why:** audio and video travel directly between browsers. Mobile data and many college/office Wi-Fi
networks block that direct path. A **TURN relay** carries the call when the direct path is blocked.
It's a separate service, and you set it up once.

### Option A: Metered (simplest: copy and paste)

The website's layout may differ slightly from these steps; the idea stays the same.

1. Go to **metered.ca**, sign up, and open the **TURN Server** section of the dashboard.
   Choose the free plan (it has a monthly data limit; check their current limits).
2. Create a TURN credential if it asks you to.
3. The dashboard shows a code example containing `iceServers: [ ... ]` with lines like
   `urls: "turn:....relay.metered.ca:80"`, a `username` and a `credential`.
   **Copy that whole code example.** You don't need to edit it.
4. On **Render**, open your service, then **Environment → Add Environment Variable**:
   - Key: `ICE_SERVERS_JSON`
   - Value: paste what you copied
5. Click **Save Changes**. Render redeploys by itself in a few minutes.
6. Check it worked: in Render's **Logs** you should see
   `[rtc] TURN relay configured: calls will also work on strict networks.`

The app accepts the code example as-is: strict JSON, a JavaScript snippet, or just the `[...]` list.

### Option B: Cloudflare

Cloudflare's Realtime/TURN service has, as far as I know, a generous free allowance (check current terms).
In the Cloudflare dashboard, create a **TURN key**; it gives you a **Key ID** and an **API token**.
Add them on Render as:

| Key | Value |
|---|---|
| `CLOUDFLARE_TURN_KEY_ID` | the Key ID |
| `CLOUDFLARE_TURN_API_TOKEN` | the API token |

The server then fetches fresh, short-lived relay credentials automatically.

### Option C: any other TURN provider

| Key | Value |
|---|---|
| `TURN_URLS` | the TURN address(es), comma-separated, e.g. `turn:relay.example.com:3478,turns:relay.example.com:5349` |
| `TURN_USERNAME` | username |
| `TURN_CREDENTIAL` | password / credential |

### How much data does the relay use?
Only calls that can't connect directly use it. Roughly: a voice call uses a few tens of MB per person per hour;
video uses several hundred MB per person per hour. These are rough estimates. For a class project, a free tier
is usually plenty, but keep an eye on the provider's usage page.

Calls also need **https** (browsers only allow microphone and camera on secure sites). Render gives you https automatically.

## AI study tutor

The tutor needs an API key from one AI provider. Add it on Render → Environment and redeploy.
The server's log then says `[ai] Study tutor using ...`. Without a key, the Tutor panel explains it isn't switched on.

### Option A: Google Gemini (free tier, no card needed)
1. Go to **aistudio.google.com**, sign in with a Google account, and click **Get API key → Create API key**.
2. Copy the key.
3. On Render, add `GEMINI_API_KEY` = the key.

The default model is `gemini-3.5-flash-lite`. To use another one, add `GEMINI_MODEL`.
Google changes free-tier limits often (they've been cut more than once), so check your project's limits in AI Studio.
When the free quota runs out, students see "The AI service is busy or its usage limit was reached" and the question isn't counted against them.

### Option B: Anthropic Claude (paid per use)
Create a key at **console.anthropic.com** → API Keys, then add `ANTHROPIC_API_KEY` on Render.
Default model: `claude-haiku-5-5`. Override with `ANTHROPIC_MODEL`.

### Option C: OpenAI or an OpenAI-compatible service (Groq, OpenRouter, ...)
Add `OPENAI_API_KEY` and `OPENAI_MODEL`, and for non-OpenAI services `OPENAI_BASE_URL`
(for example `https://api.groq.com/openai/v1`). Check the provider's docs for its exact base URL and model names.

If more than one key is set, add `AI_PROVIDER` = `gemini`, `anthropic` or `openai` to choose.

### Daily limits
| Key | Default | Meaning |
|---|---|---|
| `AI_FREE_DAILY` | 10 | Questions per day on the Free plan |
| `AI_PRO_DAILY` | 150 | Fair-use questions per day on Pro |
| `APP_TIMEZONE` | Asia/Kolkata | Limits reset at midnight in this timezone |

## Payments (for Pro)

### UPI QR payments (real money, checked by your team)
Add these on Render → Environment:

| Key | Value |
|---|---|
| `UPI_ID` | the UPI ID that receives payments, e.g. `name@oksbi` |
| `UPI_PAYEE_NAME` | the name shown to payers, e.g. `Labhay` |
| `ADMIN_USERNAMES` | app usernames (comma-separated) allowed to approve payments, e.g. `divyam,labhay` |

How it works: **Pay** opens a checkout page at `/checkout/<order>` with a QR that has the amount and an order reference
(`LOFI-XXXXXX`) pre-filled, plus a "Pay with UPI app" button on phones. After paying, the student enters the 12-digit
UPI reference (UTR). Team members get a notification, and the Pro panel shows a **Payments to verify** list: check in the
UPI app that a payment with that amount and UTR arrived, then **Approve** (Pro switches on and the student's page updates)
or **Reject** (with a reason). Each UTR can only be used once.
Real money is involved: keep track of refunds yourselves, and never approve a payment you haven't seen arrive.

When `UPI_ID` is set it takes priority over demo mode. Razorpay keys, if added, take priority over both.

### Demo mode (default: nothing to set up)
With no Razorpay keys, the app uses a built-in **demo gateway**. The Pro panel opens a realistic checkout
(card with OTP, or UPI) that only accepts test details, and nothing real is charged:

| Method | Test details | Result |
|---|---|---|
| Card | `4111 1111 1111 1111` (or `5555 5555 5555 4444`), any future expiry, any CVV, OTP `1234` | success |
| Card | `4000 0000 0000 0002` | declined |
| UPI | `success@demo` | success |
| UPI | `failure@demo` | declined |

Behind the window, the server runs the same steps as with Razorpay: it creates an order, the gateway signs the payment
(HMAC-SHA256), `/verify` checks the signature, then Pro is activated. Rows in `payments` are marked `provider = 'demo'`.
To switch demo mode off, set `DEMO_PAYMENTS=off`. Adding Razorpay keys switches to Razorpay automatically.

## Razorpay (optional)
Note: Razorpay's Indian signup asks for a PAN before you reach the dashboard. Only use your own details.

### 1. Get test keys (no real money)
1. Sign up at **razorpay.com** and open the **Dashboard**.
2. Make sure the **Test Mode** toggle (top of the dashboard) is on.
3. Go to **Account & Settings → API Keys → Generate Key** (in some layouts: Settings → API Keys).
   You get a **Key ID** starting with `rzp_test_` and a **Key Secret**. The secret is shown only once, so copy it now.
4. On Render, add:

| Key | Value |
|---|---|
| `RAZORPAY_KEY_ID` | the Key ID (`rzp_test_...`) |
| `RAZORPAY_KEY_SECRET` | the Key Secret |

The log then says `[billing] Razorpay TEST mode.` The Pro panel shows test card details:
card `4100 2800 0000 1007`, any future expiry, any CVV, OTP `1234`, or UPI `success@razorpay`.
These come from Razorpay's docs and may change; their **Test integration** page lists the current ones.

### 2. Optional: webhook (backup if a student closes the tab right after paying)
In the Razorpay Dashboard → **Webhooks → Add New Webhook**:
- URL: `https://<your-service>.onrender.com/api/billing/webhook`
- Secret: make up a long random string
- Events: `payment.captured` and `payment.failed`

Then add `RAZORPAY_WEBHOOK_SECRET` = that same string on Render.

### 3. Prices
`PRO_MONTH_PRICE_INR` (default 99) and `PRO_YEAR_PRICE_INR` (default 799).

### Going live (real money)
Live keys (`rzp_live_...`) need Razorpay to activate your account, which involves KYC (PAN, bank account, and so on).
Requirements for individuals and students change, so check Razorpay's current activation rules. Before charging real
money you also need a Privacy Policy, Terms and a refund policy page. For a class project, test mode is enough.

## Troubleshooting

| Symptom | Likely fix |
|---|---|
| Build fails with a Node version error | Make sure `NODE_VERSION` is `22` |
| Log says `DATABASE_URL is not set` | Add it in Render → Environment, then redeploy |
| Log mentions SSL / certificate errors | Set `DATABASE_SSL=true` |
| Log says `JWT_SECRET must be set` | Add a long random `JWT_SECRET` |
| "Can't reach the server" on first visit | The free instance is waking up; wait and press Try again |
| Everyone got logged out | `JWT_SECRET` was changed; old login cookies stop working (expected) |
| Open study rooms vanished | The server restarted or slept; rooms are live-only by design, saved data is unaffected |
| Call connects but no sound/video, tiles say "Can't connect" | A network blocks direct calls; add a TURN relay (see "Making calls reliable") |
| Tile says "Tap to hear …" | The browser blocked sound until you click; tap the tile once |
| "Your microphone is blocked" | Click the lock/camera icon in the browser's address bar and allow microphone (and camera) for the site |
| Tutor says it isn't switched on | No AI key on Render; see "AI study tutor" |
| Tutor: "rejected the server's API key" | The key is wrong or was revoked; create a new one |
| Pro panel: "Payments aren't switched on" | Add `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` |
| Razorpay window doesn't open | An ad-blocker is blocking checkout.razorpay.com; allow it for the site |
| Screen share button missing | Phones don't support screen sharing in the browser; use a laptop |
