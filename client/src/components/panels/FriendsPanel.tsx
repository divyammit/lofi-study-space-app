import { useState } from 'react'
import { useStore } from '../../lib/store'
import { useChat } from '../../lib/chat'
import type { Friend } from '../../lib/types'
import { Panel, Empty } from '../ui'
import PixelAvatar from '../PixelAvatar'

export default function FriendsPanel({ onClose, openStreet }: { onClose: () => void; openStreet: () => void }) {
  const { friends, friendsLoaded, sendFriendRequest, acceptFriend, removeFriend, joinRoom, createRoom, inviteFriend, myRoom, timer, startTimer, rooms, toast, account } = useStore()
  const { startDirect, openChat } = useChat()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const online = friends.friends.filter(f => f.online)
  const offline = friends.friends.filter(f => !f.online)
  const say = (e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong')

  const add = async (e: React.FormEvent) => {
    e.preventDefault()
    const n = name.trim()
    if (!n) return
    setBusy(true)
    try { toast(await sendFriendRequest(n)); setName('') } catch (err) { say(err) } finally { setBusy(false) }
  }

  const studyTogether = async (f: Friend) => {
    try {
      if (!myRoom) await createRoom(timer.subject || 'General')
      await inviteFriend(f.id)
      if (!timer.running) startTimer()
      toast(`Room open. Invite sent to ${f.name}.`)
      openStreet()
    } catch (err) { say(err) }
  }

  const row = (f: Friend) => {
    const room = f.roomId ? rooms.find(r => r.id === f.roomId) : null
    const inMyRoom = myRoom && f.roomId === myRoom.id
    return (
      <li key={f.id} className="px-card flex items-center gap-3 p-3">
        <div className="relative shrink-0">
          <PixelAvatar seed={f.avatar} size={44} />
          <span className={`absolute -right-1 -bottom-1 h-3 w-3 ${f.online ? 'bg-moss' : 'bg-line'}`} style={{ boxShadow: '0 0 0 2px var(--panel-solid)' }} aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[21px]">{f.name} <span className="text-[17px] text-muted">@{f.username}</span></div>
          <div className="text-[17px] text-muted">
            {!f.online ? 'Offline' : room ? `In a room · ${room.subject}` : f.studying ? `Studying ${f.subject ?? ''}` : 'Online'}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-1">
          <button className="px-solid !px-2 !py-1" onClick={() => startDirect(f.id).then(openChat, say)}>Message</button>
          {f.online && room && !inMyRoom && <button className="px-solid !px-2 !py-1" onClick={() => joinRoom(room.id).then(openStreet, () => {})}>Join</button>}
          {f.online && !room && <button className="px-solid !px-2 !py-1" onClick={() => studyTogether(f)}>{myRoom ? 'Invite' : 'Study together'}</button>}
          {confirmRemove === f.id
            ? <button className="px-btn !text-rose" onClick={() => { setConfirmRemove(null); removeFriend(f.id).catch(say) }}>Remove?</button>
            : <button className="px-btn text-muted" onClick={() => setConfirmRemove(f.id)} aria-label={`Remove ${f.name}`}>×</button>}
        </div>
      </li>
    )
  }

  return (
    <Panel title="Friends" onClose={onClose}>
      <p className="text-muted">Your username is <span className="text-amber">@{account.username}</span>. Share it so friends can add you.</p>
      <form className="mt-2 flex gap-2" onSubmit={add}>
        <input className="px-input" placeholder="Add a friend by username" value={name} onChange={e => setName(e.target.value)} aria-label="Friend's username" maxLength={21} />
        <button className="px-solid shrink-0" type="submit" disabled={busy}>Add</button>
      </form>

      {friends.incoming.length > 0 && (
        <>
          <h3 className="mt-4 mb-2 text-amber">Friend requests · {friends.incoming.length}</h3>
          <ul className="flex flex-col gap-2">
            {friends.incoming.map(f => (
              <li key={f.id} className="px-card flex items-center gap-3 p-3 outline-2 outline-amber">
                <PixelAvatar seed={f.avatar} size={40} className="shrink-0" />
                <div className="min-w-0 flex-1 truncate">{f.name} <span className="text-muted">@{f.username}</span></div>
                <button className="px-solid px-primary !px-2 !py-1" onClick={() => acceptFriend(f.id).then(() => toast(`You and ${f.name} are now friends.`), say)}>Accept</button>
                <button className="px-btn text-muted" onClick={() => removeFriend(f.id).catch(say)}>Decline</button>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="mt-4 mb-2 text-muted">Online · {online.length}</h3>
      <ul className="flex flex-col gap-2">{online.map(row)}</ul>
      <h3 className="mt-4 mb-2 text-muted">Offline · {offline.length}</h3>
      <ul className="flex flex-col gap-2">{offline.map(row)}</ul>
      {friendsLoaded && friends.friends.length === 0 && <Empty>No friends yet. Add someone by their username above.</Empty>}

      {friends.outgoing.length > 0 && (
        <>
          <h3 className="mt-4 mb-2 text-muted">Waiting for a reply</h3>
          <ul className="flex flex-col gap-1">
            {friends.outgoing.map(f => (
              <li key={f.id} className="flex items-center justify-between gap-2">
                <span>{f.name} <span className="text-muted">@{f.username}</span></span>
                <button className="px-btn text-muted" onClick={() => removeFriend(f.id).catch(say)}>Cancel</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Panel>
  )
}
