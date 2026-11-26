import jwt from 'jsonwebtoken'
import { HttpError } from './util.js'
import { q } from './db.js'

const PROD = process.env.NODE_ENV === 'production'
let SECRET = process.env.JWT_SECRET
if (!SECRET || SECRET === 'change-me') {
  if (PROD) { console.error('JWT_SECRET must be set to a long random string in production.'); process.exit(1) }
  SECRET = 'dev-only-secret-do-not-use-in-production'
  console.warn('[auth] Using a development JWT secret. Set JWT_SECRET before deploying.')
}

const COOKIE = 'lofi_token'
const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000

export function setAuthCookie(res, userId) {
  const token = jwt.sign({ sub: userId }, SECRET, { expiresIn: '30d' })
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: THIRTY_DAYS, path: '/' })
}

export function clearAuthCookie(res) {
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure: PROD, path: '/' })
}

/** Login cookie tokens carry no audience; socket tokens have aud "socket" and can't be used as a login. */
function verify(token) {
  try {
    const p = jwt.verify(token, SECRET)
    return p.aud ? null : p
  } catch { return null }
}

// When someone changes or resets their password, every login cookie issued before that moment
// stops working, which logs out their other devices. The change time is cached for a minute.
const pwChanged = new Map() // userId -> { at: ms (0 = never changed), fetched: ms }
async function passwordChangedAt(userId) {
  const c = pwChanged.get(userId)
  if (c && Date.now() - c.fetched < 60_000) return c.at
  const r = await q(`SELECT pw_changed_at FROM users WHERE id = $1`, [userId])
  const at = r.rows[0]?.pw_changed_at ? new Date(r.rows[0].pw_changed_at).getTime() : 0
  pwChanged.set(userId, { at, fetched: Date.now() })
  return at
}
/** Call right after changing a password so this server stops accepting old cookies immediately. */
export function notePasswordChange(userId, at = Date.now()) {
  pwChanged.set(userId, { at, fetched: Date.now() })
}
async function stillValid(p) {
  const at = await passwordChangedAt(p.sub)
  return !at || (p.iat ?? 0) >= Math.floor(at / 1000)
}

/**
 * Short-lived token for the Socket.IO handshake. Needed when the frontend is on a different
 * domain from the API (e.g. Vercel + Render), where the browser won't send our cookie to the socket.
 */
export function signSocketToken(userId) {
  return jwt.sign({ sub: userId }, SECRET, { expiresIn: '2m', audience: 'socket' })
}

export function userIdFromSocketToken(token) {
  if (typeof token !== 'string') return null
  try { return jwt.verify(token, SECRET, { audience: 'socket' }).sub } catch { return null }
}

/** Express middleware: rejects the request unless it carries a valid login cookie. */
export function requireAuth(req, _res, next) {
  const p = req.cookies?.[COOKIE] && verify(req.cookies[COOKIE])
  if (!p) return next(new HttpError(401, 'Please log in'))
  stillValid(p).then(ok => {
    if (!ok) return next(new HttpError(401, 'Your password was changed. Please log in again.'))
    req.userId = p.sub
    next()
  }, next)
}

/** For Socket.IO handshakes, which only give us the raw Cookie header. */
export async function userIdFromCookieHeader(header = '') {
  const part = header.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='))
  const p = part ? verify(decodeURIComponent(part.slice(COOKIE.length + 1))) : null
  return p && (await stillValid(p)) ? p.sub : null
}
