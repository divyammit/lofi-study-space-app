import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { io, type Socket } from 'socket.io-client'
import type { Account, AppState, FriendsData, Note, Profile, Session, Settings, SoundId, SoundMix, StudyRoom, Task } from './types'
import { useStored, uid } from './storage'
import { DEFAULT_MIX, DEFAULT_PROFILE, DEFAULT_SETTINGS } from './defaults'
import { dayKey } from './dates'
import { engine } from './audio'
import { api, ApiError } from './api'
import { useSyncedList, useSyncedValue } from './sync'

export type TimerMode = 'focus' | 'short' | 'long'

export interface TimerState {
  mode: TimerMode
  running: boolean
  endsAt: number | null
  remaining: number // ms, used while paused
  total: number // ms, full length of the current block
  cycle: number // completed focus blocks since last long break
  subject: string
}

interface Toast { id: string; text: string; action?: { label: string; run: () => void } }

interface Store {
  account: Account
  logout: () => Promise<void>
  deleteAccount: (password: string) => Promise<void>
  settings: Settings
  setSettings: (fn: (s: Settings) => Settings) => void
  profile: Profile
  setProfile: (fn: (p: Profile) => Profile) => void
  tasks: Task[]
  setTasks: (fn: (t: Task[]) => Task[]) => void
  notes: Note[]
  setNotes: (fn: (n: Note[]) => Note[]) => void
  sessions: Session[]
  setSessions: (fn: (s: Session[]) => Session[]) => void
  mix: SoundMix
  setSound: (id: SoundId, patch: Partial<{ on: boolean; vol: number }>) => void
  anySoundOn: boolean
  timer: TimerState
  now: number
  timeLeft: number
  startTimer: () => void
  pauseTimer: () => void
  resetTimer: () => void
  skipTimer: () => void
  setMode: (m: TimerMode) => void
  setSubject: (s: string) => void
  sessionsToday: number
  toasts: Toast[]
  toast: (text: string, action?: Toast['action']) => void
  focusMode: boolean
  setFocusMode: (v: boolean) => void
  whiteboard: string | null
  setWhiteboard: (v: string | null) => void
  // live / social
  connected: boolean
  serverNow: () => number
  rooms: StudyRoom[]
  myRoom: StudyRoom | null
  createRoom: (subject: string) => Promise<string>
  joinRoom: (id: string) => Promise<void>
  leaveRoom: () => Promise<void>
  friends: FriendsData
  friendsLoaded: boolean
  refreshFriends: () => Promise<void>
  sendFriendRequest: (username: string) => Promise<string>
  acceptFriend: (id: string) => Promise<void>
  removeFriend: (id: string) => Promise<void>
  inviteFriend: (id: string) => Promise<void>
}

const Ctx = createContext<Store | null>(null)
export const useStore = () => {
  const s = useContext(Ctx)
  if (!s) throw new Error('useStore outside provider')
  return s
}

const minutesFor = (mode: TimerMode, s: Settings) => (mode === 'focus' ? s.focusMin : mode === 'short' ? s.shortMin : s.longMin)
const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

