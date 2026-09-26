export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

/** JSON fetch against our own server. Throws ApiError with the server's message on failure. */
export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; keepalive?: boolean } = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
      keepalive: opts.keepalive,
    })
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection.")
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    // a 401 outside the login routes means the session expired
    if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('lofi:unauthorized'))
    throw new ApiError(res.status, (data as { error?: string }).error || `Request failed (${res.status})`)
  }
  return data as T
}
