import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../../lib/store'
import { useChat } from '../../lib/chat'
import { useCall } from '../../lib/call'
import { boardSnapshot, prepareImage } from '../../lib/board'
import type { Chat, ChatMessage } from '../../lib/types'
import { Panel, Empty } from '../ui'
import PixelAvatar from '../PixelAvatar'
import PixelIcon from '../PixelIcon'

type View = 'list' | 'new' | 'chat' | 'info'

const timeShort = (ms: number) => {
  const d = new Date(ms)
  const today = new Date()
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const days = Math.floor((today.getTime() - ms) / 86400000)
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'short' })
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}
const dayLabel = (ms: number) => {
  const d = new Date(ms)
  const today = new Date()
  const y = new Date(); y.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === y.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
}

function ChatAvatar({ chat, me, size = 40 }: { chat: Chat; me: string; size?: number }) {
  if (chat.isDirect) return <PixelAvatar seed={chat.members.find(m => m.id !== me)?.avatar ?? 0} size={size} />
  const others = chat.members.filter(m => m.id !== me).slice(0, 2)
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      {others[0] && <PixelAvatar seed={others[0].avatar} size={Math.round(size * 0.72)} className="absolute top-0 left-0" />}
      {others[1] && <PixelAvatar seed={others[1].avatar} size={Math.round(size * 0.72)} className="absolute right-0 bottom-0 outline-2 outline-[var(--panel-solid)]" />}
    </div>
  )
}

export default function ChatsPanel({ onClose }: { onClose: () => void }) {
  const { activeChatId, setActiveChatId, chats } = useChat()
  const [view, setView] = useState<View>(activeChatId ? 'chat' : 'list')

  // something else (a notification, the Friends panel) asked to open a chat
  useEffect(() => { if (activeChatId) setView(v => (v === 'info' ? v : 'chat')) }, [activeChatId])
  // the open chat vanished (left or removed)
  useEffect(() => {
    if (activeChatId && chats.length && !chats.some(c => c.id === activeChatId)) { setActiveChatId(null); setView('list') }
  }, [chats, activeChatId, setActiveChatId])

  const back = () => { setActiveChatId(null); setView('list') }
  if (view === 'new') return <NewGroup onClose={onClose} onBack={() => setView('list')} onCreated={id => { setActiveChatId(id); setView('chat') }} />
  if (view === 'info' && activeChatId) return <ChatInfo onClose={onClose} onBack={() => setView('chat')} />
  if (view === 'chat' && activeChatId) return <ChatView onClose={onClose} onBack={back} onInfo={() => setView('info')} />
  return <ChatList onClose={onClose} onNew={() => setView('new')} onOpen={id => { setActiveChatId(id); setView('chat') }} />
}

