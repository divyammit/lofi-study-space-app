import { Router } from 'express'
import express from 'express'
import { ms, pool, q } from '../db.js'
import { HttpError, str, wrap } from '../util.js'
import { requireAuth } from '../auth.js'
import { realtime } from '../realtime.js'

const router = Router()
router.use(requireAuth)

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = (v, what = 'id') => { if (typeof v !== 'string' || !UUID.test(v)) throw new HttpError(400, `Invalid ${what}`); return v }
const MAX_GROUP = 32
const MAX_IMAGE = 2_000_000 // characters of data URL (~1.5 MB image)

const MSG_COLS = `m.id, m.chat_id AS "chatId", m.user_id AS "userId", m.kind, m.body, ${ms('m.created_at')} AS "createdAt"`

/** Which of `ids` are accepted friends of `userId`. */
async function friendsAmong(userId, ids) {
  if (!ids.length) return new Set()
  const r = await q(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id
     FROM friendships
     WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)
       AND (requester_id = ANY($2::uuid[]) OR addressee_id = ANY($2::uuid[]))`,
    [userId, ids],
  )
  return new Set(r.rows.map(x => x.id))
}

/** Loads the membership row, or throws 404 so non-members can't even tell a chat exists. */
async function membership(chatId, userId) {
  const r = await q(
    `SELECT c.id, c.name, c.is_direct, cm.role FROM chats c
     JOIN chat_members cm ON cm.chat_id = c.id AND cm.user_id = $2
     WHERE c.id = $1`,
    [chatId, userId],
  )
  if (!r.rows[0]) throw new HttpError(404, 'Chat not found')
  return r.rows[0]
}

async function systemMessage(chatId, text) {
  const r = await q(
    `INSERT INTO messages (chat_id, kind, body) VALUES ($1, 'system', $2)
     RETURNING id, chat_id AS "chatId", user_id AS "userId", kind, body, ${ms('created_at')} AS "createdAt"`,
    [chatId, text],
  )
  realtime.emitToChat(chatId, 'chat:message', r.rows[0])
  return r.rows[0]
}

async function displayName(userId) {
  const r = await q(`SELECT display_name FROM users WHERE id = $1`, [userId])
  return r.rows[0]?.display_name ?? 'Someone'
}

/** All chats I belong to, newest activity first, with members, last message and unread count. */
export async function listChats(userId, onlyChatId = null) {
  const r = await q(
    `SELECT c.id, c.name, c.is_direct AS "isDirect", ${ms('c.created_at')} AS "createdAt", ${ms('cm.last_read_at')} AS "lastReadAt",
            (SELECT count(*)::int FROM messages x
              WHERE x.chat_id = c.id AND x.created_at > cm.last_read_at AND x.user_id IS DISTINCT FROM $1 AND x.kind <> 'system') AS unread,
            lm.id AS lm_id, lm.kind AS lm_kind, lm.user_id AS lm_user,
            CASE WHEN lm.kind = 'image' THEN '' ELSE left(lm.body, 140) END AS lm_body,
            ${ms('lm.created_at')} AS lm_at
     FROM chat_members cm
     JOIN chats c ON c.id = cm.chat_id
     LEFT JOIN LATERAL (
       SELECT id, kind, user_id, body, created_at FROM messages WHERE chat_id = c.id ORDER BY created_at DESC LIMIT 1
     ) lm ON true
     WHERE cm.user_id = $1 AND ($2::uuid IS NULL OR c.id = $2)
     ORDER BY coalesce(lm.created_at, c.created_at) DESC`,
    [userId, onlyChatId],
  )
  const ids = r.rows.map(x => x.id)
  const members = ids.length
    ? (await q(
        `SELECT cm.chat_id, u.id, u.username, u.display_name AS name, u.avatar, cm.role
         FROM chat_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.chat_id = ANY($1::uuid[]) ORDER BY cm.joined_at`,
        [ids],
      )).rows
    : []
  return r.rows.map(c => ({
    id: c.id,
    name: c.name,
    isDirect: c.isDirect,
    createdAt: c.createdAt,
    lastReadAt: c.lastReadAt,
    unread: c.unread,
    members: members.filter(m => m.chat_id === c.id).map(({ chat_id: _chatId, ...m }) => m),
    lastMessage: c.lm_id ? { id: c.lm_id, kind: c.lm_kind, userId: c.lm_user, body: c.lm_body, createdAt: c.lm_at } : null,
    call: realtime.callSummary(`chat:${c.id}`),
  }))
}

router.get('/', wrap(async (req, res) => {
  res.json({ chats: await listChats(req.userId) })
}))

/** Create a group with some of my friends. */
router.post('/', wrap(async (req, res) => {
  const name = str(req.body.name, { min: 1, max: 60, field: 'Group name' })
  const wanted = [...new Set((Array.isArray(req.body.memberIds) ? req.body.memberIds : []).map(v => uuid(v, 'member')))].filter(id => id !== req.userId)
  if (wanted.length === 0) throw new HttpError(400, 'Pick at least one friend for the group')
  if (wanted.length + 1 > MAX_GROUP) throw new HttpError(400, `Groups can have up to ${MAX_GROUP} people`)
  const friends = await friendsAmong(req.userId, wanted)
  if (friends.size !== wanted.length) throw new HttpError(403, 'You can only add your friends to a group')

  const client = await pool.connect()
  let chatId
  try {
    await client.query('BEGIN')
    chatId = (await client.query(`INSERT INTO chats (name, created_by) VALUES ($1, $2) RETURNING id`, [name, req.userId])).rows[0].id
    await client.query(
      `INSERT INTO chat_members (chat_id, user_id, role)
       SELECT $1, u, CASE WHEN u = $2 THEN 'admin' ELSE 'member' END FROM unnest($3::uuid[]) AS u`,
      [chatId, req.userId, [req.userId, ...wanted]],
    )
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
  realtime.joinChat(chatId, [req.userId, ...wanted])
  await systemMessage(chatId, `${await displayName(req.userId)} created the group "${name}"`)
  realtime.emitToChat(chatId, 'chat:updated', { chatId })
  res.status(201).json({ chat: (await listChats(req.userId, chatId))[0] })
}))

/** Open (or create) the direct chat with a friend. */
router.post('/direct', wrap(async (req, res) => {
  const other = uuid(req.body.userId, 'user')
  if (other === req.userId) throw new HttpError(400, "You can't message yourself")
  if (!(await friendsAmong(req.userId, [other])).has(other)) throw new HttpError(403, 'You can only message friends')
  const key = [req.userId, other].sort().join(':')
  let chatId = (await q(`SELECT id FROM chats WHERE direct_key = $1`, [key])).rows[0]?.id
  if (!chatId) {
    // ON CONFLICT handles two people opening the chat at the same moment
    const ins = await q(
      `INSERT INTO chats (is_direct, direct_key, created_by) VALUES (true, $1, $2)
       ON CONFLICT (direct_key) DO UPDATE SET direct_key = EXCLUDED.direct_key RETURNING id`,
      [key, req.userId],
    )
    chatId = ins.rows[0].id
    await q(
      `INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
      [chatId, req.userId, other],
    )
    realtime.joinChat(chatId, [req.userId, other])
  }
  res.json({ chat: (await listChats(req.userId, chatId))[0] })
}))

