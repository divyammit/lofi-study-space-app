import { q, ms } from './db.js'

/**
 * Everything about Free vs Pro lives here, so it's easy to change.
 * Limits and prices can be overridden with environment variables.
 */
const envInt = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isInteger(n) && n > 0 ? n : fallback
}

export const LIMITS = {
  free: { dailyQuestions: envInt('AI_FREE_DAILY', 10), attachments: false },
  // a fair-use cap even for Pro, so one account can't run up a huge AI bill
  pro: { dailyQuestions: envInt('AI_PRO_DAILY', 150), attachments: true },
}

/** Room themes that need Pro. 'rainy' always stays free. */
export const PRO_THEMES = ['library', 'coffee', 'sunset']

export const PLANS = {
  pro_month: { id: 'pro_month', name: 'Pro · 1 month', days: 30, amount: envInt('PRO_MONTH_PRICE_INR', 99) * 100 },
  pro_year: { id: 'pro_year', name: 'Pro · 1 year', days: 365, amount: envInt('PRO_YEAR_PRICE_INR', 799) * 100 },
}

/** Calendar day used for daily limits. Defaults to India time, so limits reset at midnight IST. */
export const TIMEZONE = process.env.APP_TIMEZONE || 'Asia/Kolkata'

export async function planOf(userId, db = { query: q }) {
  const r = await db.query(
    `SELECT ${ms('pro_until')} AS pro_until, (pro_until IS NOT NULL AND pro_until > now()) AS pro FROM users WHERE id = $1`,
    [userId],
  )
  const row = r.rows[0]
  return { pro: !!row?.pro, proUntil: row?.pro ? row.pro_until : null }
}
