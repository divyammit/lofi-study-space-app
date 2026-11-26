import { Router } from 'express'
import express from 'express'
import rateLimit from 'express-rate-limit'
import { ms, q } from '../db.js'
import { HttpError, str, wrap } from '../util.js'
import { requireAuth } from '../auth.js'
import { aiConfig, AiError, streamChat } from '../ai.js'
import { LIMITS, TIMEZONE, planOf } from '../plans.js'
import { realtime } from '../realtime.js'
import { isAdmin } from './billing.js'

/**
 * Doubt board: a public question & answer board for everyone on the site.
 * Scores and answer counts are kept up to date by database triggers (see schema.sql),
 * and search uses PostgreSQL full-text search over title, subject and body.
 */
const router = Router()
router.use(requireAuth)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/
const MAX_IMAGE = 2_000_000
const PAGE = 20
const TODAY = `(now() AT TIME ZONE '${TIMEZONE.replace(/'/g, '')}')::date`
const bigJson = express.json({ limit: '3mb' })

const perUser = (limit, what) => rateLimit({
  windowMs: 60 * 60 * 1000, limit, standardHeaders: 'draft-7', legacyHeaders: false,
  keyGenerator: req => req.userId,
  validate: { keyGeneratorIpFallback: false },
  message: { error: `You've posted a lot of ${what} this hour. Take a breather and try again later.` },
})
const askLimit = perUser(10, 'doubts')
const answerLimit = perUser(40, 'answers')

const id = v => { if (!UUID.test(String(v))) throw new HttpError(404, 'Doubt not found'); return String(v) }
const image = v => {
  if (v == null || v === '') return null
  if (typeof v !== 'string' || !IMAGE.test(v)) throw new HttpError(400, 'Images must be PNG, JPEG, WebP or GIF')
  if (v.length > MAX_IMAGE) throw new HttpError(413, 'That image is too large (about 1.5 MB max)')
  return v
}
const author = alias => `json_build_object('id', ${alias}.id, 'name', ${alias}.display_name, 'username', ${alias}.username, 'avatar', ${alias}.avatar)`

// ---------- list & search ----------
router.get('/', wrap(async (req, res) => {
  const me = req.userId
  const params = [me]
  const p = v => { params.push(v); return `$${params.length}` }
  const where = []
  const text = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : ''
  let tsq = null
  if (text) {
    tsq = `websearch_to_tsquery('english', ${p(text)})`
    // full-text match, or a plain "contains" match on the title so half-typed words still find things
    where.push(`(d.search @@ ${tsq} OR d.title ILIKE ${p(`%${text.replace(/[\\%_]/g, c => '\\' + c)}%`)})`)
  }
  const subject = typeof req.query.subject === 'string' ? req.query.subject.trim().slice(0, 60) : ''
  if (subject) where.push(`lower(d.subject) = lower(${p(subject)})`)
  const filter = String(req.query.filter || 'all')
  if (filter === 'unanswered') where.push('d.answer_count = 0')
  if (filter === 'solved') where.push('d.accepted_answer_id IS NOT NULL')
  if (filter === 'open') where.push('d.accepted_answer_id IS NULL')
  if (filter === 'mine') where.push('d.user_id = $1')
  const sort = String(req.query.sort || (text ? 'relevance' : 'new'))
  const order = {
    relevance: tsq ? `ts_rank(d.search, ${tsq}) DESC, d.created_at DESC` : 'd.created_at DESC',
    top: 'd.score DESC, d.answer_count DESC, d.created_at DESC',
    active: 'd.active_at DESC',
    new: 'd.created_at DESC',
  }[sort] ?? 'd.created_at DESC'
  const page = Math.max(0, Math.min(500, Number.parseInt(String(req.query.page ?? 0), 10) || 0))

  const r = await q(
    `SELECT d.id, d.title, d.subject,
            left(regexp_replace(d.body, '\\s+', ' ', 'g'), 180) AS excerpt,
            d.score, d.answer_count AS answers, d.accepted_answer_id IS NOT NULL AS solved,
            d.image IS NOT NULL AS "hasImage",
            EXISTS (SELECT 1 FROM doubt_answers a WHERE a.doubt_id = d.id AND a.is_ai) AS "hasAi",
            ${ms('d.created_at')} AS "createdAt", ${ms('d.active_at')} AS "activeAt",
            ${author('u')} AS author, coalesce(v.value, 0)::int AS "myVote", d.user_id = $1 AS mine
       FROM doubts d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN doubt_votes v ON v.doubt_id = d.id AND v.user_id = $1
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY ${order}
      LIMIT ${PAGE + 1} OFFSET ${page * PAGE}`,
    params,
  )
  res.json({ doubts: r.rows.slice(0, PAGE), hasMore: r.rows.length > PAGE })
}))

