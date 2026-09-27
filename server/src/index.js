import express from 'express'
import cookieParser from 'cookie-parser'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { migrate, pool } from './db.js'
import { HttpError } from './util.js'
import { realtime } from './realtime.js'
import authRoutes from './routes/auth.js'
import meRoutes from './routes/me.js'
import taskRoutes from './routes/tasks.js'
import noteRoutes from './routes/notes.js'
import sessionRoutes from './routes/sessions.js'
import friendRoutes from './routes/friends.js'
import chatRoutes from './routes/chats.js'
import { requireAuth } from './auth.js'

const PORT = Number(process.env.PORT) || 3001
const app = express()
// number of proxies in front of the server (Render = 1; Vercel rewrite + Render = 2). Used for client IPs in rate limiting.
app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1)
app.disable('x-powered-by')

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  next()
})
// routes that accept images parse their own (larger) bodies
const json = express.json({ limit: '200kb' })
const bigBody = p => p === '/api/me/whiteboard' || /^\/api\/chats\/[^/]+\/messages$/.test(p)
app.use((req, res, next) => (bigBody(req.path) && req.method !== 'GET' ? next() : json(req, res, next)))
app.use(cookieParser())

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true }) } catch { res.status(503).json({ ok: false }) }
})
app.use('/api/auth', authRoutes)
app.use('/api/me', meRoutes)
app.use('/api/tasks', taskRoutes)
app.use('/api/notes', noteRoutes)
app.use('/api/sessions', sessionRoutes)
app.use('/api/friends', friendRoutes)
app.use('/api/chats', chatRoutes)

// STUN/TURN servers for voice & video calls. STUN is free; TURN (optional) relays calls
// for people whose network blocks direct connections (common on mobile data).
app.get('/api/rtc-config', requireAuth, (_req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]
  if (process.env.TURN_URLS) {
    iceServers.push({
      urls: process.env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME,
      credential: process.env.TURN_CREDENTIAL,
    })
  }
  res.json({ iceServers })
})
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')))

// serve the built React app (client/dist) from the same server in production
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist')
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: '1h' }))
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
} else {
  app.get('/', (_req, res) => res.send('API is running. Start the React app with "npm run dev" in client/.'))
}

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too large to save' })
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' })
  const status = err.status && err.status < 600 ? err.status : 500
  if (status === 500) console.error(err)
  res.status(status).json({ error: status === 500 ? 'Server error. Please try again.' : err.message })
})

const server = createServer(app)
await migrate()
await realtime.init(server)
server.listen(PORT, () => console.log(`Lo-Fi Study Space server on http://localhost:${PORT}`))
