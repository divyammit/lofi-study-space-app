import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStore } from './store'
import { api } from './api'
import { engine } from './audio'
import { uid } from './storage'
import type { CallSummary, Chat, ChatMessage } from './types'

interface Thread { items: ChatMessage[]; hasMore: boolean; loaded: boolean; loading: boolean }

interface ChatStore {
  chats: Chat[]
  chatsLoaded: boolean
  totalUnread: number
  threads: Record<string, Thread>
  activeChatId: string | null
  setActiveChatId: (id: string | null) => void
  /** increments whenever something asks for the chats panel to open */
  openSignal: number
  openChat: (id: string) => void
  setViewing: (id: string | null) => void
  loadMessages: (chatId: string, older?: boolean) => Promise<void>
  sendText: (chatId: string, text: string) => void
  sendImage: (chatId: string, dataUrl: string) => void
  retry: (chatId: string, tempId: string) => void
  startDirect: (userId: string) => Promise<string>
  createGroup: (name: string, memberIds: string[]) => Promise<string>
  renameGroup: (chatId: string, name: string) => Promise<void>
  addMembers: (chatId: string, userIds: string[]) => Promise<void>
  removeMember: (chatId: string, userId: string) => Promise<void>
  sendTyping: (chatId: string) => void
  typingIn: (chatId: string) => string[]
  chatTitle: (chat: Chat) => string
  refreshChats: () => Promise<void>
}

const Ctx = createContext<ChatStore | null>(null)
export const useChat = () => {
  const c = useContext(Ctx)
  if (!c) throw new Error('useChat outside ChatProvider')
  return c
}

const emptyThread: Thread = { items: [], hasMore: false, loaded: false, loading: false }

