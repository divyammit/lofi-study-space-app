import { Server } from 'socket.io'
import { q, ms } from './db.js'
import { userIdFromCookieHeader, userIdFromSocketToken } from './auth.js'

/**
 * Live state lives in memory (who is online, which room they're in, their timer).
 * Rooms and memberships are also written to Postgres so they have a durable record.
 * With one server instance this is all you need; to run several instances you'd add
 * the Socket.IO Redis adapter.
 */

let io = null
const socketsByUser = new Map()   // userId -> Set<Socket>
const users = new Map()           // userId -> { id, username, name, avatar }
const statusByUser = new Map()    // userId -> { mode, running, endsAt, remaining, total, subject }
const roomOfUser = new Map()      // userId -> roomId
const rooms = new Map()           // roomId -> { id, hostId, subject, startedAt, members: Set<userId> }
const calls = new Map()           // key ('chat:<id>' or 'room:<id>') -> { key, startedAt, video, participants: Map<socketId, P>, board }
const callOfSocket = new Map()    // socketId -> call key
const MAX_CALL = 8                // everyone connects to everyone (mesh), so keep calls small
const MAX_STROKES = 40000

const channel = roomId => `room:${roomId}`
const forEachSocket = (userId, fn) => socketsByUser.get(userId)?.forEach(fn)
const isOnline = userId => (socketsByUser.get(userId)?.size ?? 0) > 0

async function loadUser(userId) {
  const r = await q(`SELECT id, username, display_name AS name, avatar FROM users WHERE id = $1`, [userId])
  if (r.rows[0]) users.set(userId, r.rows[0])
  return r.rows[0] ?? null
}

async function friendIds(userId) {
  const r = await q(
    `SELECT CASE WHEN requester_id = $1 THEN addressee_id ELSE requester_id END AS id
     FROM friendships WHERE status = 'accepted' AND (requester_id = $1 OR addressee_id = $1)`,
    [userId],
  )
  return r.rows.map(x => x.id)
}

function presenceOf(userId) {
  const roomId = roomOfUser.get(userId) ?? null
  const room = roomId ? rooms.get(roomId) : null
  return {
    online: isOnline(userId),
    roomId,
    subject: room?.subject ?? statusByUser.get(userId)?.subject ?? null,
    studying: !!statusByUser.get(userId)?.running,
  }
}

async function pushPresence(userId) {
  const p = { userId, ...presenceOf(userId) }
  for (const fid of await friendIds(userId)) forEachSocket(fid, s => s.emit('presence', p))
}

function listRooms() {
  return [...rooms.values()]
    .sort((a, b) => b.members.size - a.members.size || a.startedAt - b.startedAt)
    .map(r => ({
      id: r.id,
      hostId: r.hostId,
      host: users.get(r.hostId)?.name ?? 'Someone',
      subject: r.subject,
      startedAt: r.startedAt,
      call: callSummary(`room:${r.id}`),
      members: [...r.members].map(uid => ({
        id: uid,
        name: users.get(uid)?.name ?? 'Someone',
        avatar: users.get(uid)?.avatar ?? 0,
        status: statusByUser.get(uid) ?? null,
      })),
    }))
}

// batch bursts of changes into one broadcast
let broadcastTimer = null
function broadcastRooms() {
  if (broadcastTimer) return
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null
    io?.emit('rooms', { rooms: listRooms(), serverTime: Date.now() })
  }, 50)
}

async function leaveRoom(userId) {
  const roomId = roomOfUser.get(userId)
  if (!roomId) return
  forEachSocket(userId, s => { if (callOfSocket.get(s.id) === `room:${roomId}`) leaveCall(s).catch(console.error) })
  roomOfUser.delete(userId)
  forEachSocket(userId, s => s.leave(channel(roomId)))
  await q(`DELETE FROM room_members WHERE user_id = $1`, [userId])
  const room = rooms.get(roomId)
  if (room) {
    room.members.delete(userId)
    if (room.members.size === 0) {
      rooms.delete(roomId)
      await q(`UPDATE study_rooms SET closed_at = now() WHERE id = $1`, [roomId])
    } else if (room.hostId === userId) {
      room.hostId = [...room.members][0] // hand the room to whoever is still there
      await q(`UPDATE study_rooms SET host_id = $2 WHERE id = $1`, [roomId, room.hostId])
    }
  }
  broadcastRooms()
  await pushPresence(userId)
}

