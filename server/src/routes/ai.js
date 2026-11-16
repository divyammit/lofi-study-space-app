import { Router } from 'express'
import express from 'express'
import { ms, q } from '../db.js'
import { HttpError, str, wrap } from '../util.js'
import { requireAuth } from '../auth.js'
import { aiConfig, AiError, streamChat } from '../ai.js'
import { LIMITS, TIMEZONE, planOf } from '../plans.js'

const router = Router()
router.use(requireAuth)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IMAGE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/
const MAX_IMAGE = 2_000_000
const MAX_NOTE_CHARS = 12_000
const HISTORY = 20
const TODAY = `(now() AT TIME ZONE '${TIMEZONE.replace(/'/g, '')}')::date`

function tutorPrompt({ name, subject }) {
  const today = new Date().toLocaleDateString('en-IN', { dateStyle: 'long', timeZone: TIMEZONE })
  return `You are Lofi Tutor, a friendly study tutor inside Lo-Fi Study Space, a cozy study app used mostly by students in India (college courses and exams like JEE, NEET, GATE and CAT). Today is ${today}. You are talking with ${name || 'a student'}${subject && subject !== 'General' ? `, whose favourite subject is ${subject}` : ''}.

Your goal is to help the student understand, not just to hand over answers.
- Explain step by step, starting from what the student probably already knows. Use small, concrete, real-life examples.
- For a problem to solve, show the method and the reasoning behind each step. If it looks like homework or a test question, teach the method and let the student try the final step first, then offer to check their answer.
- When it helps, end with one short question that checks understanding, or offer a quick practice problem.
- Keep answers focused: usually under 250 words. Go longer only when the student asks for detail or the topic truly needs it.
- Format with Markdown: short paragraphs, bullet or numbered lists, **bold** for key terms, fenced code blocks with a language name for code, and LaTeX for maths ($...$ inline, $$...$$ on its own line).
- If the student attached a photo or their whiteboard, read it carefully and refer to what you see. If it's unclear or cut off, say so and ask for a clearer picture.
- If the student attached one of their notes, use it as the main source, quote it where useful, and point out anything in it that looks wrong.
- Reply in the language the student writes in (English, Hindi or Hinglish).
- If you are not sure about a fact, formula or date, say so instead of guessing.
- Stay on studying and learning. For unrelated requests, help briefly if harmless, then steer back to studies. Keep everything appropriate for school students.
- You are an AI, not a human teacher. For anything about health, safety or personal crises, encourage the student to talk to a trusted adult or a professional.`
}

async function usageToday(userId) {
  const r = await q(`SELECT questions FROM ai_usage WHERE user_id = $1 AND day = ${TODAY}`, [userId])
  return r.rows[0]?.questions ?? 0
}

async function status(userId) {
  const cfg = aiConfig()
  const plan = await planOf(userId)
  const limits = plan.pro ? LIMITS.pro : LIMITS.free
  return {
    configured: cfg.configured,
    provider: cfg.configured ? cfg.label : null,
    model: cfg.configured ? cfg.model : null,
    plan,
    usage: { used: await usageToday(userId), limit: limits.dailyQuestions },
    attachments: limits.attachments,
    freeLimit: LIMITS.free.dailyQuestions,
    proLimit: LIMITS.pro.dailyQuestions,
  }
}

router.get('/status', wrap(async (req, res) => res.json(await status(req.userId))))

router.get('/conversations', wrap(async (req, res) => {
  const r = await q(
    `SELECT c.id, c.title, ${ms('c.updated_at')} AS "updatedAt",
            (SELECT count(*)::int FROM ai_messages m WHERE m.conversation_id = c.id) AS messages
     FROM ai_conversations c WHERE c.user_id = $1 ORDER BY c.updated_at DESC LIMIT 100`,
    [req.userId],
  )
  res.json({ conversations: r.rows })
}))

async function ownConversation(id, userId) {
  if (!UUID.test(id)) throw new HttpError(400, 'Invalid conversation')
  const r = await q(`SELECT id, title FROM ai_conversations WHERE id = $1 AND user_id = $2`, [id, userId])
  if (!r.rows[0]) throw new HttpError(404, 'Conversation not found')
  return r.rows[0]
}

const MSG_COLS = `id, role, content, attachment_kind AS "attachmentKind", attachment, ${ms('created_at')} AS "createdAt"`

router.get('/conversations/:id', wrap(async (req, res) => {
  const conv = await ownConversation(req.params.id, req.userId)
  const r = await q(`SELECT ${MSG_COLS} FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at`, [conv.id])
  res.json({ conversation: conv, messages: r.rows })
}))

