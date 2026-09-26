import { useEffect, useRef, useState } from 'react'
import { useStore } from '../lib/store'
import { fmtClock } from '../lib/dates'
import { Check } from './ui'
import PixelIcon from './PixelIcon'

export default function FocusMode({ onExit, autoStart, setAutoStart }: { onExit: () => void; autoStart: boolean; setAutoStart: (v: boolean) => void }) {
  const { timer, timeLeft, startTimer, pauseTimer, mix, setSound, settings } = useStore()
  const [locked, setLocked] = useState(false)
  const [leftCount, setLeftCount] = useState(0)
  const [hold, setHold] = useState(0)
  const holdRef = useRef(0)

  useEffect(() => {
    if (!locked) return
    const onVis = () => { if (document.hidden) setLeftCount(c => c + 1) }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [locked])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !locked) exit() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const exit = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    onExit()
  }
  const startHold = () => {
    const t0 = Date.now()
    holdRef.current = window.setInterval(() => {
      const p = Math.min(1, (Date.now() - t0) / 2000)
      setHold(p)
      if (p >= 1) { clearInterval(holdRef.current); setLocked(false); setHold(0); exit() }
    }, 50)
  }
  const endHold = () => { clearInterval(holdRef.current); setHold(0) }
  const ambient = settings.theme === 'coffee' ? 'cafe' : 'rain'

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-end p-4 pb-10">
      <div className="px-panel panel-in pointer-events-auto w-full max-w-md p-5 text-center">
        <div className="flex items-center justify-center gap-2 text-muted">
          {locked && <PixelIcon name="lock" size={16} className="text-amber" />}
          <span>{timer.mode === 'focus' ? 'Focus session' : 'Break'}{locked ? ' · distractions locked' : ''}</span>
        </div>
        <div className="font-title text-[72px] leading-none md:text-[88px]">{fmtClock(timeLeft)}</div>
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          {timer.running
            ? <button className="px-solid !px-6" onClick={pauseTimer}>Pause</button>
            : <button className="px-solid px-primary !px-6" onClick={startTimer}>Start</button>}
          <button className="px-solid" onClick={() => setSound(ambient, { on: !mix[ambient].on })} aria-pressed={mix[ambient].on}>
            {mix[ambient].on ? 'Sound on' : 'Sound off'}
          </button>
          <button className="px-solid" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>Full screen</button>
        </div>

        <div className="mt-4 flex flex-col items-start gap-2 border-t-2 border-line pt-3 text-left">
          <Check checked={locked} onChange={setLocked} label="Lock distractions on this page" />
          <Check checked={autoStart} onChange={setAutoStart} label="Start the timer when I enter focus mode" />
          {locked && (
            <p className="text-[17px] text-muted">
              Panels stay hidden until you hold the button below. This is a commitment aid inside this page only; it cannot block other sites or apps.
              {leftCount > 0 && <span className="block text-amber">You've left this tab {leftCount} time{leftCount > 1 ? 's' : ''} this session.</span>}
            </p>
          )}
        </div>

        {locked ? (
          <button
            className="px-solid relative mt-4 w-full overflow-hidden"
            onPointerDown={startHold}
            onPointerUp={endHold}
            onPointerLeave={endHold}
            onKeyDown={e => { if ((e.key === 'Enter' || e.key === ' ') && !hold) startHold() }}
            onKeyUp={endHold}
          >
            <span className="absolute inset-y-0 left-0 bg-amber/40" style={{ width: `${hold * 100}%` }} />
            <span className="relative">Hold for 2 seconds to exit</span>
          </button>
        ) : (
          <button className="px-btn mt-4 text-muted" onClick={exit}>[Esc] Exit focus mode</button>
        )}
      </div>
    </div>
  )
}