async function joinRoom(userId, roomId) {
  const room = rooms.get(roomId)
  if (!room) throw new Error('That room has closed')
  if (roomOfUser.get(userId) === roomId) return room
  await leaveRoom(userId)
  await q(`INSERT INTO room_members (room_id, user_id) VALUES ($1, $2)`, [roomId, userId])
  room.members.add(userId)
  roomOfUser.set(userId, roomId)
  forEachSocket(userId, s => s.join(channel(roomId)))
  broadcastRooms()
  await pushPresence(userId)
  return room
}

async function createRoom(userId, subject) {
  await leaveRoom(userId)
  const r = await q(
    `INSERT INTO study_rooms (host_id, subject) VALUES ($1, $2) RETURNING id, ${ms('created_at')} AS started_at`,
    [userId, subject],
  )
  const { id, started_at } = r.rows[0]
  rooms.set(id, { id, hostId: userId, subject, startedAt: started_at, members: new Set() })
  await joinRoom(userId, id)
  return id
}

function cleanSubject(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : 'General'
}

function cleanStatus(s) {
  if (!s || typeof s !== 'object') return null
  const mode = ['focus', 'short', 'long'].includes(s.mode) ? s.mode : 'focus'
  const remaining = Math.max(0, Math.min(Number(s.remaining) || 0, 6 * 3600_000))
  const total = Math.max(1, Math.min(Number(s.total) || 1, 6 * 3600_000))
  const running = !!s.running
  // endsAt is stored in *server* time so every viewer can compute the same countdown
  return { mode, running, remaining, total, endsAt: running ? Date.now() + remaining : null, subject: cleanSubject(s.subject) }
}

// ---------- chats ----------
const chatChannel = chatId => `chat:${chatId}`
const callChannel = key => `call:${key}`
const CALL_KEY = /^(chat|room):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function systemMessage(chatId, text) {
  const r = await q(
    `INSERT INTO messages (chat_id, kind, body) VALUES ($1, 'system', $2)
     RETURNING id, chat_id AS "chatId", user_id AS "userId", kind, body, ${ms('created_at')} AS "createdAt"`,
    [chatId, text],
  )
  io?.to(chatChannel(chatId)).emit('chat:message', r.rows[0])
}

// ---------- calls ----------
function callSummary(key) {
  const call = calls.get(key)
  if (!call) return null
  return {
    startedAt: call.startedAt,
    video: call.video,
    board: !!call.board,
    participants: [...call.participants.values()].map(p => ({
      socketId: p.socketId,
      userId: p.userId,
      name: users.get(p.userId)?.name ?? 'Someone',
      avatar: users.get(p.userId)?.avatar ?? 0,
      audio: p.audio,
      video: p.video,
      screen: p.screen,
    })),
  }
}

function broadcastCall(key) {
  // the key is also the Socket.IO channel of everyone in that chat / study room
  io?.to(key).emit('call:state', { key, call: callSummary(key) })
  if (key.startsWith('room:')) broadcastRooms() // Study Street shows who's in a call
}

async function leaveCall(socket) {
  const key = callOfSocket.get(socket.id)
  if (!key) return
  callOfSocket.delete(socket.id)
  socket.leave(callChannel(key))
  const call = calls.get(key)
  if (!call) return
  call.participants.delete(socket.id)
  io.to(callChannel(key)).emit('call:peer-left', { socketId: socket.id })
  if (call.participants.size === 0) {
    calls.delete(key)
    if (key.startsWith('chat:')) {
      const mins = Math.max(1, Math.round((Date.now() - call.startedAt) / 60000))
      await systemMessage(key.slice(5), `Call ended · ${mins} min`).catch(console.error)
    }
  }
  broadcastCall(key)
}

