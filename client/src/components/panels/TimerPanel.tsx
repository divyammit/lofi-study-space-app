import { useStore, type TimerMode } from '../../lib/store'
import { fmtClock } from '../../lib/dates'
import { Panel, BlockBar, Seg } from '../ui'
import PixelIcon from '../PixelIcon'
import { SUBJECTS } from '../../lib/defaults'

const MODES: { value: TimerMode; label: string }[] = [
  { value: 'focus', label: 'Focus' },
  { value: 'short', label: 'Short break' },
  { value: 'long', label: 'Long break' },
]

export default function TimerPanel({ onClose }: { onClose: () => void }) {
  const { timer, timeLeft, startTimer, pauseTimer, resetTimer, skipTimer, setMode, setSubject, settings, setSettings, sessionsToday } = useStore()
  const elapsed = 1 - timeLeft / timer.total
  const [mm, ss] = fmtClock(timeLeft).split(':')
  const numberField = (key: 'focusMin' | 'shortMin' | 'longMin', label: string) => (
    <label className="flex flex-col gap-1">
      <span className="text-muted">{label}</span>
      <input
        type="number"
        min={1}
        max={180}
        className="px-input"
        value={settings[key]}
        onChange={e => {
          const v = Math.max(1, Math.min(180, Number(e.target.value) || 1))
          setSettings(s => ({ ...s, [key]: v }))
        }}
      />
    </label>
  )

  return (
    <Panel title="Pomodoro timer" onClose={onClose}>
      <Seg label="Timer mode" value={timer.mode} options={MODES} onChange={setMode} />

      <div className="px-card mt-4 flex flex-col items-center px-4 py-5">
        <div className="flex items-end gap-2 font-title leading-none" aria-live="off">
          <div className="flex flex-col items-center">
            <span className="text-[64px] md:text-[80px]">{mm}</span>
            <span className="text-[14px] text-muted">min</span>
          </div>
          <span className={`pb-6 text-[56px] md:text-[70px] ${timer.running ? 'blink' : ''}`}>:</span>
          <div className="flex flex-col items-center">
            <span className="text-[64px] md:text-[80px]">{ss}</span>
            <span className="text-[14px] text-muted">sec</span>
          </div>
        </div>
        <p className="mt-2 text-muted">
          {timer.mode === 'focus' ? (timer.running ? 'Focus session in progress' : 'Ready when you are') : timer.running ? 'Break time. Stretch, drink water.' : 'Break paused'}
        </p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          {timer.running
            ? <button className="px-solid px-primary flex items-center gap-2 !px-5" onClick={pauseTimer}><PixelIcon name="pause" size={16} />Pause</button>
            : <button className="px-solid px-primary flex items-center gap-2 !px-5" onClick={startTimer}><PixelIcon name="play" size={16} />Start</button>}
          <button className="px-solid flex items-center gap-2" onClick={resetTimer}><PixelIcon name="reset" size={16} />Reset</button>
          <button className="px-solid flex items-center gap-2" onClick={skipTimer}><PixelIcon name="skip" size={16} />Skip</button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <BlockBar value={elapsed} className="flex-1" />
        <span className="w-24 text-right">{Math.round(elapsed * 100)}% done</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="px-card px-3 py-2">
          <div className="text-muted">Sessions today</div>
          <div className="font-title text-[26px]">{sessionsToday}</div>
        </div>
        <div className="px-card px-3 py-2">
          <div className="text-muted">Until long break</div>
          <div className="font-title text-[26px]">{settings.longEvery - (timer.cycle % settings.longEvery)}</div>
        </div>
      </div>

      <label className="mt-4 flex flex-col gap-1">
        <span className="text-muted">Studying</span>
        <input className="px-input" list="subjects" value={timer.subject} onChange={e => setSubject(e.target.value)} placeholder="Subject for this session" />
        <datalist id="subjects">{SUBJECTS.map(s => <option key={s} value={s} />)}</datalist>
      </label>

      <details className="mt-4">
        <summary className="cursor-pointer text-muted hover:text-amber">Custom durations (minutes)</summary>
        <div className="mt-2 grid grid-cols-3 gap-3">
          {numberField('focusMin', 'Focus')}
          {numberField('shortMin', 'Short')}
          {numberField('longMin', 'Long')}
        </div>
      </details>
    </Panel>
  )
}
