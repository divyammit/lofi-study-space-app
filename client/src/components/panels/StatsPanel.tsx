import { useMemo } from 'react'
import { useStore } from '../../lib/store'
import { computeStats } from '../../lib/stats'
import { WEEKDAYS, WEEKDAYS_LONG, dayKey, fmtHours, mondayIndex } from '../../lib/dates'
import { Panel, BlockBar, SectionTitle } from '../ui'
import PixelIcon from '../PixelIcon'

export default function StatsPanel({ onClose }: { onClose: () => void }) {
  const { sessions, setSessions, tasks, settings, toast } = useStore()
  const now = new Date()
  const st = useMemo(() => computeStats(sessions, tasks, now), [sessions, tasks])
  const hasSample = sessions.some(s => s.sample)

  const year = now.getFullYear(), month = now.getMonth()
  const first = new Date(year, month, 1)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const lead = mondayIndex(first)
  const todayKey = dayKey(now)
  const maxWeek = Math.max(60, ...st.week)
  const monthHours = st.monthMinutes / 60
  const totalHours = st.totalMinutes / 60

  const badges = [
    { name: 'First session', need: 'Finish one focus session', ok: st.sessions >= 1 },
    { name: 'Productivity pro', need: '30h of focus this month', ok: monthHours >= 30 },
    { name: 'Focus master', need: '50h of focus this month', ok: monthHours >= 50 },
    { name: 'Silver streak', need: '15 days in a row', ok: st.bestStreak >= 15 },
    { name: 'Gold streak', need: '30 days in a row', ok: st.bestStreak >= 30 },
    { name: 'Century', need: '100h total', ok: totalHours >= 100 },
  ]

  return (
    <Panel title="Productivity analytics" onClose={onClose} wide>
      <p className="text-muted">{now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}. See where your focus time goes.</p>

      <div className="mt-3 grid gap-4 md:grid-cols-[auto_1fr]">
        <div className="flex flex-col justify-center px-2 md:items-center">
          <div className="font-title text-[64px] leading-none md:text-[76px]">{monthHours < 10 ? monthHours.toFixed(1) : Math.round(monthHours)}</div>
          <div className="font-title text-[22px]">hours</div>
          <div className="text-muted">studied this month</div>
        </div>
        <div>
          <div className="grid grid-cols-7 gap-[3px] text-center text-[15px] text-muted">
            {WEEKDAYS.map(d => <div key={d}>{d.slice(0, 2)}</div>)}
          </div>
          <div className="mt-1 grid grid-cols-7 gap-[3px]">
            {Array.from({ length: lead }, (_, i) => <div key={`b${i}`} />)}
            {Array.from({ length: daysInMonth }, (_, i) => {
              const key = dayKey(new Date(year, month, i + 1))
              const m = st.byDay.get(key) ?? 0
              const inStreak = st.streakDays.has(key)
              const future = key > todayKey
              return (
                <div
                  key={key}
                  className={`relative h-10 bg-card p-[2px] text-[14px] leading-none ${key === todayKey ? 'outline-2 outline-amber' : ''} ${future ? 'opacity-40' : ''}`}
                  title={`${key}: ${fmtHours(m)}`}
                >
                  <span className={inStreak ? 'text-amber' : 'text-muted'}>{i + 1}</span>
                  {m > 0 && <span className="absolute right-[3px] bottom-[5px] left-[3px] bg-dusk" style={{ height: Math.max(3, Math.min(22, (m / 180) * 22)) }} />}
                  {inStreak && <span className="absolute right-0 bottom-0 left-0 h-[3px] bg-amber" />}
                </div>
              )
            })}
          </div>
          <p className="mt-1 text-[15px] text-muted"><span className="text-amber">▬</span> current streak · <span className="text-dusk">█</span> study time</p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ['Current streak', `${st.currentStreak} day${st.currentStreak === 1 ? '' : 's'}`],
          ['Best streak', `${st.bestStreak} days`],
          ['Sessions', String(st.sessions)],
          ['Tasks done', String(st.tasksDone)],
        ].map(([k, v]) => (
          <div key={k} className="px-card px-3 py-2">
            <div className="text-[17px] text-muted">{k}</div>
            <div className="font-title text-[22px]">{v}</div>
          </div>
        ))}
      </div>

      <SectionTitle>This week</SectionTitle>
      <div className="flex h-36 items-end gap-2" role="img" aria-label={`Study time this week: ${st.week.map((m, i) => `${WEEKDAYS[i]} ${fmtHours(m)}`).join(', ')}`}>
        {st.week.map((m, i) => (
          <div key={i} className="flex h-full flex-1 flex-col items-center justify-end gap-1">
            <span className="text-[15px] text-muted">{m ? fmtHours(m) : ''}</span>
            <div className={`w-full ${i === mondayIndex(now) ? 'bg-amber' : 'bg-dusk'}`} style={{ height: `${(m / maxWeek) * 80}%`, minHeight: m ? 4 : 2, opacity: m ? 1 : 0.3 }} />
            <span className="text-[16px]">{WEEKDAYS[i]}</span>
          </div>
        ))}
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <div className="px-card p-3">
          <div className="text-[17px] text-muted">Today</div>
          <div className="font-title text-[20px]">{fmtHours(st.todayMinutes)} <span className="text-[14px] text-muted">/ {fmtHours(settings.dailyGoalMin)}</span></div>
          <BlockBar value={st.todayMinutes / settings.dailyGoalMin} blocks={10} className="mt-2" />
        </div>
        <div className="px-card p-3">
          <div className="text-[17px] text-muted">Most productive day</div>
          <div className="font-title text-[20px]">{st.bestWeekday == null ? '—' : WEEKDAYS_LONG[st.bestWeekday]}</div>
        </div>
        <div className="px-card p-3">
          <div className="text-[17px] text-muted">Most studied subject</div>
          <div className="font-title text-[20px]">{st.topSubject ?? '—'}</div>
        </div>
      </div>

      <SectionTitle>Achievements</SectionTitle>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {badges.map(b => (
          <li key={b.name} className={`px-card flex items-center gap-2 p-2 ${b.ok ? '' : 'opacity-50'}`}>
            <PixelIcon name={b.ok ? 'medal' : 'lock'} size={26} className={b.ok ? 'text-amber' : 'text-muted'} />
            <span className="leading-tight">
              <span className="block">{b.name}</span>
              <span className="block text-[15px] text-muted">{b.ok ? 'Unlocked' : b.need}</span>
            </span>
          </li>
        ))}
      </ul>

      {hasSample && (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t-2 border-line pt-3 text-[17px] text-muted">
          <span>Includes sample history so the charts have something to show.</span>
          <button className="px-btn" onClick={() => { setSessions(s => s.filter(x => !x.sample)); toast('Sample history removed. Only your sessions remain.') }}>[x] Clear sample data</button>
        </div>
      )}
    </Panel>
  )
}
