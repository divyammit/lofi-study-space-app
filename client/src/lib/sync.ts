import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'

type OnError = (e: unknown) => void

/**
 * A list kept in React state and mirrored to the server.
 * Components call set(fn) exactly like setState; this hook diffs old vs new and sends
 *   new item      -> PUT /api/<resource>/<id>   (immediately)
 *   changed item  -> PUT /api/<resource>/<id>   (debounced, so typing isn't one request per key)
 *   removed item  -> DELETE /api/<resource>/<id>
 * Requests for the same id run in order, so an edit can never overtake its create.
 */
export function useSyncedList<T extends { id: string }>(resource: string, initial: T[], onError: OnError, delay = 700) {
  const [items, setItems] = useState(initial)
  const ref = useRef(initial)
  const timers = useRef(new Map<string, number>())
  const chains = useRef(new Map<string, Promise<unknown>>())
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const enqueue = useCallback((id: string, op: () => Promise<unknown>) => {
    const prev = chains.current.get(id) ?? Promise.resolve()
    const next = prev.then(op).catch(e => onErrorRef.current(e))
    chains.current.set(id, next)
    void next.finally(() => { if (chains.current.get(id) === next) chains.current.delete(id) })
  }, [])

  const push = useCallback((id: string, keepalive = false) => {
    const item = ref.current.find(x => x.id === id)
    if (item) enqueue(id, () => api(`/api/${resource}/${encodeURIComponent(id)}`, { method: 'PUT', body: item, keepalive }))
  }, [resource, enqueue])

  const set = useCallback((fn: (list: T[]) => T[]) => {
    const prev = ref.current
    const next = fn(prev)
    if (next === prev) return
    ref.current = next
    setItems(next)
    const before = new Map(prev.map(x => [x.id, x]))
    const after = new Set<string>()
    for (const item of next) {
      after.add(item.id)
      const old = before.get(item.id)
      if (old === item) continue
      clearTimeout(timers.current.get(item.id))
      if (!old) {
        timers.current.delete(item.id)
        push(item.id)
      } else {
        timers.current.set(item.id, window.setTimeout(() => { timers.current.delete(item.id); push(item.id) }, delay))
      }
    }
    for (const id of before.keys()) {
      if (after.has(id)) continue
      clearTimeout(timers.current.get(id))
      timers.current.delete(id)
      enqueue(id, () => api(`/api/${resource}/${encodeURIComponent(id)}`, { method: 'DELETE' }))
    }
  }, [delay, push, enqueue, resource])

  // send pending edits if the tab is closed or the user logs out
  useEffect(() => {
    const flush = () => {
      timers.current.forEach((t, id) => { clearTimeout(t); push(id, true) })
      timers.current.clear()
    }
    window.addEventListener('pagehide', flush)
    return () => { window.removeEventListener('pagehide', flush); flush() }
  }, [push])

  return [items, set] as const
}

/** A single value (settings, profile, whiteboard) saved with a debounce. */
export function useSyncedValue<T>(initial: T, save: (v: T, keepalive: boolean) => Promise<unknown>, onError: OnError, delay = 800) {
  const [value, setValue] = useState(initial)
  const ref = useRef(initial)
  const timer = useRef(0)
  const dirty = useRef(false)
  const saveRef = useRef(save)
  saveRef.current = save
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  const flush = useCallback((keepalive = false) => {
    clearTimeout(timer.current)
    if (!dirty.current) return
    dirty.current = false
    saveRef.current(ref.current, keepalive).catch(e => onErrorRef.current(e))
  }, [])

  const set = useCallback((fn: (v: T) => T) => {
    const next = fn(ref.current)
    if (Object.is(next, ref.current)) return
    ref.current = next
    setValue(next)
    dirty.current = true
    clearTimeout(timer.current)
    timer.current = window.setTimeout(() => flush(), delay)
  }, [delay, flush])

  useEffect(() => {
    const onHide = () => flush(true)
    window.addEventListener('pagehide', onHide)
    return () => { window.removeEventListener('pagehide', onHide); flush() }
  }, [flush])

  return [value, set] as const
}
