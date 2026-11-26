import { Router } from 'express'
import bcrypt from 'bcryptjs'
import rateLimit from 'express-rate-limit'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { pool, q } from '../db.js'
import { HttpError, str, wrap } from '../util.js'
import { clearAuthCookie, notePasswordChange, requireAuth, setAuthCookie, signSocketToken } from '../auth.js'
import { appUrl, emailLayout, mailReady, sendMail } from '../mail.js'
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

// ---------- forgot / reset / change password ----------

const RESET_MINUTES = 30
const sha256 = s => createHash('sha256').update(s).digest('hex')
const newPassword = v => {
  const password = typeof v === 'string' ? v : ''
  if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters')
  if (password.length > 200) throw new HttpError(400, 'Password is too long')
  return password
}
const forgotLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many reset requests. Try again in 15 minutes.' } })

/**
 * "Forgot password": email a one-time reset link. The answer is always the same, so this can't be
 * used to find out which usernames or emails have accounts.
 */
router.post('/forgot', forgotLimiter, wrap(async (req, res) => {
  const login = str(req.body.login, { min: 1, max: 254, field: 'Username or email' }).toLowerCase()
  res.json({ ok: true, message: `If that account exists, a reset link is on its way to the email it was registered with. The link works for ${RESET_MINUTES} minutes.` })
  // the rest happens after answering, so response time doesn't reveal whether the account exists
  try {
    const r = await q(`SELECT id, username, email, display_name FROM users WHERE lower(username) = $1 OR lower(email) = $1`, [login])
    const user = r.rows[0]
    if (!user) return
    // at most 3 links per account per hour, so nobody can flood someone's inbox
    const recent = await q(`SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1 AND created_at > now() - interval '1 hour'`, [user.id])
    if (recent.rows[0].n >= 3) return
    const token = randomBytes(32).toString('base64url')
    await q(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`, [user.id, sha256(token), RESET_MINUTES])
    // the token is in the #fragment, which browsers never send to servers or put in logs
    const link = `${appUrl()}/reset-password#token=${token}`
    if (!mailReady()) {
      console.log(`[auth] Password reset link for @${user.username} (email isn't set up, so pass this on by hand; it expires in ${RESET_MINUTES} min): ${link}`)
      return
    }
    const mail = emailLayout({
      title: 'Reset your password',
      intro: `Hi ${user.display_name}, someone (hopefully you) asked to reset the password for @${user.username}. This link works once, for the next ${RESET_MINUTES} minutes.`,
      button: 'Choose a new password',
      link,
      outro: "Didn't ask for this? Ignore this email: your password stays the same.",
    })
    await sendMail({ to: user.email, subject: 'Reset your Lo-Fi Study Space password', ...mail })
    console.log(`[auth] Reset email sent to @${user.username}`)
  } catch (e) {
    console.error('[auth] Could not send reset email:', e.message)
  }
}))

async function findReset(token, db = pool, lock = false) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null
  const r = await db.query(
    `SELECT pr.id, pr.user_id, u.username, u.display_name, u.email
       FROM password_resets pr JOIN users u ON u.id = pr.user_id
      WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now()${lock ? ' FOR UPDATE OF pr' : ''}`,
    [sha256(token)],
  )
  return r.rows[0] ?? null
}
const DEAD_LINK = 'This reset link has expired or was already used. Ask for a new one.'

/** Is this reset link still good? Used to show "resetting the password for @name". */
router.post('/reset/check', limiter, wrap(async (req, res) => {
  const r = await findReset(req.body.token)
  if (!r) throw new HttpError(400, DEAD_LINK)
  res.json({ ok: true, username: r.username, name: r.display_name })
}))

/** Set a new password with a reset link, then log in. */
router.post('/reset', limiter, wrap(async (req, res) => {
  const password = newPassword(req.body.password)
  const hash = await bcrypt.hash(password, 11)
  const client = await pool.connect()
  let row
  try {
    await client.query('BEGIN')
    // row lock: two clicks on the same link can't both succeed
    row = await findReset(req.body.token, client, true)
    if (!row) throw new HttpError(400, DEAD_LINK)
    await client.query(`UPDATE users SET password_hash = $2, pw_changed_at = now() WHERE id = $1`, [row.user_id, hash])
    // this link and any other outstanding links for the account stop working
    await client.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [row.user_id])
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  notePasswordChange(row.user_id)
  setAuthCookie(res, row.user_id)
  res.json(await loadState(row.user_id))
  notifyChanged(row).catch(e => console.error('[auth] Could not send password-changed email:', e.message))
}))

/** Change password from Settings (needs the current one). Logs out other devices. */
router.post('/password', requireAuth, limiter, wrap(async (req, res) => {
  const current = typeof req.body.current === 'string' ? req.body.current : ''
  const password = newPassword(req.body.password)
  const r = await q(`SELECT id, username, display_name, email, password_hash FROM users WHERE id = $1`, [req.userId])
  const user = r.rows[0]
  if (!user || !(await bcrypt.compare(current, user.password_hash))) throw new HttpError(400, 'Your current password is wrong')
  if (await bcrypt.compare(password, user.password_hash)) throw new HttpError(400, 'Pick a password different from the current one')
  await q(`UPDATE users SET password_hash = $2, pw_changed_at = now() WHERE id = $1`, [user.id, await bcrypt.hash(password, 11)])
  await q(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [user.id])
  notePasswordChange(user.id)
  setAuthCookie(res, user.id) // this device stays logged in
  res.json({ ok: true })
  notifyChanged(user).catch(e => console.error('[auth] Could not send password-changed email:', e.message))
}))

async function notifyChanged(user) {
  if (!mailReady()) return
  const mail = emailLayout({
    title: 'Your password was changed',
    intro: `Hi ${user.display_name}, the password for @${user.username} was just changed, and other devices were logged out.`,
    outro: "If this wasn't you, use \"Forgot password?\" on the login screen right away to take your account back.",
  })
  await sendMail({ to: user.email, subject: 'Your Lo-Fi Study Space password was changed', ...mail })
}

/** Token the browser passes to Socket.IO when it connects (works across domains). */
router.get('/socket-token', requireAuth, (req, res) => {
  res.json({ token: signSocketToken(req.userId) })
})

export default router
