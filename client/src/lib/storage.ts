import { useEffect, useState } from 'react'

const PREFIX = 'lofi-study:'

/** useState persisted to this browser's localStorage. Used only for device preferences (sound volumes); account data syncs to the server. */
export function useStored<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(PREFIX + key)
      if (raw != null) return JSON.parse(raw) as T
    } catch { /* storage unavailable or corrupt: fall back */ }
    return typeof initial === 'function' ? (initial as () => T)() : initial
  })
  useEffect(() => {
    try { localStorage.setItem(PREFIX + key, JSON.stringify(value)) } catch { /* ignore quota / disabled */ }
  }, [key, value])
  return [value, setValue] as const
}

export function clearAllStored() {
  try {
    Object.keys(localStorage).filter(k => k.startsWith(PREFIX)).forEach(k => localStorage.removeItem(k))
  } catch { /* ignore */ }
}

export const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12) + Date.now().toString(36)