router.delete('/conversations/:id', wrap(async (req, res) => {
  const conv = await ownConversation(req.params.id, req.userId)
  await q(`DELETE FROM ai_conversations WHERE id = $1`, [conv.id])
  res.json({ ok: true })
}))

/** Builds what the model sees: recent turns, the latest image only, and the note text where attached. */
async function buildHistory(conversationId, userId) {
  const r = await q(
    `SELECT * FROM (
       SELECT role, content, attachment_kind, attachment, note_id, created_at FROM ai_messages
       WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT ${HISTORY}
     ) t ORDER BY created_at`,
    [conversationId],
  )
  const rows = r.rows
  while (rows.length && rows[0].role !== 'user') rows.shift() // must start with the student
  const lastImage = rows.map(m => m.attachment_kind === 'image' || m.attachment_kind === 'whiteboard').lastIndexOf(true)
  const lastNote = rows.map(m => m.attachment_kind === 'note').lastIndexOf(true)
  const out = []
  for (let i = 0; i < rows.length; i++) {
    const m = rows[i]
    let text = m.content
    let image
    if (m.attachment_kind === 'image' || m.attachment_kind === 'whiteboard') {
      const what = m.attachment_kind === 'whiteboard' ? 'a snapshot of their whiteboard' : 'a photo'
      const match = i === lastImage ? IMAGE.exec(m.attachment) : null
      if (match) {
        image = { mime: match[1], data: match[2] }
        text = `[The student attached ${what}.]\n\n${text}`
      } else {
        text = `[Earlier the student attached ${what}; it is no longer shown.]\n\n${text}`
      }
    }
    if (m.attachment_kind === 'note') {
      let body = null
      if (i === lastNote && m.note_id) {
        const n = await q(`SELECT title, subject, body FROM notes WHERE id = $1 AND user_id = $2`, [m.note_id, userId])
        if (n.rows[0]) body = `Title: ${n.rows[0].title || 'Untitled'}\nSubject: ${n.rows[0].subject}\n\n${n.rows[0].body.slice(0, MAX_NOTE_CHARS)}`
      }
      text = body
        ? `[The student attached their note:]\n<note>\n${body}\n</note>\n\n${text}`
        : `[Earlier the student attached their note "${m.attachment}".]\n\n${text}`
    }
    // merge consecutive messages from the same side (e.g. after a failed answer)
    const prev = out[out.length - 1]
    if (prev && prev.role === m.role && !image && !prev.image) prev.text += `\n\n${text}`
    else out.push({ role: m.role, text, image })
  }
  return out
}

