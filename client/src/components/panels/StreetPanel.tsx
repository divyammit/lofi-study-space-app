import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../lib/store'
import { fmtClock, fmtHours } from '../../lib/dates'
import type { MemberStatus, RoomMessage, StudyRoom } from '../../lib/types'
import { useCall } from '../../lib/call'
import { boardSnapshot, prepareImage } from '../../lib/board'
import { Panel, Empty } from '../ui'
import PixelAvatar from '../PixelAvatar'
import PixelIcon from '../PixelIcon'

/** "Focus · 12:04 left" computed from a member's shared timer. */
export function statusLabel(s: MemberStatus | null, serverNow: number) {
  if (!s) return 'Here'
  if (!s.running && s.remaining >= s.total) return 'Ready to start'
  const left = s.running && s.endsAt ? Math.max(0, s.endsAt - serverNow) : s.remaining
  const what = s.mode === 'focus' ? 'Focus' : 'Break'
  return s.running ? `${what} · ${fmtClock(left)} left` : `${what} paused`
}

function roomSummary(r: StudyRoom, serverNow: number) {
  const focusing = r.members.filter(m => m.status?.running && m.status.mode === 'focus').length
  if (focusing) return `${focusing} in deep focus`
  if (r.members.some(m => m.status?.running)) return 'On a break'
  return serverNow - r.startedAt < 5 * 60_000 ? 'Just started' : 'Settling in'
}