/** Subjects people have asked about, most common first (for the filter). */
router.get('/subjects', wrap(async (_req, res) => {
  const r = await q(
    `SELECT min(subject) AS subject, count(*)::int AS count,
            count(*) FILTER (WHERE accepted_answer_id IS NULL)::int AS open
       FROM doubts GROUP BY lower(subject) ORDER BY count(*) DESC, min(subject) LIMIT 30`,
  )
  res.json({ subjects: r.rows })
}))

// ---------- ask ----------
router.post('/', bigJson, askLimit, wrap(async (req, res) => {
  const title = str(req.body.title, { min: 5, max: 150, field: 'Title' }).replace(/\s+/g, ' ')
  const subject = str(req.body.subject, { max: 60, field: 'Subject', fallback: 'General' }) || 'General'
  const body = str(req.body.body, { max: 8000, field: 'Details', fallback: '' })
  const img = image(req.body.image)
  const r = await q(
    `INSERT INTO doubts (user_id, subject, title, body, image) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.userId, subject, title, body, img],
  )
  const who = (await q(`SELECT display_name FROM users WHERE id = $1`, [req.userId])).rows[0]
  realtime.broadcast('doubt:new', { id: r.rows[0].id, title, subject, by: who.display_name, byId: req.userId })
  res.status(201).json({ id: r.rows[0].id })
}))

// ---------- one doubt with its answers ----------
async function loadDoubt(doubtId, me) {
  const d = (await q(
    `SELECT d.id, d.title, d.subject, d.body, d.image, d.score, d.answer_count AS answers,
            d.accepted_answer_id AS "acceptedAnswerId",
            ${ms('d.created_at')} AS "createdAt", ${author('u')} AS author,
            coalesce(v.value, 0)::int AS "myVote", d.user_id = $2 AS mine
       FROM doubts d JOIN users u ON u.id = d.user_id
       LEFT JOIN doubt_votes v ON v.doubt_id = d.id AND v.user_id = $2
      WHERE d.id = $1`,
    [doubtId, me],
  )).rows[0]
  if (!d) throw new HttpError(404, 'This doubt was deleted or never existed')
  const answers = (await q(
    `SELECT a.id, a.body, a.image, a.is_ai AS "isAi", a.score, ${ms('a.created_at')} AS "createdAt",
            ${author('u')} AS author, coalesce(v.value, 0)::int AS "myVote", a.user_id = $2 AS mine
       FROM doubt_answers a JOIN users u ON u.id = a.user_id
       LEFT JOIN answer_votes v ON v.answer_id = a.id AND v.user_id = $2
      WHERE a.doubt_id = $1
      ORDER BY (a.id = $3) DESC, a.score DESC, a.created_at`,
    [doubtId, me, d.acceptedAnswerId ?? '00000000-0000-0000-0000-000000000000'],
  )).rows
  const admin = await isAdmin(me)
  d.canDelete = d.mine || admin
  for (const a of answers) a.canDelete = a.mine || admin
  return { doubt: d, answers, ai: { configured: aiConfig().configured, answered: answers.some(a => a.isAi) } }
}

router.get('/:id', wrap(async (req, res) => res.json(await loadDoubt(id(req.params.id), req.userId))))

router.delete('/:id', wrap(async (req, res) => {
  const doubtId = id(req.params.id)
  const r = await q(`SELECT user_id FROM doubts WHERE id = $1`, [doubtId])
  if (!r.rows[0]) throw new HttpError(404, 'Doubt not found')
  if (r.rows[0].user_id !== req.userId && !(await isAdmin(req.userId))) throw new HttpError(403, 'Only the person who asked can delete this')
  await q(`DELETE FROM doubts WHERE id = $1`, [doubtId])
  realtime.broadcast('doubt:deleted', { id: doubtId })
  res.json({ ok: true })
}))

// ---------- answers ----------
router.post('/:id/answers', bigJson, answerLimit, wrap(async (req, res) => {
  const doubtId = id(req.params.id)
  const body = str(req.body.body, { min: 1, max: 8000, field: 'Answer' })
  const img = image(req.body.image)
  const d = (await q(`SELECT user_id, title FROM doubts WHERE id = $1`, [doubtId])).rows[0]
  if (!d) throw new HttpError(404, 'This doubt was deleted')
  await q(`INSERT INTO doubt_answers (doubt_id, user_id, body, image) VALUES ($1, $2, $3, $4)`, [doubtId, req.userId, body, img])
  const out = await loadDoubt(doubtId, req.userId)
  realtime.broadcast('doubt:updated', { id: doubtId, answers: out.doubt.answers })
  if (d.user_id !== req.userId) {
    const who = (await q(`SELECT display_name FROM users WHERE id = $1`, [req.userId])).rows[0]
    realtime.emitToUser(d.user_id, 'doubt:answered', { id: doubtId, title: d.title, by: who.display_name })
  }
  res.status(201).json(out)
}))

router.delete('/answers/:aid', wrap(async (req, res) => {
  const aid = id(req.params.aid)
  const r = await q(`SELECT user_id, doubt_id FROM doubt_answers WHERE id = $1`, [aid])
  if (!r.rows[0]) throw new HttpError(404, 'Answer not found')
  if (r.rows[0].user_id !== req.userId && !(await isAdmin(req.userId))) throw new HttpError(403, 'You can only delete your own answers')
  await q(`DELETE FROM doubt_answers WHERE id = $1`, [aid])
  realtime.broadcast('doubt:updated', { id: r.rows[0].doubt_id })
  res.json(await loadDoubt(r.rows[0].doubt_id, req.userId))
}))

/** The asker marks the answer that solved it (or un-marks with answerId: null). */
router.post('/:id/accept', wrap(async (req, res) => {
  const doubtId = id(req.params.id)
  const answerId = req.body.answerId == null ? null : id(req.body.answerId)
  const d = (await q(`SELECT user_id FROM doubts WHERE id = $1`, [doubtId])).rows[0]
  if (!d) throw new HttpError(404, 'Doubt not found')
  if (d.user_id !== req.userId) throw new HttpError(403, 'Only the person who asked can mark it solved')
  if (answerId) {
    const a = await q(`SELECT 1 FROM doubt_answers WHERE id = $1 AND doubt_id = $2`, [answerId, doubtId])
    if (!a.rowCount) throw new HttpError(400, "That answer isn't on this doubt")
  }
  await q(`UPDATE doubts SET accepted_answer_id = $2 WHERE id = $1`, [doubtId, answerId])
  realtime.broadcast('doubt:updated', { id: doubtId })
  res.json(await loadDoubt(doubtId, req.userId))
}))

// ---------- votes ----------
async function vote(table, key, itemId, ownerSql, userId, value) {
  if (![1, -1, 0].includes(value)) throw new HttpError(400, 'Vote must be 1, -1 or 0')
  const owner = (await q(ownerSql, [itemId])).rows[0]
  if (!owner) throw new HttpError(404, 'Not found')
  if (owner.user_id === userId) throw new HttpError(400, "You can't vote on your own post")
  if (value === 0) await q(`DELETE FROM ${table} WHERE ${key} = $1 AND user_id = $2`, [itemId, userId])
  else await q(
    `INSERT INTO ${table} (${key}, user_id, value) VALUES ($1, $2, $3)
     ON CONFLICT (${key}, user_id) DO UPDATE SET value = EXCLUDED.value`,
    [itemId, userId, value],
  )
}
router.post('/:id/vote', wrap(async (req, res) => {
  const doubtId = id(req.params.id)
  await vote('doubt_votes', 'doubt_id', doubtId, `SELECT user_id FROM doubts WHERE id = $1`, req.userId, Number(req.body.value))
  const r = await q(`SELECT score FROM doubts WHERE id = $1`, [doubtId])
  res.json({ score: r.rows[0].score, myVote: Number(req.body.value) })
}))
router.post('/answers/:aid/vote', wrap(async (req, res) => {
  const aid = id(req.params.aid)
  await vote('answer_votes', 'answer_id', aid, `SELECT user_id FROM doubt_answers WHERE id = $1`, req.userId, Number(req.body.value))
  const r = await q(`SELECT score FROM doubt_answers WHERE id = $1`, [aid])
  res.json({ score: r.rows[0].score, myVote: Number(req.body.value) })
}))

// ---------- AI answer ----------
const AI_PROMPT = `You are Lofi Tutor, answering a doubt that a student posted on the public doubt board of Lo-Fi Study Space, a study app used mostly by college students in India. Other students will read your answer too.
- Answer the doubt directly and correctly, then explain step by step so a classmate could follow. Use small, concrete examples.
- Keep it focused: usually under 300 words.
- Format with Markdown: short paragraphs, lists, **bold** key terms, fenced code blocks with a language name, and LaTeX for maths ($...$ inline, $$...$$ on its own line).
- If the question is unclear or missing information, say what's missing and answer the most likely reading.
- If you are not sure about a fact or formula, say so plainly instead of guessing.
- Reply in the language the doubt is written in (English, Hindi or Hinglish).
- Keep everything appropriate for students. If the post isn't a study question, reply briefly and politely say the board is for study doubts.`

router.post('/:id/ai', wrap(async (req, res) => {
  const doubtId = id(req.params.id)
  const userId = req.userId
  if (!aiConfig().configured) throw new HttpError(503, 'The AI tutor is not set up on this server yet (see DEPLOY.md).')
  const d = (await q(`SELECT title, subject, body, image FROM doubts WHERE id = $1`, [doubtId])).rows[0]
  if (!d) throw new HttpError(404, 'This doubt was deleted')
  if ((await q(`SELECT 1 FROM doubt_answers WHERE doubt_id = $1 AND is_ai`, [doubtId])).rowCount) {
    throw new HttpError(409, 'The AI tutor already answered this doubt')
  }
  const plan = await planOf(userId)
  const limits = plan.pro ? LIMITS.pro : LIMITS.free
  // uses one question from the same daily allowance as the Study tutor
  const counter = await q(
    `INSERT INTO ai_usage (user_id, day, questions) VALUES ($1, ${TODAY}, 1)
     ON CONFLICT (user_id, day) DO UPDATE SET questions = ai_usage.questions + 1
     WHERE ai_usage.questions < $2 RETURNING questions`,
    [userId, limits.dailyQuestions],
  )
  if (!counter.rows[0]) {
    return res.status(429).json({
      error: plan.pro
        ? `You've reached today's limit of ${limits.dailyQuestions} AI questions. It resets at midnight.`
        : `You've used all ${limits.dailyQuestions} free AI questions for today. Pro gives you ${LIMITS.pro.dailyQuestions} a day.`,
      code: plan.pro ? 'limit' : 'free_limit',
    })
  }
  const refund = () => q(`UPDATE ai_usage SET questions = greatest(questions - 1, 0) WHERE user_id = $1 AND day = ${TODAY}`, [userId])

  // reading photos costs more, so the photo is only sent for Pro members (like tutor attachments)
  const match = d.image && limits.attachments ? IMAGE.exec(d.image) : null
  let text = `Subject: ${d.subject}\nDoubt: ${d.title}\n\n${d.body || '(no extra details)'}`
  if (d.image && !match) text = `[The student attached a photo that you can't see. If the doubt depends on it, say so.]\n\n${text}`
  if (match) text = `[The student attached a photo of the problem.]\n\n${text}`

  let answer = ''
  try {
    const result = await streamChat({
      system: AI_PROMPT,
      messages: [{ role: 'user', text, image: match ? { mime: match[1], data: match[2] } : undefined }],
      maxTokens: 1400,
      signal: AbortSignal.timeout(90_000),
      onText: () => {},
    })
    answer = (result?.text ?? '').trim()
  } catch (e) {
    await refund()
    if (e instanceof AiError) throw new HttpError(e.status && e.status < 500 ? e.status : 503, e.message)
    throw new HttpError(503, "Couldn't get an answer from the AI right now. Please try again.")
  }
  if (!answer) { await refund(); throw new HttpError(502, 'The AI returned an empty answer. Try again.') }

  try {
    await q(`INSERT INTO doubt_answers (doubt_id, user_id, is_ai, body) VALUES ($1, $2, true, $3)`, [doubtId, userId, answer.slice(0, 12000)])
  } catch (e) {
    await refund()
    // two people pressed the button at once (unique index), or the doubt was deleted meanwhile
    if (e.code === '23505') throw new HttpError(409, 'The AI tutor already answered this doubt')
    if (e.code === '23503') throw new HttpError(404, 'This doubt was deleted')
    throw e
  }
  realtime.broadcast('doubt:updated', { id: doubtId })
  res.json({ ...(await loadDoubt(doubtId, userId)), usage: { used: counter.rows[0].questions, limit: limits.dailyQuestions } })
}))

export default router