// questions can include an image, so this route takes a larger body
router.post('/ask', express.json({ limit: '3mb' }), async (req, res, next) => {
  const userId = req.userId
  let counted = false
  try {
    const cfg = aiConfig()
    if (!cfg.configured) throw new HttpError(503, 'The AI tutor is not set up on this server yet. The site owner needs to add an AI API key (see DEPLOY.md).')
    const text = str(req.body.text, { min: 1, max: 4000, field: 'Question' })
    const plan = await planOf(userId)
    const limits = plan.pro ? LIMITS.pro : LIMITS.free

    // ---- attachment (Pro only) ----
    const att = req.body.attachment
    let attachment = null
    if (att) {
      if (!limits.attachments) {
        return res.status(402).json({ error: 'Attaching photos, your whiteboard or notes is a Pro feature.', code: 'pro_required' })
      }
      if (att.kind === 'image' || att.kind === 'whiteboard') {
        if (typeof att.data !== 'string' || !IMAGE.test(att.data)) throw new HttpError(400, 'Images must be PNG, JPEG, WebP or GIF')
        if (att.data.length > MAX_IMAGE) throw new HttpError(413, 'That image is too large (about 1.5 MB max)')
        attachment = { kind: att.kind, value: att.data, noteId: null }
      } else if (att.kind === 'note') {
        const n = await q(`SELECT id, title FROM notes WHERE id = $1 AND user_id = $2`, [String(att.noteId ?? ''), userId])
        if (!n.rows[0]) throw new HttpError(404, 'That note was not found')
        attachment = { kind: 'note', value: n.rows[0].title || 'Untitled note', noteId: n.rows[0].id }
      } else {
        throw new HttpError(400, 'Unknown attachment')
      }
    }

    // ---- daily limit: count the question atomically, only if under the limit ----
    const counter = await q(
      `INSERT INTO ai_usage (user_id, day, questions) VALUES ($1, ${TODAY}, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET questions = ai_usage.questions + 1
       WHERE ai_usage.questions < $2
       RETURNING questions`,
      [userId, limits.dailyQuestions],
    )
    if (!counter.rows[0]) {
      return res.status(429).json({
        error: plan.pro
          ? `You've reached today's fair-use limit of ${limits.dailyQuestions} questions. It resets at midnight.`
          : `You've used all ${limits.dailyQuestions} free questions for today. Upgrade to Pro for ${LIMITS.pro.dailyQuestions} a day, or come back tomorrow.`,
        code: plan.pro ? 'limit' : 'free_limit',
      })
    }
    counted = true
    const used = counter.rows[0].questions

    // ---- conversation ----
    let conversationId = req.body.conversationId
    let created = false
    if (conversationId) {
      await ownConversation(conversationId, userId)
    } else {
      const title = text.split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 60) || 'New question'
      conversationId = (await q(`INSERT INTO ai_conversations (user_id, title) VALUES ($1, $2) RETURNING id`, [userId, title])).rows[0].id
      created = true
    }
    const userMsg = (await q(
      `INSERT INTO ai_messages (conversation_id, role, content, attachment_kind, attachment, note_id)
       VALUES ($1, 'user', $2, $3, $4, $5) RETURNING ${MSG_COLS}`,
      [conversationId, text, attachment?.kind ?? null, attachment?.value ?? null, attachment?.noteId ?? null],
    )).rows[0]

    const profile = (await q(`SELECT display_name, fav_subject FROM users WHERE id = $1`, [userId])).rows[0]
    const history = await buildHistory(conversationId, userId)

    // ---- stream the answer back as Server-Sent Events ----
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', // ask proxies not to buffer the stream
      Connection: 'keep-alive',
    })
    res.flushHeaders()
    const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
    send('meta', { conversationId, created, userMessage: userMsg, usage: { used, limit: limits.dailyQuestions } })

    const controller = new AbortController()
    res.on('close', () => { if (!res.writableEnded) controller.abort() }) // student pressed Stop or left
    const ping = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n') }, 15000)

    let partial = ''
    let result = null
    let failure = null
    try {
      result = await streamChat({
        system: tutorPrompt({ name: profile?.display_name, subject: profile?.fav_subject }),
        messages: history,
        maxTokens: plan.pro ? 1600 : 1000,
        signal: controller.signal,
        onText: t => { partial += t; send('delta', { t }) },
      })
    } catch (e) {
      failure = e
    } finally {
      clearInterval(ping)
    }

    const aborted = controller.signal.aborted
    const answer = (result?.text ?? partial).trim()
    if (!answer) {
      // nothing came back: give the question back to the student and tidy up
      await q(`UPDATE ai_usage SET questions = greatest(questions - 1, 0) WHERE user_id = $1 AND day = ${TODAY}`, [userId])
      counted = false
      await q(`DELETE FROM ai_messages WHERE id = $1`, [userMsg.id])
      if (created) await q(`DELETE FROM ai_conversations WHERE id = $1`, [conversationId])
      if (!aborted) {
        const msg = failure instanceof AiError ? failure.message : failure ? "Couldn't get an answer. Please try again." : 'The AI returned an empty answer. Try rephrasing.'
        send('error', { error: msg, retryable: failure instanceof AiError ? failure.retryable : true, usage: { used: used - 1, limit: limits.dailyQuestions }, removed: { userMessageId: userMsg.id, conversationId: created ? conversationId : null } })
      }
      return res.end()
    }
    const content = failure || aborted ? `${answer}\n\n*(answer stopped early)*` : answer
    const saved = (await q(
      `INSERT INTO ai_messages (conversation_id, role, content, tokens_in, tokens_out)
       VALUES ($1, 'assistant', $2, $3, $4) RETURNING ${MSG_COLS}`,
      [conversationId, content, result?.tokensIn ?? null, result?.tokensOut ?? null],
    )).rows[0]
    await q(`UPDATE ai_conversations SET updated_at = now() WHERE id = $1`, [conversationId])
    if (failure && !aborted) console.error('[ai] answer interrupted:', failure.message)
    send('done', { message: saved, usage: { used, limit: limits.dailyQuestions } })
    res.end()
  } catch (e) {
    if (counted) {
      await q(`UPDATE ai_usage SET questions = greatest(questions - 1, 0) WHERE user_id = $1 AND day = ${TODAY}`, [userId]).catch(() => {})
    }
    if (res.headersSent) {
      console.error('[ai]', e)
      if (!res.writableEnded) { res.write(`event: error\ndata: ${JSON.stringify({ error: 'Something went wrong. Please try again.' })}\n\n`); res.end() }
      return
    }
    next(e)
  }
})

export default router
