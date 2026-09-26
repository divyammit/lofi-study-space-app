import type { Session, Task } from './types'
import { addDays, dayKey, mondayIndex, parseDay } from './dates'

export interface Stats {
  byDay: Map<string, number>
  monthMinutes: number
  totalMinutes: number
  sessions: number
  tasksDone: number
  currentStreak: number
  bestStreak: number
  todayMinutes: number
  week: number[] // Mon..Sun minutes, current week
  bestWeekday: number | null // 0 = Mon
  topSubject: string | null
  streakDays: Set<string>
}

export function computeStats(sessions: Session[], tasks: Task[], now = new Date()): Stats {
  const byDay = new Map<string, number>()
  const bySubject = new Map<string, number>()
  const byWeekday = new Array(7).fill(0)
  const monthPrefix = dayKey(now).slice(0, 7)
  let monthMinutes = 0
  let totalMinutes = 0
  for (const s of sessions) {
    byDay.set(s.date, (byDay.get(s.date) ?? 0) + s.minutes)
    bySubject.set(s.subject, (bySubject.get(s.subject) ?? 0) + s.minutes)
    byWeekday[mondayIndex(parseDay(s.date))] += s.minutes
    totalMinutes += s.minutes
    if (s.date.startsWith(monthPrefix)) monthMinutes += s.minutes
  }

  // current streak: count back from today (or yesterday if today has no study yet)
  const streakDays = new Set<string>()
  let cursor = new Date(now)
  if (!byDay.has(dayKey(cursor))) cursor = addDays(cursor, -1)
  let currentStreak = 0
  while (byDay.has(dayKey(cursor))) {
    streakDays.add(dayKey(cursor))
    currentStreak++
    cursor = addDays(cursor, -1)
  }

  // best streak over all history
  const days = [...byDay.keys()].sort()
  let bestStreak = 0
  let run = 0
  let prev: Date | null = null
  for (const k of days) {
    const d = parseDay(k)
    run = prev && dayKey(addDays(prev, 1)) === k ? run + 1 : 1
    bestStreak = Math.max(bestStreak, run)
    prev = d
  }

  const monday = addDays(now, -mondayIndex(now))
  const week = Array.from({ length: 7 }, (_, i) => byDay.get(dayKey(addDays(monday, i))) ?? 0)

  const maxW = Math.max(...byWeekday)
  const bestWeekday = maxW > 0 ? byWeekday.indexOf(maxW) : null
  let topSubject: string | null = null
  let topMin = 0
  bySubject.forEach((m, s) => { if (m > topMin) { topMin = m; topSubject = s } })

  return {
    byDay,
    monthMinutes,
    totalMinutes,
    sessions: sessions.length,
    tasksDone: tasks.filter(t => t.status === 'done').length,
    currentStreak,
    bestStreak,
    todayMinutes: byDay.get(dayKey(now)) ?? 0,
    week,
    bestWeekday,
    topSubject,
    streakDays,
  }
}
