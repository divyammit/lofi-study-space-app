import { useState } from 'react'
import { useStore } from '../lib/store'
import { computeStats } from '../lib/stats'
import { fmtClock, greeting } from '../lib/dates'
import PixelIcon from './PixelIcon'

export default function HomeCard({ onOpenTasks, onOpenTimer }: { onOpenTasks: () => void; onOpenTimer: () => void }) {
  const { profile, setProfile, tasks, setTasks, sessions, timer, timeLeft, startTimer, pauseTimer, now } = useStore()
  const [nameDraft, setNameDraft] = useState('')
  const stats = computeStats(sessions, tasks)
  const d = new Date(now)
  const open = tasks.filter(t => t.status !== 'done')
  const done = tasks.length - open.length

  return (
    <section className="px-panel w-full p-4 md:w-[340px]" aria-label="Today">
      {profile.name ? (
        <h1 className="font-title text-[22px] leading-tight">{greeting(d)}, {profile.name}</h1>
      ) : (
        <form className="flex flex-col gap-2" onSubmit={e => { e.preventDefault(); if (nameDraft.trim()) setProfile(p => ({ ...p, name: nameDraft.trim() })) }}>
          <h1 className="font-title text-[20px] leading-tight">Welcome to your study room</h1>
          <div className="flex gap-2">
            <input className="px-input" placeholder="What should I call you?" value={nameDraft} onChange={e => setNameDraft(e.target.value)} aria-label="Your name" maxLength={24} />
            <button className="px-solid shrink-0" type="submit">Save</button>
          </div>
        </form>
      )}
      <div className="mt-1 flex items-center justify-between text-muted">
        <span>{d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · {d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>
        <span className="flex items-center gap-1 text-amber" title="Current study streak">
          <PixelIcon name="flame" size={16} /> {stats.currentStreak}d
        </span>
      </div>

      <div className="mt-3 hidden sm:block">
        <button className="flex w-full items-baseline justify-between text-left hover:text-amber" onClick={onOpenTasks}>
          <span>Today's tasks</span>
          <span className="text-muted">{done}/{tasks.length}</span>
        </button>
        <ul className="mt-1 flex flex-col gap-1">
          {open.slice(0, 3).map(t => (
            <li key={t.id}>
              <button className="flex w-full gap-2 text-left hover:text-amber" onClick={() => setTasks(ts => ts.map(x => x.id === t.id ? { ...x, status: 'done', completedAt: Date.now() } : x))} aria-label={`Mark "${t.title}" as done`}>
                <span className="shrink-0 whitespace-nowrap text-amber">[ ]</span><span className="truncate">{t.title}</span>
              </button>
            </li>
          ))}
          {open.length === 0 && <li className="text-muted">All clear. Add something to the board.</li>}
          {open.length > 3 && <li className="text-muted">+{open.length - 3} more</li>}
        </ul>
      </div>

      <button className="mt-3 flex w-full items-center justify-between border-t-2 border-line pt-2 text-left hover:text-amber" onClick={onOpenTimer}>
        <span className="text-muted">{timer.mode === 'focus' ? 'Focus' : timer.mode === 'short' ? 'Short break' : 'Long break'} · {timer.running ? 'running' : timeLeft === timer.total ? 'ready' : 'paused'}</span>
        <span className="font-title text-[20px]">{fmtClock(timeLeft)}</span>
      </button>

      {timer.running
        ? <button className="px-solid mt-3 w-full !py-2 text-[24px]" onClick={pauseTimer}>Pause session</button>
        : <button className="px-solid px-primary mt-3 w-full !py-2 text-[24px]" onClick={startTimer}>{timeLeft === timer.total ? (timer.mode === 'focus' ? 'Start study' : 'Start break') : 'Resume'}</button>}
    </section>
  )
}