export function ChatProvider({ children }: { children: ReactNode }) {
  const { socket, account, toast, settings } = useStore()
  const me = account.id
  const [chats, setChats] = useState<Chat[]>([])
  const [chatsLoaded, setChatsLoaded] = useState(false)
  const [threads, setThreads] = useState<Record<string, Thread>>({})
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [openSignal, setOpenSignal] = useState(0)
  const [typing, setTyping] = useState<Record<string, Record<string, { name: string; until: number }>>>({})
  const viewingRef = useRef<string | null>(null)
  const chatsRef = useRef(chats)
  chatsRef.current = chats
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const say = useCallback((e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong'), [toast])

  const chatTitle = useCallback((c: Chat) => {
    if (!c.isDirect) return c.name ?? 'Group'
    return c.members.find(m => m.id !== me)?.name ?? 'Chat'
  }, [me])

  const refreshChats = useCallback(async () => {
    try {
      const r = await api<{ chats: Chat[] }>('/api/chats')
      setChats(r.chats)
      setChatsLoaded(true)
    } catch { /* offline: keep what we have */ }
  }, [])

  const upsertChat = useCallback((chat: Chat) => {
    setChats(cs => [chat, ...cs.filter(c => c.id !== chat.id)])
  }, [])

  const patchThread = useCallback((chatId: string, fn: (t: Thread) => Thread) => {
    setThreads(ts => ({ ...ts, [chatId]: fn(ts[chatId] ?? emptyThread) }))
  }, [])

  const markRead = useCallback((chatId: string) => {
    setChats(cs => cs.map(c => (c.id === chatId && c.unread ? { ...c, unread: 0 } : c)))
    api(`/api/chats/${chatId}/read`, { method: 'POST' }).catch(() => {})
  }, [])

  const loadMessages = useCallback(async (chatId: string, older = false) => {
    const t = threadsRef.current[chatId] ?? emptyThread
    if (t.loading || (older && !t.hasMore)) return
    patchThread(chatId, x => ({ ...x, loading: true }))
    try {
      const oldest = older ? t.items.find(m => !m.pending)?.createdAt : undefined
      const r = await api<{ messages: ChatMessage[]; hasMore: boolean }>(`/api/chats/${chatId}/messages${oldest ? `?before=${oldest}` : ''}`)
      patchThread(chatId, x => {
        if (older) return { ...x, items: [...r.messages, ...x.items], hasMore: r.hasMore, loading: false, loaded: true }
        // merge the latest page with anything already here (e.g. pending messages)
        const known = new Set(r.messages.map(m => m.id))
        const keep = x.items.filter(m => m.pending || m.failed || (!known.has(m.id) && m.createdAt > (r.messages.at(-1)?.createdAt ?? 0)))
        return { items: [...r.messages, ...keep], hasMore: r.hasMore, loading: false, loaded: true }
      })
    } catch (e) {
      patchThread(chatId, x => ({ ...x, loading: false }))
      say(e)
    }
  }, [patchThread, say])

  const openChat = useCallback((id: string) => {
    setActiveChatId(id)
    setOpenSignal(n => n + 1)
  }, [])

  const setViewing = useCallback((id: string | null) => {
    viewingRef.current = id
    if (id) markRead(id)
  }, [markRead])

  // ----- sending (optimistic: shows immediately, confirmed when the server answers) -----
  const deliver = useCallback(async (chatId: string, tempId: string, kind: 'text' | 'image', body: string) => {
    try {
      const r = await api<{ message: ChatMessage }>(`/api/chats/${chatId}/messages`, { body: { kind, body } })
      patchThread(chatId, x => {
        const already = x.items.some(m => m.id === r.message.id)
        return { ...x, items: already ? x.items.filter(m => m.id !== tempId) : x.items.map(m => (m.id === tempId ? r.message : m)) }
      })
    } catch (e) {
      patchThread(chatId, x => ({ ...x, items: x.items.map(m => (m.id === tempId ? { ...m, pending: false, failed: true } : m)) }))
      say(e)
    }
  }, [patchThread, say])

  const send = useCallback((chatId: string, kind: 'text' | 'image', body: string) => {
    const tempId = `tmp-${uid()}`
    const msg: ChatMessage = { id: tempId, chatId, userId: me, kind, body, createdAt: Date.now(), pending: true }
    patchThread(chatId, x => ({ ...x, items: [...x.items, msg] }))
    setChats(cs => {
      const c = cs.find(x => x.id === chatId)
      if (!c) return cs
      return [{ ...c, lastMessage: { id: tempId, kind, userId: me, body: kind === 'image' ? '' : body, createdAt: msg.createdAt } }, ...cs.filter(x => x.id !== chatId)]
    })
    void deliver(chatId, tempId, kind, body)
  }, [me, patchThread, deliver])

  const sendText = useCallback((chatId: string, text: string) => {
    const t = text.trim()
    if (t) send(chatId, 'text', t.slice(0, 4000))
  }, [send])
  const sendImage = useCallback((chatId: string, dataUrl: string) => send(chatId, 'image', dataUrl), [send])
  const retry = useCallback((chatId: string, tempId: string) => {
    const m = threadsRef.current[chatId]?.items.find(x => x.id === tempId)
    if (!m || m.kind === 'system') return
    patchThread(chatId, x => ({ ...x, items: x.items.map(i => (i.id === tempId ? { ...i, failed: false, pending: true } : i)) }))
    void deliver(chatId, tempId, m.kind, m.body)
  }, [patchThread, deliver])

  // ----- chat management -----
  const startDirect = useCallback(async (userId: string) => {
    const r = await api<{ chat: Chat }>('/api/chats/direct', { body: { userId } })
    upsertChat(r.chat)
    return r.chat.id
  }, [upsertChat])
  const createGroup = useCallback(async (name: string, memberIds: string[]) => {
    const r = await api<{ chat: Chat }>('/api/chats', { body: { name, memberIds } })
    upsertChat(r.chat)
    return r.chat.id
  }, [upsertChat])
  const renameGroup = useCallback(async (chatId: string, name: string) => {
    await api(`/api/chats/${chatId}`, { method: 'PATCH', body: { name } })
  }, [])
  const addMembers = useCallback(async (chatId: string, userIds: string[]) => {
    await api(`/api/chats/${chatId}/members`, { body: { userIds } })
  }, [])
  const removeMember = useCallback(async (chatId: string, userId: string) => {
    await api(`/api/chats/${chatId}/members/${userId}`, { method: 'DELETE' })
    if (userId === me) {
      setChats(cs => cs.filter(c => c.id !== chatId))
      setActiveChatId(a => (a === chatId ? null : a))
    }
  }, [me])

  const lastTyping = useRef(0)
  const sendTyping = useCallback((chatId: string) => {
    if (Date.now() - lastTyping.current < 2500) return
    lastTyping.current = Date.now()
    socket?.emit('chat:typing', { chatId })
  }, [socket])

  const [, force] = useState(0)
  const typingIn = useCallback((chatId: string) => {
    const now = Date.now()
    return Object.values(typing[chatId] ?? {}).filter(t => t.until > now).map(t => t.name)
  }, [typing])
  // clear expired "typing…" labels
  useEffect(() => {
    const iv = setInterval(() => force(n => n + 1), 1500)
    return () => clearInterval(iv)
  }, [])

  // ----- live updates -----
  useEffect(() => { void refreshChats() }, [refreshChats])

  useEffect(() => {
    if (!socket) return
    let refreshTimer = 0
    const refreshSoon = () => { clearTimeout(refreshTimer); refreshTimer = window.setTimeout(() => void refreshChats(), 150) }

    const onMessage = (m: ChatMessage) => {
      const chat = chatsRef.current.find(c => c.id === m.chatId)
      if (!chat) { refreshSoon(); return } // a chat we didn't know about yet (just added to a group)
      const mine = m.userId === me
      patchThread(m.chatId, x => {
        if (!x.loaded) return x
        if (x.items.some(i => i.id === m.id)) return x
        if (mine) {
          // our own message echoed back before the POST finished: swap out the pending copy
          const idx = x.items.findIndex(i => i.pending && i.kind === m.kind && i.body === m.body)
          if (idx >= 0) { const items = [...x.items]; items[idx] = m; return { ...x, items } }
        }
        return { ...x, items: [...x.items, m] }
      })
      const viewing = viewingRef.current === m.chatId && document.visibilityState === 'visible'
      const counts = !mine && m.kind !== 'system'
      setChats(cs => {
        const c = cs.find(x => x.id === m.chatId)
        if (!c) return cs
        const lastMessage = { id: m.id, kind: m.kind, userId: m.userId, body: m.kind === 'image' ? '' : m.body.slice(0, 140), createdAt: m.createdAt }
        return [{ ...c, lastMessage, unread: counts && !viewing ? c.unread + 1 : c.unread }, ...cs.filter(x => x.id !== m.chatId)]
      })
      if (viewing && counts) api(`/api/chats/${m.chatId}/read`, { method: 'POST' }).catch(() => {})
      if (counts) {
        setTyping(t => { const x = { ...(t[m.chatId] ?? {}) }; if (m.userId) delete x[m.userId]; return { ...t, [m.chatId]: x } })
        if (!viewing) {
          const author = chat.members.find(u => u.id === m.userId)?.name ?? 'Someone'
          const where = chat.isDirect ? author : `${author} in ${chat.name}`
          if (settingsRef.current.chime) engine.chime()
          toast(`${where}: ${m.kind === 'image' ? 'sent an image' : m.body.slice(0, 80)}`, { label: 'Open', run: () => openChat(m.chatId) })
        }
      }
    }
    const onTyping = ({ chatId, userId, name }: { chatId: string; userId: string; name: string }) => {
      if (userId === me) return
      setTyping(t => ({ ...t, [chatId]: { ...(t[chatId] ?? {}), [userId]: { name, until: Date.now() + 4000 } } }))
    }
    const onRemoved = ({ chatId }: { chatId: string }) => {
      setChats(cs => cs.filter(c => c.id !== chatId))
      setActiveChatId(a => (a === chatId ? null : a))
    }
    const onCallState = ({ chatId, call }: { chatId: string; call: CallSummary | null }) => {
      setChats(cs => cs.map(c => (c.id === chatId ? { ...c, call } : c)))
    }
    const onConnect = () => {
      void refreshChats()
      if (viewingRef.current) void loadMessages(viewingRef.current)
    }

    socket.on('chat:message', onMessage)
    socket.on('chat:typing', onTyping)
    socket.on('chat:updated', refreshSoon)
    socket.on('chat:removed', onRemoved)
    socket.on('call:state', onCallState)
    socket.on('connect', onConnect)
    return () => {
      clearTimeout(refreshTimer)
      socket.off('chat:message', onMessage)
      socket.off('chat:typing', onTyping)
      socket.off('chat:updated', refreshSoon)
      socket.off('chat:removed', onRemoved)
      socket.off('call:state', onCallState)
      socket.off('connect', onConnect)
    }
  }, [socket, me, patchThread, refreshChats, loadMessages, toast, openChat])

  // mark the open chat read when the tab comes back into view
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible' && viewingRef.current) markRead(viewingRef.current) }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [markRead])

  const totalUnread = useMemo(() => chats.reduce((n, c) => n + c.unread, 0), [chats])

  const value: ChatStore = {
    chats, chatsLoaded, totalUnread, threads, activeChatId, setActiveChatId, openSignal, openChat, setViewing,
    loadMessages, sendText, sendImage, retry, startDirect, createGroup, renameGroup, addMembers, removeMember,
    sendTyping, typingIn, chatTitle, refreshChats,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