export function AppProvider({ initial, onLoggedOut, children }: { initial: AppState; onLoggedOut: () => void; children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const toast = useCallback((text: string, action?: Toast['action']) => {
    const id = uid()
    setToasts(t => [...t.slice(-2), { id, text, action }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), action ? 12000 : 4200)
  }, [])

  // one "couldn't save" message at a time, not one per failed request
  const lastSaveError = useRef(0)
  const onSaveError = useCallback((e: unknown) => {
    if (e instanceof ApiError && e.status === 401) return // handled by the unauthorized listener
    if (Date.now() - lastSaveError.current < 8000) return
    lastSaveError.current = Date.now()
    toast(`Couldn't save: ${errMsg(e)}`)
  }, [toast])

  // ---- account data, mirrored to the server ----
  const [settings, setSettingsRaw] = useSyncedValue<Settings>(
    { ...DEFAULT_SETTINGS, ...initial.settings },
    (v, keepalive) => api('/api/me/settings', { method: 'PUT', body: { settings: v }, keepalive }),
    onSaveError,
  )
  const [profile, setProfileRaw] = useSyncedValue<Profile>(
    { ...DEFAULT_PROFILE, ...initial.profile },
    (v, keepalive) => (v.name.trim() ? api('/api/me/profile', { method: 'PUT', body: v, keepalive }) : Promise.resolve()),
    onSaveError,
  )
  const [whiteboard, setWhiteboardRaw] = useSyncedValue<string | null>(
    initial.whiteboard,
    (v, keepalive) => api('/api/me/whiteboard', { method: 'PUT', body: { data: v }, keepalive }),
    onSaveError,
    1500,
  )
  const [tasks, setTasks] = useSyncedList<Task>('tasks', initial.tasks, onSaveError)
  const [notes, setNotes] = useSyncedList<Note>('notes', initial.notes, onSaveError)
  const [sessions, setSessions] = useSyncedList<Session>('sessions', initial.sessions, onSaveError)

  const setSettings = useCallback((fn: (s: Settings) => Settings) => setSettingsRaw(fn), [setSettingsRaw])
  const setProfile = useCallback((fn: (p: Profile) => Profile) => setProfileRaw(fn), [setProfileRaw])
  const setWhiteboard = useCallback((v: string | null) => setWhiteboardRaw(() => v), [setWhiteboardRaw])

  // sound volumes are a per-device preference, so they stay in this browser
  const [mixVols, setMixVols] = useStored<SoundMix>('mix', DEFAULT_MIX)
  const [focusMode, setFocusMode] = useState(false)
  // "on" state is never restored: audio must start from a click
  const [mix, setMix] = useState<SoundMix>(() => {
    const m = { ...DEFAULT_MIX, ...mixVols }
    ;(Object.keys(m) as SoundId[]).forEach(k => { m[k] = { ...m[k], on: false } })
    return m
  })

  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // ---- sounds ----
  useEffect(() => { engine.setMaster(settings.masterVolume) }, [settings.masterVolume])
  const setSound = useCallback((id: SoundId, patch: Partial<{ on: boolean; vol: number }>) => {
    setMix(m => {
      const next = { ...m, [id]: { ...m[id], ...patch } }
      engine.set(id, next[id].on, next[id].vol)
      return next
    })
    if (patch.vol != null) setMixVols(m => ({ ...m, [id]: { on: false, vol: patch.vol! } }))
  }, [setMixVols])
  useEffect(() => () => engine.stopAll(), [])
  const anySoundOn = Object.values(mix).some(v => v.on)
  const mixRef = useRef(mix)
  mixRef.current = mix

  // ---- timer ----
  const [timer, setTimer] = useState<TimerState>(() => {
    const total = settings.focusMin * 60_000
    return { mode: 'focus', running: false, endsAt: null, remaining: total, total, cycle: 0, subject: profile.favSubject || 'General' }
  })
  const [now, setNow] = useState(() => Date.now())
  const timerRef = useRef(timer)
  timerRef.current = timer

  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), timer.running ? 250 : 1000)
    return () => clearInterval(iv)
  }, [timer.running])

  // keep an idle, untouched timer in sync with duration settings
  useEffect(() => {
    setTimer(t => {
      if (t.running || t.remaining !== t.total) return t
      const total = minutesFor(t.mode, settings) * 60_000
      return { ...t, total, remaining: total }
    })
  }, [settings.focusMin, settings.shortMin, settings.longMin])

  const notify = useCallback((text: string) => {
    const s = settingsRef.current
    if (s.chime) engine.chime()
    if (s.notifyInApp) toast(text)
    if (s.notifyBrowser && 'Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Lo-Fi Study Space', { body: text }) } catch { /* not allowed in this frame */ }
    }
  }, [toast])

  const complete = useCallback(() => {
    const t = timerRef.current
    const s = settingsRef.current
    let nextMode: TimerMode = 'focus'
    let cycle = t.cycle
    if (t.mode === 'focus') {
      const minutes = Math.max(1, Math.round(t.total / 60_000))
      setSessions(list => [...list, { id: uid(), date: dayKey(), start: Date.now() - t.total, minutes, subject: t.subject || 'General' }])
      cycle += 1
      nextMode = cycle % s.longEvery === 0 ? 'long' : 'short'
      notify(nextMode === 'long' ? `Focus done. Take a ${s.longMin} minute long break.` : `Focus done. Take ${s.shortMin} minutes.`)
    } else {
      if (t.mode === 'long') cycle = 0
      notify('Break over. Back to the desk.')
    }
    const total = minutesFor(nextMode, s) * 60_000
    const run = s.autoStartNext
    setTimer({ ...t, mode: nextMode, cycle, total, remaining: total, running: run, endsAt: run ? Date.now() + total : null })
  }, [notify, setSessions])

  useEffect(() => {
    if (timer.running && timer.endsAt && now >= timer.endsAt) complete()
  }, [now, timer.running, timer.endsAt, complete])

  const timeLeft = timer.running && timer.endsAt ? Math.max(0, timer.endsAt - now) : timer.remaining

  const startTimer = useCallback(() => {
    const t = timerRef.current
    if (t.running) return
    setTimer({ ...t, running: true, endsAt: Date.now() + t.remaining })
    const s = settingsRef.current
    if (t.mode === 'focus' && s.autoSound && !Object.values(mixRef.current).some(v => v.on)) {
      setSound(s.theme === 'coffee' ? 'cafe' : s.theme === 'library' ? 'library' : s.theme === 'sunset' ? 'lofi' : 'rain', { on: true })
    }
    if (s.notifyBrowser && 'Notification' in window && Notification.permission === 'default') {
      try { void Notification.requestPermission() } catch { /* ignore */ }
    }
  }, [setSound])
  const pauseTimer = useCallback(() => {
    const t = timerRef.current
    if (!t.running || !t.endsAt) return
    setTimer({ ...t, running: false, endsAt: null, remaining: Math.max(0, t.endsAt - Date.now()) })
  }, [])
  const resetTimer = useCallback(() => {
    const t = timerRef.current
    setTimer({ ...t, running: false, endsAt: null, remaining: t.total })
  }, [])
  const setMode = useCallback((mode: TimerMode) => {
    const total = minutesFor(mode, settingsRef.current) * 60_000
    setTimer(t => ({ ...t, mode, running: false, endsAt: null, total, remaining: total }))
  }, [])
  const skipTimer = useCallback(() => {
    const t = timerRef.current
    const s = settingsRef.current
    let next: TimerMode = 'focus'
    let cycle = t.cycle
    if (t.mode === 'focus') { next = (cycle + 1) % s.longEvery === 0 ? 'long' : 'short'; cycle += 1 }
    else if (t.mode === 'long') cycle = 0
    const total = minutesFor(next, s) * 60_000
    setTimer({ ...t, mode: next, cycle, total, remaining: total, running: false, endsAt: null })
  }, [])
  const setSubject = useCallback((subject: string) => setTimer(t => ({ ...t, subject })), [])

  const today = dayKey(now)
  const sessionsToday = useMemo(() => sessions.filter(s => s.date === today).length, [sessions, today])

  useEffect(() => { document.documentElement.dataset.env = settings.env }, [settings.env])

  // ---- live connection (Socket.IO) ----
  const socketRef = useRef<Socket | null>(null)
  const [connected, setConnected] = useState(false)
  const [rooms, setRooms] = useState<StudyRoom[]>([])
  const offsetRef = useRef(0) // serverTime - localTime
  const [friends, setFriends] = useState<FriendsData>({ friends: [], incoming: [], outgoing: [] })
  const [friendsLoaded, setFriendsLoaded] = useState(false)

  const refreshFriends = useCallback(async () => {
    try {
      setFriends(await api<FriendsData>('/api/friends'))
      setFriendsLoaded(true)
    } catch (e) { onSaveError(e) }
  }, [onSaveError])

  const emit = useCallback(<T extends object>(event: string, payload?: object) => new Promise<T>((resolve, reject) => {
    const s = socketRef.current
    if (!s?.connected) return reject(new Error('Not connected to the server yet. Try again in a moment.'))
    s.timeout(8000).emit(event, payload ?? {}, (err: Error | null, res: { ok: boolean; error?: string } & T) => {
      if (err) reject(new Error('The server did not respond. Try again.'))
      else if (!res.ok) reject(new Error(res.error || 'Something went wrong'))
      else resolve(res)
    })
  }), [])

  const joinRoomRef = useRef<(id: string) => Promise<void>>(async () => {})

  useEffect(() => {
    // VITE_SOCKET_URL is set only when the frontend is hosted apart from the API (e.g. on Vercel)
    const socketUrl = import.meta.env.VITE_SOCKET_URL as string | undefined
    const opts = {
      transports: ['websocket', 'polling'],
      // fetch a fresh short-lived token on every (re)connect
      auth: (cb: (data: object) => void) => {
        api<{ token: string }>('/api/auth/socket-token').then(r => cb({ token: r.token }), () => cb({}))
      },
    }
    const s = socketUrl ? io(socketUrl, opts) : io(opts)
    socketRef.current = s
    s.on('connect', () => setConnected(true))
    s.on('disconnect', () => setConnected(false))
    s.on('connect_error', err => { if (err.message === 'unauthorized') window.dispatchEvent(new Event('lofi:unauthorized')) })
    s.on('auth:expired', () => window.dispatchEvent(new Event('lofi:unauthorized')))
    s.on('hello', ({ serverTime }: { serverTime: number }) => { offsetRef.current = serverTime - Date.now() })
    s.on('rooms', ({ rooms, serverTime }: { rooms: StudyRoom[]; serverTime: number }) => {
      offsetRef.current = serverTime - Date.now()
      setRooms(rooms)
    })
    s.on('presence', (p: { userId: string; online: boolean; roomId: string | null; subject: string | null; studying: boolean }) => {
      setFriends(f => ({ ...f, friends: f.friends.map(fr => (fr.id === p.userId ? { ...fr, online: p.online, roomId: p.roomId, subject: p.subject, studying: p.studying } : fr)) }))
    })
    s.on('friends:changed', () => { void refreshFriends() })
    s.on('invite', (inv: { from: { name: string }; roomId: string; subject?: string }) => {
      if (settingsRef.current.chime) engine.chime()
      toast(`${inv.from.name} invited you to study${inv.subject ? ` ${inv.subject}` : ''}.`, {
        label: 'Join',
        run: () => { void joinRoomRef.current(inv.roomId) },
      })
    })
    void refreshFriends()
    return () => { s.removeAllListeners(); s.disconnect(); socketRef.current = null }
  }, [refreshFriends, toast])

  // share my timer with the room and my friends whenever it changes
  useEffect(() => {
    if (!connected) return
    const t = timer
    const remaining = t.running && t.endsAt ? Math.max(0, t.endsAt - Date.now()) : t.remaining
    socketRef.current?.emit('status', { mode: t.mode, running: t.running, remaining, total: t.total, subject: t.subject })
  }, [connected, timer])

  const myRoom = useMemo(() => rooms.find(r => r.members.some(m => m.id === initial.user.id)) ?? null, [rooms, initial.user.id])

  const createRoom = useCallback(async (subject: string) => (await emit<{ roomId: string }>('room:create', { subject })).roomId, [emit])
  const joinRoom = useCallback(async (id: string) => {
    try { await emit('room:join', { roomId: id }) } catch (e) { toast(errMsg(e)); throw e }
  }, [emit, toast])
  joinRoomRef.current = async (id: string) => { await joinRoom(id).catch(() => {}) }
  const leaveRoom = useCallback(async () => { await emit('room:leave') }, [emit])
  const inviteFriend = useCallback(async (id: string) => { await emit('invite', { toUserId: id }) }, [emit])

  const sendFriendRequest = useCallback(async (username: string) => {
    const r = await api<{ status: 'pending' | 'accepted'; name: string }>('/api/friends/requests', { body: { username } })
    await refreshFriends()
    return r.status === 'accepted' ? `You and ${r.name} are now friends.` : `Friend request sent to ${r.name}.`
  }, [refreshFriends])
  const acceptFriend = useCallback(async (id: string) => { await api(`/api/friends/${id}/accept`, { method: 'POST' }); await refreshFriends() }, [refreshFriends])
  const removeFriend = useCallback(async (id: string) => { await api(`/api/friends/${id}`, { method: 'DELETE' }); await refreshFriends() }, [refreshFriends])

  const serverNow = useCallback(() => Date.now() + offsetRef.current, [])

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {})
    onLoggedOut()
  }, [onLoggedOut])
  const deleteAccount = useCallback(async (password: string) => {
    await api('/api/me', { method: 'DELETE', body: { password } })
    onLoggedOut()
  }, [onLoggedOut])

  const value: Store = {
    account: initial.user, logout, deleteAccount,
    settings, setSettings, profile, setProfile, tasks, setTasks, notes, setNotes, sessions, setSessions,
    mix, setSound, anySoundOn, timer, now, timeLeft, startTimer, pauseTimer, resetTimer, skipTimer, setMode, setSubject,
    sessionsToday, toasts, toast, focusMode, setFocusMode, whiteboard, setWhiteboard,
    connected, serverNow, rooms, myRoom, createRoom, joinRoom, leaveRoom,
    friends, friendsLoaded, refreshFriends, sendFriendRequest, acceptFriend, removeFriend, inviteFriend,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