const num = v => typeof v === 'number' && Number.isFinite(v)
function cleanStroke(s) {
  if (!s || !Array.isArray(s.p) || s.p.length !== 4 || !s.p.every(n => num(n) && n >= -0.1 && n <= 1.1)) return null
  const color = typeof s.c === 'string' && /^#[0-9a-f]{6}$/i.test(s.c) ? s.c : '#2e2940'
  const width = num(s.w) ? Math.min(Math.max(s.w, 1), 60) : 4
  return { p: s.p, c: color, w: width, e: !!s.e }
}

export const realtime = {
  async init(httpServer) {
    // rooms can't survive a restart (nobody is connected yet), so close any left open
    await q(`DELETE FROM room_members`)
    await q(`UPDATE study_rooms SET closed_at = now() WHERE closed_at IS NULL`)

    // CLIENT_ORIGIN lists frontend domains allowed to open a socket, e.g. https://lofi.vercel.app
    const origins = (process.env.CLIENT_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
    // 5 MB messages so a whiteboard background can be shared into a call
    io = new Server(httpServer, { cors: { origin: origins.length ? origins : false }, maxHttpBufferSize: 5e6 })

    io.use((socket, next) => {
      const userId = userIdFromSocketToken(socket.handshake.auth?.token) || userIdFromCookieHeader(socket.handshake.headers.cookie)
      if (!userId) return next(new Error('unauthorized'))
      socket.data.userId = userId
      next()
    })

    io.on('connection', async socket => {
      const userId = socket.data.userId
      const user = await loadUser(userId).catch(() => null)
      if (!user) { socket.emit('auth:expired'); socket.disconnect(true); return }

      const first = !isOnline(userId)
      if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set())
      socketsByUser.get(userId).add(socket)
      const roomId = roomOfUser.get(userId)
      if (roomId) socket.join(channel(roomId))

      // subscribe this socket to every chat the user is in
      try {
        const chats = await q(`SELECT chat_id FROM chat_members WHERE user_id = $1`, [userId])
        chats.rows.forEach(r => socket.join(chatChannel(r.chat_id)))
      } catch (e) { console.error(e) }

      socket.emit('hello', { serverTime: Date.now(), userId })
      socket.emit('rooms', { rooms: listRooms(), serverTime: Date.now() })
      if (first) pushPresence(userId).catch(console.error)

      // small helper so every handler replies { ok } or { error }
      const on = (event, handler) => socket.on(event, async (payload, ack) => {
        try {
          const result = await handler(payload ?? {})
          if (typeof ack === 'function') ack({ ok: true, ...result })
        } catch (e) {
          if (typeof ack === 'function') ack({ ok: false, error: e.message || 'Something went wrong' })
        }
      })

      on('room:create', async ({ subject }) => ({ roomId: await createRoom(userId, cleanSubject(subject)) }))
      on('room:join', async ({ roomId }) => { await joinRoom(userId, String(roomId)); return { roomId } })
      on('room:leave', async () => { await leaveRoom(userId) })

      on('status', async status => {
        const prev = statusByUser.get(userId)
        const next = cleanStatus(status)
        if (!next) return
        statusByUser.set(userId, next)
        if (roomOfUser.has(userId)) broadcastRooms()
        if (!prev || prev.subject !== next.subject || prev.running !== next.running) await pushPresence(userId)
      })

      on('invite', async ({ toUserId }) => {
        const roomId = roomOfUser.get(userId)
        if (!roomId) throw new Error('Open or join a room first')
        const friends = await friendIds(userId)
        if (!friends.includes(toUserId)) throw new Error('You can only invite friends')
        if (!isOnline(toUserId)) throw new Error(`${users.get(toUserId)?.name ?? 'They'} are offline right now`)
        const room = rooms.get(roomId)
        forEachSocket(toUserId, s => s.emit('invite', {
          from: { id: userId, name: users.get(userId)?.name, avatar: users.get(userId)?.avatar },
          roomId,
          subject: room?.subject,
        }))
      })

      // ----- chat -----
      socket.on('chat:typing', ({ chatId } = {}) => {
        if (typeof chatId !== 'string' || !socket.rooms.has(chatChannel(chatId))) return
        socket.to(chatChannel(chatId)).emit('chat:typing', { chatId, userId, name: users.get(userId)?.name })
      })

      // ----- calls (WebRTC signalling; audio/video flows directly between browsers) -----
      on('call:join', async ({ key, video }) => {
        if (typeof key !== 'string' || !CALL_KEY.test(key)) throw new Error('Unknown call')
        if (!socket.rooms.has(key)) throw new Error(key.startsWith('room:') ? 'Join the study room first' : "You're not in this chat")
        await leaveCall(socket)
        let call = calls.get(key)
        const isNew = !call
        if (!call) {
          call = { key, startedAt: Date.now(), video: !!video, participants: new Map(), board: null }
          calls.set(key, call)
        }
        if (call.participants.size >= MAX_CALL) throw new Error(`This call is full (${MAX_CALL} people max)`)
        const existing = callSummary(key).participants
        call.participants.set(socket.id, { socketId: socket.id, userId, audio: true, video: !!video, screen: false })
        callOfSocket.set(socket.id, key)
        socket.join(callChannel(key))
        broadcastCall(key)
        if (isNew && key.startsWith('chat:')) {
          const chatId = key.slice(5)
          const name = users.get(userId)?.name ?? 'Someone'
          await systemMessage(chatId, `${name} started a ${video ? 'video' : 'voice'} call`)
          socket.to(key).emit('call:ring', { chatId, video: !!video, from: { id: userId, name, avatar: users.get(userId)?.avatar ?? 0 } })
        }
        // the new person calls everyone already here; they just answer
        return { mySocketId: socket.id, participants: existing, board: call.board }
      })

      // ----- chat inside a study room -----
      on('room:message', async ({ kind, body }) => {
        const roomId = roomOfUser.get(userId)
        if (!roomId) throw new Error('Join a room first')
        const k = kind === 'image' ? 'image' : 'text'
        let text = body
        if (k === 'image') {
          if (typeof text !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(text) || text.length > 2_000_000) throw new Error('That image is too large or not supported')
        } else {
          text = typeof text === 'string' ? text.trim() : ''
          if (!text || text.length > 2000) throw new Error('Messages must be 1 to 2000 characters')
        }
        const r = await q(
          `INSERT INTO room_messages (room_id, user_id, kind, body) VALUES ($1, $2, $3, $4)
           RETURNING id, room_id AS "roomId", user_id AS "userId", kind, body, ${ms('created_at')} AS "createdAt"`,
          [roomId, userId, k, text],
        )
        const u = users.get(userId)
        const msg = { ...r.rows[0], name: u?.name ?? 'Someone', avatar: u?.avatar ?? 0 }
        io.to(channel(roomId)).emit('room:message', msg)
        return { message: msg }
      })
      on('room:history', async () => {
        const roomId = roomOfUser.get(userId)
        if (!roomId) return { roomId: null, messages: [] }
        const r = await q(
          `SELECT m.id, m.room_id AS "roomId", m.user_id AS "userId", m.kind, m.body, ${ms('m.created_at')} AS "createdAt",
                  coalesce(u.display_name, 'Former member') AS name, coalesce(u.avatar, 0) AS avatar
           FROM room_messages m LEFT JOIN users u ON u.id = m.user_id
           WHERE m.room_id = $1 ORDER BY m.created_at DESC LIMIT 60`,
          [roomId],
        )
        return { roomId, messages: r.rows.reverse() }
      })

      on('call:leave', async () => { await leaveCall(socket) })

      socket.on('rtc:signal', ({ to, data } = {}) => {
        const key = callOfSocket.get(socket.id)
        if (!key || typeof to !== 'string' || callOfSocket.get(to) !== key || !data) return
        io.to(to).emit('rtc:signal', { from: socket.id, data })
      })

      socket.on('call:media', ({ audio, video, screen } = {}) => {
        const key = callOfSocket.get(socket.id)
        const p = key && calls.get(key)?.participants.get(socket.id)
        if (!p) return
        p.audio = !!audio; p.video = !!video; p.screen = !!screen
        broadcastCall(key)
      })

      // ----- shared whiteboard inside a call -----
      const myCall = () => { const id = callOfSocket.get(socket.id); return id ? calls.get(id) : null }
      socket.on('board:open', ({ bg } = {}) => {
        const call = myCall()
        if (!call) return
        const background = typeof bg === 'string' && bg.startsWith('data:image/') && bg.length < 4_000_000 ? bg : null
        call.board = { strokes: [], bg: background, openedBy: userId }
        io.to(callChannel(call.key)).emit('board:state', call.board)
        broadcastCall(call.key)
      })
      socket.on('board:strokes', ({ strokes } = {}) => {
        const call = myCall()
        if (!call?.board || !Array.isArray(strokes)) return
        const clean = strokes.slice(0, 200).map(cleanStroke).filter(Boolean)
        if (!clean.length) return
        call.board.strokes.push(...clean)
        if (call.board.strokes.length > MAX_STROKES) call.board.strokes.splice(0, call.board.strokes.length - MAX_STROKES)
        socket.to(callChannel(call.key)).emit('board:strokes', { strokes: clean })
      })
      socket.on('board:clear', () => {
        const call = myCall()
        if (!call?.board) return
        call.board.strokes = []
        call.board.bg = null
        io.to(callChannel(call.key)).emit('board:state', call.board)
      })
      socket.on('board:close', () => {
        const call = myCall()
        if (!call?.board) return
        call.board = null
        io.to(callChannel(call.key)).emit('board:state', null)
        broadcastCall(call.key)
      })

      socket.on('disconnect', async () => {
        leaveCall(socket).catch(console.error)
        const set = socketsByUser.get(userId)
        set?.delete(socket)
        if (set && set.size === 0) {
          socketsByUser.delete(userId)
          // give a reloading tab a few seconds to reconnect before dropping them from their room
          setTimeout(async () => {
            if (isOnline(userId)) return
            statusByUser.delete(userId)
            await leaveRoom(userId).catch(console.error)
            await pushPresence(userId).catch(console.error)
          }, 8000)
        }
      })
    })
  },

  presenceOf,
  leaveRoom,

  /** Called after a profile edit so rooms and friends see the new name/avatar. */
  async refreshUser(userId) {
    await loadUser(userId)
    if (roomOfUser.has(userId)) broadcastRooms()
    for (const fid of await friendIds(userId)) forEachSocket(fid, s => s.emit('friends:changed'))
  },

  /** Tell these users to re-fetch their friend list (request sent, accepted, removed). */
  friendsChanged(userIds) {
    userIds.forEach(id => forEachSocket(id, s => s.emit('friends:changed')))
  },

  callSummary,

  /** Subscribe users' open sockets to a chat (after creating it or adding them). */
  joinChat(chatId, userIds) {
    userIds.forEach(id => forEachSocket(id, s => s.join(chatChannel(chatId))))
  },

  /** Unsubscribe users from a chat, and drop them from its call if they're in one. */
  leaveChat(chatId, userIds) {
    userIds.forEach(id => forEachSocket(id, s => {
      s.leave(chatChannel(chatId))
      if (callOfSocket.get(s.id) === `chat:${chatId}`) leaveCall(s).catch(console.error)
    }))
  },

  emitToChat(chatId, event, payload) {
    io?.to(chatChannel(chatId)).emit(event, payload)
  },

  emitToUser(userId, event, payload) {
    forEachSocket(userId, s => s.emit(event, payload))
  },

  disconnectUser(userId) {
    forEachSocket(userId, s => s.disconnect(true))
  },
}
