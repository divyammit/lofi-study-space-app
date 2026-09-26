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

export const realtime = {
  async init(httpServer) {
    // rooms can't survive a restart (nobody is connected yet), so close any left open
    await q(`DELETE FROM room_members`)
    await q(`UPDATE study_rooms SET closed_at = now() WHERE closed_at IS NULL`)

    // CLIENT_ORIGIN lists frontend domains allowed to open a socket, e.g. https://lofi.vercel.app
    const origins = (process.env.CLIENT_ORIGIN || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
    io = new Server(httpServer, { cors: { origin: origins.length ? origins : false } })

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

      socket.on('disconnect', async () => {
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

  disconnectUser(userId) {
    forEachSocket(userId, s => s.disconnect(true))
  },
}