function ChatList({ onClose, onNew, onOpen }: { onClose: () => void; onNew: () => void; onOpen: (id: string) => void }) {
  const { chats, chatsLoaded, chatTitle, startDirect } = useChat()
  const { account, friends, toast } = useStore()
  const me = account.id
  const directWith = new Set(chats.filter(c => c.isDirect).flatMap(c => c.members.map(m => m.id)))
  const startable = friends.friends.filter(f => !directWith.has(f.id))

  const preview = (c: Chat) => {
    const m = c.lastMessage
    if (!m) return c.isDirect ? 'Say hi' : 'No messages yet'
    if (m.kind === 'system') return m.body
    const who = m.userId === me ? 'You' : c.isDirect ? '' : (c.members.find(u => u.id === m.userId)?.name ?? 'Someone')
    const text = m.kind === 'image' ? 'sent an image' : m.body
    return who ? `${who}: ${text}` : text
  }

  return (
    <Panel title="Chats" onClose={onClose} actions={<button className="px-btn" onClick={onNew}>[+] New group</button>}>
      {startable.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 text-[17px] text-muted">Message a friend</div>
          <div className="px-scroll flex gap-3 overflow-x-auto pb-1">
            {startable.map(f => (
              <button key={f.id} className="flex w-14 shrink-0 flex-col items-center gap-1 hover:text-amber" onClick={() => startDirect(f.id).then(onOpen, e => toast(e.message))} title={`Message ${f.name}`}>
                <span className="relative">
                  <PixelAvatar seed={f.avatar} size={40} />
                  {f.online && <span className="absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 bg-moss" style={{ boxShadow: '0 0 0 2px var(--panel-solid)' }} />}
                </span>
                <span className="w-full truncate text-center text-[15px]">{f.name}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {chatsLoaded && chats.length === 0 ? (
        <Empty>No chats yet. Tap a friend above, or start a group for your study circle.</Empty>
      ) : (
        <ul className="flex flex-col gap-1">
          {chats.map(c => (
            <li key={c.id}>
              <button className="px-card flex w-full items-center gap-3 p-2 text-left hover:bg-card-hi" onClick={() => onOpen(c.id)}>
                <ChatAvatar chat={c} me={me} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={`truncate text-[21px] ${c.unread ? 'text-amber' : ''}`}>{chatTitle(c)}</span>
                    {c.call && <span className="shrink-0 text-[15px] text-moss"><span className="blink">●</span> call</span>}
                    <span className="ml-auto shrink-0 text-[15px] text-muted">{c.lastMessage ? timeShort(c.lastMessage.createdAt) : ''}</span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className={`truncate text-[17px] ${c.unread ? 'text-ink' : 'text-muted'}`}>{preview(c)}</span>
                    {c.unread > 0 && <span className="ml-auto shrink-0 bg-[#e8707e] px-1.5 text-[14px] leading-[18px] text-white">{c.unread}</span>}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {friends.friends.length === 0 && <p className="mt-3 text-[17px] text-muted">Add friends in the Friends panel to start chatting.</p>}
    </Panel>
  )
}

function NewGroup({ onClose, onBack, onCreated }: { onClose: () => void; onBack: () => void; onCreated: (id: string) => void }) {
  const { friends, toast } = useStore()
  const { createGroup } = useChat()
  const [name, setName] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const toggle = (id: string) => setPicked(p => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try { onCreated(await createGroup(name.trim(), [...picked])) } catch (err) { toast(err instanceof Error ? err.message : 'Could not create the group'); setBusy(false) }
  }
  return (
    <Panel title="New group" onClose={onClose} lead={<button className="px-btn" onClick={onBack} aria-label="Back"><PixelIcon name="back" size={16} /></button>}>
      <form className="flex flex-col gap-3" onSubmit={create}>
        <label className="flex flex-col gap-1">
          <span className="text-muted">Group name</span>
          <input className="px-input" value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder="e.g. DBMS doubts, JEE squad" required autoFocus />
        </label>
        <div>
          <div className="mb-1 text-muted">Add friends · {picked.size} picked</div>
          {friends.friends.length === 0 ? <Empty>You need friends first. Add them in the Friends panel.</Empty> : (
            <ul className="flex flex-col gap-1">
              {friends.friends.map(f => (
                <li key={f.id}>
                  <label className={`px-card flex cursor-pointer items-center gap-3 p-2 ${picked.has(f.id) ? 'outline-2 outline-amber' : ''}`}>
                    <input type="checkbox" className="h-4 w-4 accent-[var(--amber)]" checked={picked.has(f.id)} onChange={() => toggle(f.id)} />
                    <PixelAvatar seed={f.avatar} size={32} />
                    <span className="flex-1 truncate">{f.name} <span className="text-muted">@{f.username}</span></span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button type="submit" className="px-solid px-primary !py-2" disabled={busy || !name.trim() || picked.size === 0}>Create group</button>
      </form>
    </Panel>
  )
}

function ChatView({ onClose, onBack, onInfo }: { onClose: () => void; onBack: () => void; onInfo: () => void }) {
  const { account, friends, toast, whiteboard } = useStore()
  const chatStore = useChat()
  const { activeChatId, chats, threads, loadMessages, sendText, sendImage, retry, setViewing, sendTyping, typingIn, chatTitle } = chatStore
  const callStore = useCall()
  const me = account.id
  const chat = chats.find(c => c.id === activeChatId)!
  const thread = threads[chat.id]
  const [text, setText] = useState('')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stick = useRef(true) // keep scrolled to the bottom unless the user scrolled up
  const prevHeight = useRef(0)

  useEffect(() => {
    setViewing(chat.id)
    if (!threads[chat.id]?.loaded) void loadMessages(chat.id)
    stick.current = true
    return () => setViewing(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id])

  const items = thread?.items ?? []
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (prevHeight.current && el.scrollHeight > prevHeight.current && el.scrollTop < 40 && !stick.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current // older messages were added above: keep position
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight
    }
    prevHeight.current = el.scrollHeight
  }, [items])

  const other = chat.isDirect ? chat.members.find(m => m.id !== me) : null
  const otherPresence = other ? friends.friends.find(f => f.id === other.id) : null
  const typers = typingIn(chat.id)
  const subtitle = typers.length
    ? `${typers.join(', ')} ${typers.length > 1 ? 'are' : 'is'} typing…`
    : chat.isDirect
      ? (otherPresence?.online ? 'Online' : 'Offline')
      : `${chat.members.length} members`
  const nameOf = (uid: string | null) => chat.members.find(m => m.id === uid)?.name ?? 'Former member'
  const avatarOf = (uid: string | null) => chat.members.find(m => m.id === uid)?.avatar ?? 0
  const inThisCall = callStore.call?.chatId === chat.id

  const submit = () => {
    if (!text.trim()) return
    stick.current = true
    sendText(chat.id, text)
    setText('')
  }
  const pickImage = async (f: File | undefined) => {
    if (!f) return
    try { stick.current = true; sendImage(chat.id, await prepareImage(f)) } catch (e) { toast(e instanceof Error ? e.message : 'Could not send that image') }
  }
  const shareBoard = async () => {
    if (!whiteboard) { toast('Your whiteboard is empty. Draw something in the Whiteboard panel first.'); return }
    try { stick.current = true; sendImage(chat.id, await boardSnapshot(whiteboard)) } catch { toast('Could not share the board') }
  }

  // group messages: day separators, and name/avatar only on the first of a run
  const rendered: React.ReactNode[] = []
  items.forEach((m: ChatMessage, i) => {
    const prev = items[i - 1]
    if (!prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString()) {
      rendered.push(<div key={`d-${m.id}`} className="my-2 text-center text-[15px] text-muted">{dayLabel(m.createdAt)}</div>)
    }
    if (m.kind === 'system') {
      rendered.push(<div key={m.id} className="my-1 text-center text-[16px] text-muted">{m.body}</div>)
      return
    }
    const mine = m.userId === me
    const first = !prev || prev.userId !== m.userId || prev.kind === 'system' || m.createdAt - prev.createdAt > 5 * 60_000
    rendered.push(
      <div key={m.id} className={`flex gap-2 ${mine ? 'flex-row-reverse' : ''} ${first ? 'mt-2' : 'mt-0.5'}`}>
        {!mine && <div className="w-8 shrink-0">{first && <PixelAvatar seed={avatarOf(m.userId)} size={32} />}</div>}
        <div className={`flex max-w-[78%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
          {first && !mine && !chat.isDirect && <span className="text-[15px] text-muted">{nameOf(m.userId)}</span>}
          {m.kind === 'image' ? (
            <button onClick={() => setLightbox(m.body)} className={`block overflow-hidden ${m.pending ? 'opacity-60' : ''}`} aria-label="Open image">
              <img src={m.body} alt={`Image from ${mine ? 'you' : nameOf(m.userId)}`} className="max-h-60 max-w-full object-contain" loading="lazy" />
            </button>
          ) : (
            <div className={`px-3 py-1.5 whitespace-pre-wrap break-words ${mine ? 'bg-amber text-[#2a1c10]' : 'bg-card'} ${m.pending ? 'opacity-60' : ''}`}>{m.body}</div>
          )}
          <span className="text-[13px] text-muted">
            {m.failed
              ? <button className="text-rose underline" onClick={() => retry(chat.id, m.id)}>Not sent · tap to retry</button>
              : m.pending ? 'Sending…' : new Date(m.createdAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
          </span>
        </div>
      </div>,
    )
  })

  return (
    <Panel
      title={chatTitle(chat)}
      onClose={onClose}
      wide
      fill
      lead={<button className="px-btn shrink-0" onClick={onBack} aria-label="Back to chats"><PixelIcon name="back" size={16} /></button>}
    >
      <div className="-mt-1 mb-2 flex flex-wrap items-center gap-2">
        <span className={`min-w-0 flex-1 truncate text-[17px] ${typers.length ? 'text-amber' : 'text-muted'}`}>{subtitle}</span>
        {chat.call && !inThisCall && (
          <button className="px-solid px-primary !py-1" onClick={() => void callStore.join(chat.id, false)} disabled={callStore.joining}>
            Join call · {chat.call.participants.length}
          </button>
        )}
        {inThisCall ? (
          <button className="px-solid !py-1" onClick={() => callStore.setExpanded(true)}>In call · open</button>
        ) : !chat.call && (
          <>
            <button className="px-solid flex items-center gap-1 !px-2 !py-1" onClick={() => void callStore.join(chat.id, false)} disabled={callStore.joining} aria-label="Start voice call" title="Voice call">
              <PixelIcon name="phone" size={16} /><span className="hidden sm:inline">Voice</span>
            </button>
            <button className="px-solid flex items-center gap-1 !px-2 !py-1" onClick={() => void callStore.join(chat.id, true)} disabled={callStore.joining} aria-label="Start video call" title="Video call">
              <PixelIcon name="video" size={16} /><span className="hidden sm:inline">Video</span>
            </button>
          </>
        )}
        {!chat.isDirect && <button className="px-btn" onClick={onInfo}>Info</button>}
      </div>

      <div
        ref={listRef}
        className="px-scroll min-h-0 flex-1 overflow-y-auto pr-1"
        onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}
        aria-live="polite"
      >
        {thread?.hasMore && (
          <div className="my-2 text-center">
            <button className="px-btn" onClick={() => { stick.current = false; void loadMessages(chat.id, true) }} disabled={thread.loading}>
              {thread.loading ? 'Loading…' : 'Load earlier messages'}
            </button>
          </div>
        )}
        {!thread?.loaded && <p className="py-6 text-center text-muted">Loading messages…</p>}
        {thread?.loaded && items.length === 0 && <p className="py-6 text-center text-muted">No messages yet. Ask a doubt, share your board, or just say hi.</p>}
        {rendered}
      </div>

      <div className="mt-2 flex items-end gap-2 border-t-2 border-line pt-2">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => { void pickImage(e.target.files?.[0]); e.target.value = '' }} />
        <button className="px-btn shrink-0 !p-1" onClick={() => fileRef.current?.click()} aria-label="Send an image" title="Send an image"><PixelIcon name="image" size={22} /></button>
        <button className="px-btn shrink-0 !p-1" onClick={() => void shareBoard()} aria-label="Share my whiteboard" title="Share my whiteboard"><PixelIcon name="board" size={22} /></button>
        <textarea
          className="px-input max-h-32 min-h-[40px] flex-1 resize-none"
          rows={Math.min(4, Math.max(1, text.split('\n').length))}
          placeholder="Message… (Enter to send, Shift+Enter for a new line)"
          value={text}
          maxLength={4000}
          onChange={e => { setText(e.target.value); if (e.target.value) sendTyping(chat.id) }}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }}
          aria-label="Message"
        />
        <button className="px-solid px-primary shrink-0 !p-2" onClick={submit} disabled={!text.trim()} aria-label="Send"><PixelIcon name="send" size={20} /></button>
      </div>

      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setLightbox(null)} role="dialog" aria-label="Image">
          <img src={lightbox} alt="" className="max-h-full max-w-full object-contain" />
          <button className="absolute top-4 right-4 text-white" aria-label="Close image"><PixelIcon name="close" size={22} /></button>
        </div>
      )}
    </Panel>
  )
}

function ChatInfo({ onClose, onBack }: { onClose: () => void; onBack: () => void }) {
  const { account, friends, toast } = useStore()
  const { activeChatId, chats, renameGroup, addMembers, removeMember } = useChat()
  const chat = chats.find(c => c.id === activeChatId)!
  const me = account.id
  const amAdmin = chat.members.find(m => m.id === me)?.role === 'admin'
  const [name, setName] = useState(chat.name ?? '')
  const [adding, setAdding] = useState<Set<string>>(new Set())
  const [confirmLeave, setConfirmLeave] = useState(false)
  const memberIds = useMemo(() => new Set(chat.members.map(m => m.id)), [chat.members])
  const addable = friends.friends.filter(f => !memberIds.has(f.id))
  const say = (e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong')

  return (
    <Panel title="Group info" onClose={onClose} lead={<button className="px-btn" onClick={onBack} aria-label="Back to chat"><PixelIcon name="back" size={16} /></button>}>
      {amAdmin ? (
        <form className="flex gap-2" onSubmit={e => { e.preventDefault(); renameGroup(chat.id, name.trim()).then(() => toast('Group renamed.'), say) }}>
          <input className="px-input" value={name} onChange={e => setName(e.target.value)} maxLength={60} aria-label="Group name" required />
          <button className="px-solid shrink-0" type="submit" disabled={!name.trim() || name.trim() === chat.name}>Rename</button>
        </form>
      ) : <p className="font-title text-[20px]">{chat.name}</p>}

      <h3 className="mt-4 mb-2 text-muted">{chat.members.length} members</h3>
      <ul className="flex flex-col gap-1">
        {chat.members.map(m => (
          <li key={m.id} className="px-card flex items-center gap-3 p-2">
            <PixelAvatar seed={m.avatar} size={32} />
            <span className="min-w-0 flex-1 truncate">{m.name}{m.id === me ? ' (you)' : ''} <span className="text-muted">@{m.username}</span></span>
            {m.role === 'admin' && <span className="text-[15px] text-amber">admin</span>}
            {amAdmin && m.id !== me && <button className="px-btn text-muted hover:!text-rose" onClick={() => removeMember(chat.id, m.id).then(() => toast(`Removed ${m.name}.`), say)}>Remove</button>}
          </li>
        ))}
      </ul>

      {amAdmin && addable.length > 0 && (
        <>
          <h3 className="mt-4 mb-2 text-muted">Add friends</h3>
          <ul className="flex flex-col gap-1">
            {addable.map(f => (
              <li key={f.id}>
                <label className="px-card flex cursor-pointer items-center gap-3 p-2">
                  <input type="checkbox" className="h-4 w-4 accent-[var(--amber)]" checked={adding.has(f.id)} onChange={() => setAdding(p => { const n = new Set(p); if (n.has(f.id)) n.delete(f.id); else n.add(f.id); return n })} />
                  <PixelAvatar seed={f.avatar} size={28} />
                  <span className="flex-1 truncate">{f.name}</span>
                </label>
              </li>
            ))}
          </ul>
          <button className="px-solid mt-2" disabled={!adding.size} onClick={() => addMembers(chat.id, [...adding]).then(() => { setAdding(new Set()); toast('Added to the group.') }, say)}>Add {adding.size || ''}</button>
        </>
      )}

      <div className="mt-5 border-t-2 border-line pt-3">
        {confirmLeave ? (
          <div className="flex flex-wrap items-center gap-2">
            <span>Leave "{chat.name}"?</span>
            <button className="px-solid !bg-rose !text-white" onClick={() => removeMember(chat.id, me).then(() => toast('You left the group.'), say)}>Leave</button>
            <button className="px-btn" onClick={() => setConfirmLeave(false)}>Stay</button>
          </div>
        ) : <button className="px-btn text-muted hover:!text-rose" onClick={() => setConfirmLeave(true)}>Leave group</button>}
      </div>
    </Panel>
  )
}
