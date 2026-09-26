import { Router } from 'express'
import { q } from '../db.js'
import { clientId, day, oneOf, str, time, wrap } from '../util.js'
import { requireAuth } from '../auth.js'

const router = Router()
router.use(requireAuth)

// PUT = create or replace (idempotent, so the client can safely retry)
router.put('/:id', wrap(async (req, res) => {
  const id = clientId(req.params.id)
  const b = req.body
  const title = str(b.title, { min: 1, max: 200, field: 'Title' })
  const priority = oneOf(b.priority, ['low', 'medium', 'high'], 'priority', 'medium')
  const status = oneOf(b.status, ['backlog', 'progress', 'done'], 'status', 'backlog')
  const deadline = day(b.deadline, 'deadline')
  const createdAt = time(b.createdAt, 'createdAt') ?? Date.now()
  const completedAt = status === 'done' ? (time(b.completedAt, 'completedAt') ?? Date.now()) : null
  const r = await q(
    `INSERT INTO tasks (id, user_id, title, priority, status, deadline, created_at, completed_at)
     VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0), to_timestamp($8 / 1000.0))
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title, priority = EXCLUDED.priority, status = EXCLUDED.status,
       deadline = EXCLUDED.deadline, completed_at = EXCLUDED.completed_at
     WHERE tasks.user_id = EXCLUDED.user_id`,
    [id, req.userId, title, priority, status, deadline, createdAt, completedAt],
  )
  if (r.rowCount === 0) return res.status(409).json({ error: 'Id already in use' })
  res.json({ ok: true })
}))

router.delete('/:id', wrap(async (req, res) => {
  await q(`DELETE FROM tasks WHERE id = $1 AND user_id = $2`, [clientId(req.params.id), req.userId])
  res.json({ ok: true })
}))

export default router
