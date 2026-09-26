import { Router } from 'express'
import express from 'express'
import bcrypt from 'bcryptjs'
import { ms, q } from '../db.js'
import { HttpError, int, str, wrap } from '../util.js'
import { clearAuthCookie, requireAuth } from '../auth.js'
import { realtime } from '../realtime.js'

/** Everything the React app needs after login, in one round trip. */
export async function loadState(userId) {
  const u = await q(
    `SELECT id, username, email, display_name, avatar, fav_subject, settings, whiteboard, ${ms('created_at')} AS created_at
     FROM users WHERE id = $1`,
    [userId],
  )
  if (!u.rows[0]) return null
  const user = u.rows[0]
  const [tasks, notes, sessions] = await Promise.all([
    q(`SELECT id, title, priority, status, deadline, ${ms('created_at')} AS "createdAt", ${ms('completed_at')} AS "completedAt"
       FROM tasks WHERE user_id = $1 ORDER BY created_at`, [userId]),
    q(`SELECT id, title, subject, body, ${ms('updated_at')} AS "updatedAt" FROM notes WHERE user_id = $1 ORDER BY updated_at DESC`, [userId]),
    q(`SELECT id, day AS date, ${ms('started_at')} AS start, minutes, subject FROM study_sessions WHERE user_id = $1 ORDER BY started_at`, [userId]),
  ])
  const clean = rows => rows.map(r => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null)))
  return {
    user: { id: user.id, username: user.username, email: user.email, createdAt: user.created_at },
    profile: { name: user.display_name, avatar: user.avatar, favSubject: user.fav_subject },
    settings: user.settings,
    whiteboard: user.whiteboard,
    tasks: clean(tasks.rows),
    notes: notes.rows,
    sessions: sessions.rows,
  }
}

const router = Router()
router.use(requireAuth)

router.put('/profile', wrap(async (req, res) => {
  const name = str(req.body.name, { min: 1, max: 40, field: 'Name' })
  const avatar = int(req.body.avatar, { min: 0, max: 15, field: 'Avatar' })
  const favSubject = str(req.body.favSubject, { max: 60, field: 'Favourite subject', fallback: 'General' })
  await q(`UPDATE users SET display_name = $2, avatar = $3, fav_subject = $4 WHERE id = $1`, [req.userId, name, avatar, favSubject])
  await realtime.refreshUser(req.userId)
  res.json({ ok: true })
}))

router.put('/settings', wrap(async (req, res) => {
  const s = req.body.settings
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new HttpError(400, 'settings must be an object')
  if (JSON.stringify(s).length > 4000) throw new HttpError(400, 'settings are too large')
  await q(`UPDATE users SET settings = $2 WHERE id = $1`, [req.userId, s])
  res.json({ ok: true })
}))

// the whiteboard is a PNG data URL, so this one route accepts a bigger body
router.put('/whiteboard', express.json({ limit: '6mb' }), wrap(async (req, res) => {
  const data = req.body.data
  if (data !== null && (typeof data !== 'string' || !data.startsWith('data:image/png;base64,'))) throw new HttpError(400, 'whiteboard must be a PNG data URL or null')
  await q(`UPDATE users SET whiteboard = $2 WHERE id = $1`, [req.userId, data])
  res.json({ ok: true })
}))

router.delete('/', wrap(async (req, res) => {
  const r = await q(`SELECT password_hash FROM users WHERE id = $1`, [req.userId])
  if (!r.rows[0] || !(await bcrypt.compare(String(req.body.password ?? ''), r.rows[0].password_hash))) throw new HttpError(401, 'Password is incorrect')
  await realtime.leaveRoom(req.userId)
  await q(`DELETE FROM users WHERE id = $1`, [req.userId]) // cascades to all their rows
  realtime.disconnectUser(req.userId)
  clearAuthCookie(res)
  res.json({ ok: true })
}))

export default router