/** Message history, newest page first. ?before=<epoch ms> loads older messages. */
router.get('/:id/messages', wrap(async (req, res) => {
  const chatId = uuid(req.params.id, 'chat')
  await membership(chatId, req.userId)
  const before = Number(req.query.before) || null
  const limit = Math.min(Number(req.query.limit) || 40, 100)
  const r = await q(
    `SELECT ${MSG_COLS} FROM messages m
     WHERE m.chat_id = $1 AND ($2::float8 IS NULL OR m.created_at < to_timestamp($2 / 1000.0))
     ORDER BY m.created_at DESC LIMIT $3`,
    [chatId, before, limit + 1],
  )
  const rows = r.rows.slice(0, limit).reverse()
  res.json({ messages: rows, hasMore: r.rows.length > limit })
}))

// images arrive as data URLs, so this route takes a larger body
router.post('/:id/messages', express.json({ limit: '3mb' }), wrap(async (req, res) => {
  const chatId = uuid(req.params.id, 'chat')
  const chat = await membership(chatId, req.userId)
  const kind = req.body.kind === 'image' ? 'image' : 'text'
  let body
  if (kind === 'image') {
    body = req.body.body
    if (typeof body !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(body)) throw new HttpError(400, 'Images must be PNG, JPEG, WebP or GIF')
    if (body.length > MAX_IMAGE) throw new HttpError(413, 'That image is too large (about 1.5 MB max)')
  } else {
    body = str(req.body.body, { min: 1, max: 4000, field: 'Message' })
  }
  if (chat.is_direct) {
    // direct chats only work while you're still friends
    const other = (await q(`SELECT user_id FROM chat_members WHERE chat_id = $1 AND user_id <> $2`, [chatId, req.userId])).rows[0]?.user_id
    if (!other || !(await friendsAmong(req.userId, [other])).has(other)) throw new HttpError(403, 'You can only message friends')
  }
  const r = await q(
    `INSERT INTO messages (chat_id, user_id, kind, body) VALUES ($1, $2, $3, $4)
     RETURNING id, chat_id AS "chatId", user_id AS "userId", kind, body, ${ms('created_at')} AS "createdAt"`,
    [chatId, req.userId, kind, body],
  )
  await q(`UPDATE chat_members SET last_read_at = now() WHERE chat_id = $1 AND user_id = $2`, [chatId, req.userId])
  const msg = r.rows[0]
  realtime.emitToChat(chatId, 'chat:message', msg)
  res.status(201).json({ message: msg })
}))

