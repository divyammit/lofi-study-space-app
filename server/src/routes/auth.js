import { Router } from 'express'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { randomUUID } from 'node:crypto'
import { q } from '../db.js'
import { HttpError, str, wrap } from '../util.js'
import { clearAuthCookie, requireAuth, setAuthCookie, signSocketToken } from '../auth.js'
import { loadState } from './me.js'

const router = Router()
// real hash of a random string, compared when a login name doesn't exist so timing doesn't reveal which accounts exist
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), 11)
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many attempts. Try again in a few minutes.' } })

router.post('/signup', limiter, wrap(async (req, res) => {
  const username = str(req.body.username, { min: 3, max: 20, field: 'Username' })
  if (!/^[A-Za-z0-9_]+$/.test(username)) throw new HttpError(400, 'Username can use letters, numbers and underscores only')
  const email = str(req.body.email, { min: 3, max: 254, field: 'Email' }).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address')
  const password = typeof req.body.password === 'string' ? req.body.password : ''
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
  if (password.length > 200) throw new HttpError(400, 'Password is too long')
  const displayName = str(req.body.displayName, { max: 40, field: 'Name', fallback: username })

  const hash = await bcrypt.hash(password, 11)
  let user
  try {
    const r = await q(
      `INSERT INTO users (username, email, password_hash, display_name, avatar)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [username, email, hash, displayName, Math.floor(Math.random() * 16)],
    )
    user = r.rows[0]
  } catch (e) {
    if (e.code === '23505') {
      throw new HttpError(409, e.constraint === 'users_email_lower' ? 'An account with that email already exists' : 'That username is taken')
    }
    throw e
  }

  // a starter note and task so the room isn't empty on first visit
  await q(
    `INSERT INTO notes (id, user_id, title, subject, body) VALUES ($1, $2, 'How this room works', 'General', $3)`,
    [randomUUID(), user.id, 'Press Start study to begin a 25 minute focus session.\n\nTasks live on the board, notes live here, and the whiteboard is for working things out by hand.\n\nEverything is saved to your account, so you can pick up on any device.'],
  )
  await q(`INSERT INTO tasks (id, user_id, title, priority, status) VALUES ($1, $2, 'Finish my first focus session', 'medium', 'backlog')`, [randomUUID(), user.id])

  setAuthCookie(res, user.id)
  res.status(201).json(await loadState(user.id))
}))

router.post('/login', limiter, wrap(async (req, res) => {
  const login = str(req.body.login, { min: 1, max: 254, field: 'Username or email' }).toLowerCase()
  const password = typeof req.body.password === 'string' ? req.body.password : ''
  const r = await q(`SELECT id, password_hash FROM users WHERE lower(username) = $1 OR lower(email) = $1`, [login])
  const user = r.rows[0]
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH)
  if (!user || !ok) throw new HttpError(401, 'Wrong username/email or password')
  setAuthCookie(res, user.id)
  res.json(await loadState(user.id))
}))

router.post('/logout', (_req, res) => {
  clearAuthCookie(res)
  res.json({ ok: true })
})

/** Who am I? Returns the full app state, or 401 if not logged in. */
router.get('/me', requireAuth, wrap(async (req, res) => {
  const state = await loadState(req.userId)
  if (!state) { clearAuthCookie(res); throw new HttpError(401, 'Please log in') }
  res.json(state)
}))

/** Token the browser passes to Socket.IO when it connects (works across domains). */
router.get('/socket-token', requireAuth, (req, res) => {
  res.json({ token: signSocketToken(req.userId) })
})

export default router
