import { Router } from 'express'
import { q } from '../db.js'
import { clientId, day, int, str, time, wrap } from '../util.js'
import { requireAuth } from '../auth.js'

const router = Router()
router.use(requireAuth)

// study sessions are written once when a focus block finishes
router.put('/:id', wrap(async (req, res) => {
  const id = clientId(req.params.id)
  const b = req.body
  const date = day(b.date, 'date', { required: true })
  const start = time(b.start, 'start', { required: true })
  const minutes = int(b.minutes, { min: 1, max: 600, field: 'minutes' })
  const subject = str(b.subject, { max: 60, field: 'Subject', fallback: 'General' })
  const r = await q(
    `INSERT INTO study_sessions (id, user_id, day, started_at, minutes, subject)
     VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6)
     ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject
     WHERE study_sessions.user_id = EXCLUDED.user_id`,
    [id, req.userId, date, start, minutes, subject],
  )
  if (r.rowCount === 0) return res.status(409).json({ error: 'Id already in use' })
  res.json({ ok: true })
}))

router.delete('/:id', wrap(async (req, res) => {
  await q(`DELETE FROM study_sessions WHERE id = $1 AND user_id = $2`, [clientId(req.params.id), req.userId])
  res.json({ ok: true })
}))

export default router
