import { Router } from 'express'
import { q } from '../db.js'
import { clientId, str, time, wrap } from '../util.js'
import { requireAuth } from '../auth.js'

const router = Router()
router.use(requireAuth)

router.put('/:id', wrap(async (req, res) => {
  const id = clientId(req.params.id)
  const b = req.body
  const title = str(b.title, { max: 200, field: 'Title' })
  const subject = str(b.subject, { max: 60, field: 'Subject', fallback: 'General' })
  const body = typeof b.body === 'string' ? b.body : ''
  if (body.length > 100_000) return res.status(400).json({ error: 'Note is too long (100,000 characters max)' })
  const updatedAt = time(b.updatedAt, 'updatedAt') ?? Date.now()
  const r = await q(
    `INSERT INTO notes (id, user_id, title, subject, body, updated_at)
     VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, subject = EXCLUDED.subject, body = EXCLUDED.body, updated_at = EXCLUDED.updated_at
     WHERE notes.user_id = EXCLUDED.user_id`,
    [id, req.userId, title, subject, body, updatedAt],
  )
  if (r.rowCount === 0) return res.status(409).json({ error: 'Id already in use' })
  res.json({ ok: true })
}))

router.delete('/:id', wrap(async (req, res) => {
  await q(`DELETE FROM notes WHERE id = $1 AND user_id = $2`, [clientId(req.params.id), req.userId])
  res.json({ ok: true })
}))

export default router
