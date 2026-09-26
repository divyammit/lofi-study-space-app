import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from './lib/api'
import type { AppState } from './lib/types'
import AuthScreen from './components/AuthScreen'
import { AppProvider, useStore } from './lib/store'
import { useStored } from './lib/storage'
import type { PanelId } from './lib/types'
import { fmtClock } from './lib/dates'
import RoomScene from './scene/RoomScene'
import Dock from './components/Dock'
import HomeCard from './components/HomeCard'
import BottomBar from './components/BottomBar'
import FocusMode from './components/FocusMode'
import TimerPanel from './components/panels/TimerPanel'
import TasksPanel from './components/panels/TasksPanel'
import NotesPanel from './components/panels/NotesPanel'
import WhiteboardPanel from './components/panels/WhiteboardPanel'
import SoundsPanel from './components/panels/SoundsPanel'
import StatsPanel from './components/panels/StatsPanel'
import StreetPanel from './components/panels/StreetPanel'
import FriendsPanel from './components/panels/FriendsPanel'
import ProfilePanel from './components/panels/ProfilePanel'
import SettingsPanel from './components/panels/SettingsPanel'

function Room() {
  const { settings, timer, timeLeft, focusMode, setFocusMode, startTimer, toasts, connected } = useStore()
  const [panel, setPanel] = useState<PanelId | null>(null)
  const [focusAutoStart, setFocusAutoStart] = useStored('focusAutoStart', true)
  const focusing = timer.running && timer.mode === 'focus'
  // only show "reconnecting" if the connection stays down for a moment
  const [showOffline, setShowOffline] = useState(false)
  useEffect(() => {
    if (connected) { setShowOffline(false); return }
    const t = setTimeout(() => setShowOffline(true), 2500)
    return () => clearTimeout(t)
  }, [connected])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !focusMode) setPanel(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusMode])

  const toggle = (p: PanelId) => setPanel(cur => (cur === p ? null : p))
  const close = () => setPanel(null)
  const enterFocus = () => {
    setPanel(null)
    setFocusMode(true)
    if (focusAutoStart && !timer.running) startTimer()
  }

  const panels: Record<PanelId, React.ReactNode> = {
    timer: <TimerPanel onClose={close} />,
    tasks: <TasksPanel onClose={close} />,
    notes: <NotesPanel onClose={close} />,
    board: <WhiteboardPanel onClose={close} />,
    sounds: <SoundsPanel onClose={close} />,
    stats: <StatsPanel onClose={close} />,
    street: <StreetPanel onClose={close} />,
    friends: <FriendsPanel onClose={close} openStreet={() => setPanel('street')} />,
    profile: <ProfilePanel onClose={close} />,
    settings: <SettingsPanel onClose={close} />,
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      <RoomScene theme={settings.theme} light={settings.env === 'light'} animation={settings.animation} dim={focusing || focusMode} />

      {focusMode ? (
        <FocusMode onExit={() => setFocusMode(false)} autoStart={focusAutoStart} setAutoStart={setFocusAutoStart} />
      ) : (
        <div className="pointer-events-none absolute inset-0 flex flex-col">
          {/* top bar */}
          <header className="pointer-events-auto flex flex-col gap-1 px-4 pt-3 md:flex-row md:items-start md:justify-between md:px-6 md:pt-4">
            <div className="flex items-center justify-between gap-3">
              <div className="font-title text-[22px] text-[#ece3d0] md:text-[28px]" style={{ textShadow: '2px 2px 0 rgba(0,0,0,.6)' }}>Lo-Fi Study Space</div>
              {focusing && (
                <div className="flex items-center gap-2 bg-black/50 px-3 py-1 text-[#ece3d0]" role="status">
                  <span className="blink text-[#e8707e]">●</span> Focus session · {fmtClock(timeLeft)}
                </div>
              )}
            </div>
            <div className="bg-black/35 px-1">
              <Dock active={panel} onPick={toggle} onFocus={enterFocus} />
            </div>
          </header>

          {/* main area */}
          <div className="relative min-h-0 flex-1">
            <div className={`pointer-events-auto absolute right-3 bottom-3 left-3 transition-opacity duration-500 md:right-auto md:left-6 md:bottom-4 ${panel ? 'hidden md:block' : ''} ${focusing && panel ? 'md:opacity-40 md:hover:opacity-100' : ''}`}>
              <HomeCard onOpenTasks={() => setPanel('tasks')} onOpenTimer={() => setPanel('timer')} />
            </div>
            {panel && (
              <div key={panel} className="pointer-events-auto absolute inset-x-2 top-2 bottom-2 flex justify-end md:inset-x-auto md:top-3 md:right-6 md:bottom-4">
                {panels[panel]}
              </div>
            )}
          </div>

          <BottomBar dim={focusing} />
        </div>
      )}

      {showOffline && (
        <div className="pointer-events-none absolute bottom-14 left-1/2 z-40 -translate-x-1/2 bg-black/60 px-3 py-1 text-[#ece3d0]" role="status">
          Reconnecting to the server<span className="blink">…</span>
        </div>
      )}

      {/* toasts */}
      <div className="pointer-events-none absolute top-20 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className="px-panel panel-in pointer-events-auto flex items-center gap-3 px-4 py-2 text-center">
            <span>{t.text}</span>
            {t.action && <button className="px-solid px-primary !py-1" onClick={t.action.run}>{t.action.label}</button>}
          </div>
        ))}
      </div>
    </div>
  )
}