export default function StreetPanel({ onClose }: { onClose: () => void }) {
  const { rooms, myRoom, createRoom, joinRoom, serverNow, timer, toast, connected, now } = useStore()
  const [busy, setBusy] = useState<string | null>(null)
  void now // re-render every tick so live durations update

  if (myRoom) return <RoomView onClose={onClose} />

  const sNow = serverNow()
  const openOwn = async () => {
    setBusy('new')
    try { await createRoom(timer.subject || 'General'); toast('Your room is open on Study Street.') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not open a room') }
    finally { setBusy(null) }
  }
  const join = async (r: StudyRoom) => {
    setBusy(r.id)
    try { await joinRoom(r.id); toast(`Joined ${r.host}'s room.`) } catch { /* toast shown by store */ }
    finally { setBusy(null) }
  }

  return (
    <Panel
      title="Study street"
      onClose={onClose}
      actions={<button className="px-btn" onClick={openOwn} disabled={!connected || busy === 'new'}>[+] Open my room ({timer.subject || 'General'})</button>}
    >
      <p className="text-muted">People studying right now. Join a room to work alongside them, each on your own timer.</p>
      {rooms.length === 0 ? (
        <div className="mt-3"><Empty>{connected ? 'The street is quiet. Open a room and others can join you.' : 'Connecting to the street…'}</Empty></div>
      ) : (
        <ul className="mt-3 flex flex-col gap-2">
          {rooms.map(r => (
            <li key={r.id} className="px-card flex items-center gap-3 p-3">
              <div className="flex shrink-0 -space-x-3">
                {r.members.slice(0, 3).map(m => <PixelAvatar key={m.id} seed={m.avatar} size={40} className="outline-2 outline-[var(--card)]" />)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[21px]">{r.host} <span className="text-muted">·</span> {r.subject}</div>
                <div className="flex flex-wrap gap-x-3 text-[17px] text-muted">
                  <span><span className="blink text-moss">●</span> live {fmtHours(Math.max(0, sNow - r.startedAt) / 60000)}</span>
                  <span>{roomSummary(r, sNow)}</span>
                  <span>{r.members.length} studying</span>
                  {r.call && <span className="text-moss"><span className="blink">●</span> call · {r.call.participants.length}</span>}
                </div>
              </div>
              <button className="px-solid shrink-0" disabled={busy === r.id} onClick={() => join(r)}>Join</button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-4 text-[17px] text-muted">Rooms are public: anyone on Study Street can see the subject and who&rsquo;s in it.</p>
    </Panel>
  )
}

export function RoomView({ onClose }: { onClose: () => void }) {
  const { myRoom, account, serverNow, timer, timeLeft, startTimer, pauseTimer, leaveRoom, toast, friends, inviteFriend, now } = useStore()
  const callStore = useCall()
  const [inviting, setInviting] = useState(false)
  void now
  if (!myRoom) return null
  const room = myRoom
  const sNow = serverNow()
  const mine = room.hostId === account.id
  const inRoom = new Set(room.members.map(m => m.id))
  const invitable = friends.friends.filter(f => f.online && !inRoom.has(f.id))

  const leave = async () => {
    try { await leaveRoom(); toast(room.members.length === 1 ? 'Room closed.' : `Left ${mine ? 'your' : `${room.host}'s`} room.`) }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not leave') }
  }
  const invite = async (id: string, name: string) => {
    try { await inviteFriend(id); toast(`Invite sent to ${name}.`) } catch (e) { toast(e instanceof Error ? e.message : 'Invite failed') }
  }

  return (
    <Panel title={`Group study · ${room.subject}`} onClose={onClose} wide>
      <p className="text-muted">{mine ? 'Your room' : `${room.host}'s room`} · open for {fmtHours(Math.max(0, sNow - room.startedAt) / 60000)} · {room.members.length} here</p>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3">
        {room.members.map(m => {
          const focusing = m.status?.running && m.status.mode === 'focus'
          return (
            <div key={m.id} className={`px-card relative flex aspect-[4/3] flex-col items-center justify-center overflow-hidden ${focusing ? 'outline-2 outline-amber' : ''}`}>
              <PixelAvatar seed={m.avatar} size={72} />
              <div className="mt-1 text-[17px] text-muted">{statusLabel(m.status, sNow)}</div>
              <div className="absolute right-0 bottom-0 left-0 flex items-center justify-between bg-black/40 px-2 text-[17px] text-[#ece3d0]">
                <span className="truncate">{m.name}{m.id === account.id ? ' (you)' : m.id === room.hostId ? ' (host)' : ''}</span>
                <span className={focusing ? 'text-moss' : 'text-[#9c99b8]'} aria-label={focusing ? 'focusing' : 'idle'}>●</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="px-card mt-3 flex flex-wrap items-center justify-between gap-2 p-3">
        <div>
          <div className="text-[17px] text-muted">Your timer · everyone here sees it</div>
          <div className="font-title text-[24px]">{fmtClock(timeLeft)} <span className="text-[14px] text-muted">{timer.mode === 'focus' ? 'focus' : 'break'}</span></div>
        </div>
        {timer.running ? <button className="px-solid" onClick={pauseTimer}>Pause</button> : <button className="px-solid px-primary" onClick={startTimer}>Start focus</button>}
      </div>

      <div className="px-card mt-3 flex flex-wrap items-center gap-2 p-3">
        <span className="min-w-0 flex-1 text-[17px] text-muted">
          {callStore.call?.key === `room:${room.id}`
            ? "You're in this room's call."
            : room.call ? `${room.call.participants.length} in a call right now` : 'Talk it through: start a call for the room.'}
        </span>
        {callStore.call?.key === `room:${room.id}` ? (
          <button className="px-solid" onClick={() => callStore.setExpanded(true)}>Open call</button>
        ) : room.call ? (
          <button className="px-solid px-primary" disabled={callStore.joining} onClick={() => void callStore.join(`room:${room.id}`, false)}>Join call · {room.call.participants.length}</button>
        ) : (
          <>
            <button className="px-solid flex items-center gap-1" disabled={callStore.joining} onClick={() => void callStore.join(`room:${room.id}`, false)}><PixelIcon name="phone" size={16} />Voice</button>
            <button className="px-solid flex items-center gap-1" disabled={callStore.joining} onClick={() => void callStore.join(`room:${room.id}`, true)}><PixelIcon name="video" size={16} />Video</button>
          </>
        )}
      </div>

      <RoomChat roomId={room.id} />

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="px-solid" onClick={() => setInviting(v => !v)} aria-expanded={inviting}>Invite a friend</button>
        <button className="px-solid ml-auto !bg-rose !text-white" onClick={leave}>{room.members.length === 1 ? 'Close room' : 'Leave room'}</button>
      </div>
      {inviting && (
        <ul className="mt-2 flex flex-col gap-1">
          {invitable.length === 0 && <li className="text-muted">None of your friends are online right now.</li>}
          {invitable.map(f => (
            <li key={f.id} className="px-card flex items-center gap-2 p-2">
              <PixelAvatar seed={f.avatar} size={28} />
              <span className="flex-1">{f.name} <span className="text-muted">@{f.username}</span></span>
              <button className="px-btn" onClick={() => invite(f.id, f.name)}>Send invite</button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[17px] text-muted">Tiles show each person&rsquo;s live timer. Join the call to talk, share your screen or open a shared whiteboard.</p>
    </Panel>
  )
}

/** Chat for everyone in the current study room. History is saved with the room. */
function RoomChat({ roomId }: { roomId: string }) {
  const { socket, account, toast, whiteboard } = useStore()
  const [messages, setMessages] = useState<RoomMessage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const emit = <T,>(event: string, payload: object) => new Promise<T>((resolve, reject) => {
    if (!socket?.connected) return reject(new Error('Not connected to the server'))
    socket.timeout(8000).emit(event, payload, (err: Error | null, res: { ok: boolean; error?: string } & T) => {
      if (err) reject(new Error('The server did not respond'))
      else if (!res.ok) reject(new Error(res.error || 'Something went wrong'))
      else resolve(res)
    })
  })

  useEffect(() => {
    if (!socket) return
    let alive = true
    setLoaded(false)
    emit<{ roomId: string | null; messages: RoomMessage[] }>('room:history', {})
      .then(r => { if (alive) { setMessages(r.messages); setLoaded(true) } })
      .catch(() => { if (alive) setLoaded(true) })
    const onMsg = (m: RoomMessage) => {
      if (m.roomId !== roomId) return
      setMessages(ms => (ms.some(x => x.id === m.id) ? ms : [...ms.slice(-199), m]))
    }
    socket.on('room:message', onMsg)
    return () => { alive = false; socket.off('room:message', onMsg) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, roomId])

  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  const send = async (kind: 'text' | 'image', body: string) => {
    setSending(true)
    try { await emit('room:message', { kind, body }); if (kind === 'text') setText('') }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not send') }
    finally { setSending(false) }
  }
  const submit = () => { if (text.trim() && !sending) void send('text', text.trim()) }

  return (
    <div className="mt-3">
      <h3 className="mb-1 text-muted">Room chat</h3>
      <div ref={listRef} className="px-card px-scroll h-56 overflow-y-auto p-2" aria-live="polite">
        {!loaded && <p className="text-center text-muted">Loading…</p>}
        {loaded && messages.length === 0 && <p className="py-6 text-center text-muted">No messages yet. Ask the room a doubt.</p>}
        {messages.map((m, i) => {
          const mine = m.userId === account.id
          const first = i === 0 || messages[i - 1].userId !== m.userId
          return (
            <div key={m.id} className={`flex gap-2 ${mine ? 'flex-row-reverse' : ''} ${first ? 'mt-2' : 'mt-0.5'}`}>
              {!mine && <div className="w-7 shrink-0">{first && <PixelAvatar seed={m.avatar} size={28} />}</div>}
              <div className={`flex max-w-[80%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
                {first && !mine && <span className="text-[14px] text-muted">{m.name}</span>}
                {m.kind === 'image'
                  ? <img src={m.body} alt={`Image from ${mine ? 'you' : m.name}`} className="max-h-44 max-w-full object-contain" />
                  : <div className={`px-2 py-1 whitespace-pre-wrap break-words ${mine ? 'bg-amber text-[#2a1c10]' : 'bg-card-hi'}`}>{m.body}</div>}
              </div>
            </div>
          )
        })}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={async e => {
          const f = e.target.files?.[0]; e.target.value = ''
          if (!f) return
          try { await send('image', await prepareImage(f)) } catch (err) { toast(err instanceof Error ? err.message : 'Could not send that image') }
        }} />
        <button className="px-btn shrink-0 !p-1" onClick={() => fileRef.current?.click()} aria-label="Send an image to the room" title="Send an image"><PixelIcon name="image" size={20} /></button>
        <button className="px-btn shrink-0 !p-1" aria-label="Share my whiteboard with the room" title="Share my whiteboard" onClick={async () => {
          if (!whiteboard) { toast('Your whiteboard is empty. Draw something in the Whiteboard panel first.'); return }
          await send('image', await boardSnapshot(whiteboard))
        }}><PixelIcon name="board" size={20} /></button>
        <input
          className="px-input flex-1"
          placeholder="Message the room…"
          value={text}
          maxLength={2000}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
          aria-label="Message the room"
        />
        <button className="px-solid px-primary shrink-0 !p-2" onClick={submit} disabled={!text.trim() || sending} aria-label="Send to room"><PixelIcon name="send" size={18} /></button>
      </div>
    </div>
  )
}
