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