router.post('/:id/read', wrap(async (req, res) => {
  const chatId = uuid(req.params.id, 'chat')
  await q(`UPDATE chat_members SET last_read_at = now() WHERE chat_id = $1 AND user_id = $2`, [chatId, req.userId])
  res.json({ ok: true })
}))

/** Rename a group (admins only). */
router.patch('/:id', wrap(async (req, res) => {
  const chatId = uuid(req.params.id, 'chat')
  const chat = await membership(chatId, req.userId)
  if (chat.is_direct) throw new HttpError(400, "Direct chats can't be renamed")
  if (chat.role !== 'admin') throw new HttpError(403, 'Only group admins can rename the group')
  const name = str(req.body.name, { min: 1, max: 60, field: 'Group name' })
  await q(`UPDATE chats SET name = $2 WHERE id = $1`, [chatId, name])
  await systemMessage(chatId, `${await displayName(req.userId)} renamed the group to "${name}"`)
  realtime.emitToChat(chatId, 'chat:updated', { chatId })
  res.json({ ok: true })
}))

/** Add friends to a group (admins only). */
router.post('/:id/members', wrap(async (req, res) => {
  const chatId = uuid(req.params.id, 'chat')
  const chat = await membership(chatId, req.userId)
  if (chat.is_direct) throw new HttpError(400, 'Start a group to chat with more people')
  if (chat.role !== 'admin') throw new HttpError(403, 'Only group admins can add people')
  const wanted = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(v => uuid(v, 'user')))]
  if (!wanted.length) throw new HttpError(400, 'Pick someone to add')
  const friends = await friendsAmong(req.userId, wanted)
  if (friends.size !== wanted.length) throw new HttpError(403, 'You can only add your friends')
  const count = (await q(`SELECT count(*)::int AS n FROM chat_members WHERE chat_id = $1`, [chatId])).rows[0].n
  if (count + wanted.length > MAX_GROUP) throw new HttpError(400, `Groups can have up to ${MAX_GROUP} people`)
  const added = await q(
    `INSERT INTO chat_members (chat_id, user_id) SELECT $1, u FROM unnest($2::uuid[]) AS u
     ON CONFLICT DO NOTHING RETURNING user_id`,
    [chatId, wanted],
  )
  const addedIds = added.rows.map(x => x.user_id)
  if (addedIds.length) {
    realtime.joinChat(chatId, addedIds)
    const names = (await q(`SELECT display_name FROM users WHERE id = ANY($1::uuid[])`, [addedIds])).rows.map(x => x.display_name)
    await systemMessage(chatId, `${await displayName(req.userId)} added ${names.join(', ')}`)
    realtime.emitToChat(chatId, 'chat:updated', { chatId })
  }
  res.json({ ok: true })
}))

/** Leave a group (yourself) or remove someone (admins). The last person out deletes the group. */
router.delete('/:id/members/:userId', wrap(async (req, res) => {
  const chatId = uuid(req.params.id, 'chat')
  const target = uuid(req.params.userId, 'user')
  const chat = await membership(chatId, req.userId)
  if (chat.is_direct) throw new HttpError(400, "You can't leave a direct chat")
  const self = target === req.userId
  if (!self && chat.role !== 'admin') throw new HttpError(403, 'Only group admins can remove people')

  const del = await q(`DELETE FROM chat_members WHERE chat_id = $1 AND user_id = $2 RETURNING user_id`, [chatId, target])
  if (!del.rowCount) throw new HttpError(404, 'That person is not in the group')
  realtime.leaveChat(chatId, [target])
  realtime.emitToUser(target, 'chat:removed', { chatId })

  const left = await q(`SELECT user_id, role FROM chat_members WHERE chat_id = $1 ORDER BY joined_at`, [chatId])
  if (left.rowCount === 0) {
    await q(`DELETE FROM chats WHERE id = $1`, [chatId])
    return res.json({ ok: true })
  }
  if (!left.rows.some(x => x.role === 'admin')) {
    // never leave a group without an admin
    await q(`UPDATE chat_members SET role = 'admin' WHERE chat_id = $1 AND user_id = $2`, [chatId, left.rows[0].user_id])
  }
  const name = await displayName(target)
  await systemMessage(chatId, self ? `${name} left the group` : `${await displayName(req.userId)} removed ${name}`)
  realtime.emitToChat(chatId, 'chat:updated', { chatId })
  res.json({ ok: true })
}))

export default router