type Phase = 'loading' | 'auth' | 'offline' | 'app'

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [state, setState] = useState<AppState | null>(null)
  const [problem, setProblem] = useState('')

  const load = useCallback(() => {
    setPhase('loading')
    api<AppState>('/api/auth/me')
      .then(s => { setState(s); setPhase('app') })
      .catch(e => {
        if (e instanceof ApiError && e.status === 401) return setPhase('auth')
        // describe what failed, so a broken deployment is easy to diagnose
        const status = e instanceof ApiError ? e.status : 0
        setProblem(
          status === 0 ? 'No response from /api (network error or the server is down).'
          : status === 404 ? '/api returned 404: the frontend is not forwarding API requests to the backend. Check the Render address in vercel.json.'
          : status >= 500 ? `/api returned ${status}: the backend is down, starting up, or can't reach its database. Check the server logs.`
          : `/api returned ${status}: ${e.message}`,
        )
        setPhase('offline')
      })
  }, [])
  useEffect(load, [load])

  const loggedOut = useCallback(() => { setState(null); setPhase('auth') }, [])
  useEffect(() => {
    window.addEventListener('lofi:unauthorized', loggedOut)
    return () => window.removeEventListener('lofi:unauthorized', loggedOut)
  }, [loggedOut])

  if (phase === 'auth') return <AuthScreen onAuthed={s => { setState(s); setPhase('app') }} />
  if (phase === 'app' && state) {
    return (
      <AppProvider key={state.user.id} initial={state} onLoggedOut={loggedOut}>
        <Room />
      </AppProvider>
    )
  }
  return (
    <div className="relative h-full w-full overflow-hidden">
      <RoomScene theme="rainy" light={false} animation="low" dim />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        <div className="px-panel max-w-sm p-5 text-center" role="status">
          {phase === 'offline' ? (
            <>
              <p className="font-title text-[20px]">Can&rsquo;t reach the server</p>
              <p className="mt-2 text-muted">Check your connection. If you just deployed, the server may still be waking up (up to a minute on free hosting).</p>
              {problem && <p className="mt-2 border-t-2 border-line pt-2 text-left text-[17px] text-muted">Details: {problem}</p>}
              <button className="px-solid px-primary mt-4" onClick={load}>Try again</button>
            </>
          ) : (
            <p className="font-title text-[20px]">Opening your room<span className="blink">…</span></p>
          )}
        </div>
      </div>
    </div>
  )
}
