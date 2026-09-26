import { Router } from 'express'
import { q } from '../db.js'
import { HttpError, str, wrap } from '../util.js'
import { requireAuth } from '../auth.js'
import { realtime } from '../realtime.js'

const router = Router()
router.use(requireAuth)

const UUID = /^[0-9a-f-]{36}$/i
const uuid = v => { if (!UUID.test(v)) throw new HttpError(400, 'Invalid user id'); return v }

/** Accepted friends (with live presence), plus pending requests in both directions. */
router.get('/', wrap(async (req, res) => {
  const r = await q(
    `SELECT u.id, u.username, u.display_name AS name, u.avatar, f.status, (f.requester_id = $1) AS outgoing
     FROM friendships f
     JOIN users u ON u.id = CASE WHEN f.requester_id = $1 THEN f.addressee_id ELSE f.requester_id END
     WHERE f.requester_id = $1 OR f.addressee_id = $1
     ORDER BY u.display_name`,
    [req.userId],
  )
  const pick = ({ id, username, name, avatar }) => ({ id, username, name, avatar })
  res.json({
    friends: r.rows.filter(x => x.status === 'accepted').map(x => ({ ...pick(x), ...realtime.presenceOf(x.id) })),
    incoming: r.rows.filter(x => x.status === 'pending' && !x.outgoing).map(pick),
    outgoing: r.rows.filter(x => x.status === 'pending' && x.outgoing).map(pick),
  })
}))

router.post('/requests', wrap(async (req, res) => {
  const username = str(req.body.username, { min: 1, max: 20, field: 'Username' }).replace(/^@/, '')
  const t = await q(`SELECT id, display_name FROM users WHERE lower(username) = lower($1)`, [username])
  const target = t.rows[0]
  if (!target) throw new HttpError(404, `No one is called @${username}`)
  if (target.id === req.userId) throw new HttpError(400, "You can't add yourself")

  const existing = await q(
    `SELECT requester_id, status FROM friendships
     WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
    [req.userId, target.id],
  )
  const row = existing.rows[0]
  if (row?.status === 'accepted') throw new HttpError(409, `You're already friends with @${username}`)
  if (row && row.requester_id === req.userId) throw new HttpError(409, `Request to @${username} already sent`)
  if (row) {
    // they already asked us: adding them back accepts it
    await q(`UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2`, [target.id, req.userId])
    realtime.friendsChanged([req.userId, target.id])
    return res.json({ status: 'accepted', name: target.display_name })
  }
  await q(`INSERT INTO friendships (requester_id, addressee_id) VALUES ($1, $2)`, [req.userId, target.id])
  realtime.friendsChanged([req.userId, target.id])
  res.status(201).json({ status: 'pending', name: target.display_name })
}))

router.post('/:id/accept', wrap(async (req, res) => {
  const other = uuid(req.params.id)
  const r = await q(
    `UPDATE friendships SET status = 'accepted' WHERE requester_id = $1 AND addressee_id = $2 AND status = 'pending'`,
    [other, req.userId],
  )
  if (r.rowCount === 0) throw new HttpError(404, 'That request no longer exists')
  realtime.friendsChanged([req.userId, other])
  res.json({ ok: true })
}))

/** Decline a request, cancel one you sent, or remove a friend. */
router.delete('/:id', wrap(async (req, res) => {
  const other = uuid(req.params.id)
  await q(
    `DELETE FROM friendships WHERE (requester_id = $1 AND addressee_id = $2) OR (requester_id = $2 AND addressee_id = $1)`,
    [req.userId, other],
  )
  realtime.friendsChanged([req.userId, other])
  res.json({ ok: true })
}))

export default router
