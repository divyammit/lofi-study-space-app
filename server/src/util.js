export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

/** Express 4 doesn't catch rejected promises; wrap async route handlers with this. */
export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export function str(v, { max, min = 0, field, fallback }) {
  if (v == null || v === '') {
    if (fallback !== undefined) return fallback
    if (min > 0) throw new HttpError(400, `${field} is required`)
    return ''
  }
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text`)
  const s = v.trim()
  if (s.length < min) throw new HttpError(400, `${field} must be at least ${min} characters`)
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters`)
  return s
}

export function oneOf(v, options, field, fallback) {
  if (v == null) return fallback
  if (!options.includes(v)) throw new HttpError(400, `${field} must be one of: ${options.join(', ')}`)
  return v
}

export function int(v, { min, max, field, fallback }) {
  if (v == null) { if (fallback !== undefined) return fallback; throw new HttpError(400, `${field} is required`) }
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}`)
  return n
}

/** epoch milliseconds, or null */
export function time(v, field, { required = false } = {}) {
  if (v == null) { if (required) throw new HttpError(400, `${field} is required`); return null }
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 4102444800000) throw new HttpError(400, `${field} is not a valid time`)
  return n
}

export function day(v, field, { required = false } = {}) {
  if (v == null || v === '') { if (required) throw new HttpError(400, `${field} is required`); return null }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${field} must be a YYYY-MM-DD date`)
  return v
}

export function clientId(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{6,40}$/.test(v)) throw new HttpError(400, 'Invalid id')
  return v
}
