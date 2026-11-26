import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { AppState } from '../lib/types'
import RoomScene from '../scene/RoomScene'

/**
 * Page opened from the "reset your password" email: /reset-password#token=...
 * The token sits after the # so it never reaches server logs.
 */
export default function ResetPassword({ onDone }: { onDone: (s: AppState) => void }) {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? ''
  const [who, setWho] = useState<{ username: string; name: string } | null>(null)
  const [dead, setDead] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!token) { setDead('This link is incomplete. Open it again from the email, or ask for a new one.'); return }
    api<{ username: string; name: string }>('/api/auth/reset/check', { body: { token } })
      .then(setWho, e => setDead(e instanceof Error ? e.message : 'This link no longer works.'))
  }, [token])

  const goHome = () => { window.history.replaceState(null, '', '/'); window.location.reload() }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (pw !== pw2) { setError("The two passwords don't match."); return }
    setBusy(true)
    try {
      const state = await api<AppState>('/api/auth/reset', { body: { token, password: pw } })
      window.history.replaceState(null, '', '/')
      onDone(state)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setBusy(false)
    }
  }

  const strength = pw.length === 0 ? '' : pw.length < 8 ? 'Too short' : pw.length < 12 || !/[^A-Za-z]/.test(pw) ? 'OK' : 'Strong'

  return (
    <div className="relative h-full w-full overflow-hidden">
      <RoomScene theme="rainy" light={false} animation="low" dim />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-4">
          <section className="px-panel panel-in w-full max-w-[420px] p-5" aria-label="Reset password">
            <h1 className="font-title text-[24px] leading-tight">Choose a new password</h1>
            {dead ? (
              <>
                <p className="mt-3 border-2 border-rose px-3 py-2" role="alert">{dead}</p>
                <button className="px-solid px-primary mt-4 w-full !py-2" onClick={goHome}>Back to log in</button>
              </>
            ) : !who ? (
              <p className="mt-3 text-muted">Checking your link<span className="blink">…</span></p>
            ) : (
              <form className="mt-3 flex flex-col gap-3" onSubmit={submit}>
                <p className="text-muted">For <span className="text-ink">{who.name}</span> (@{who.username}). You&rsquo;ll be logged in afterwards, and logged out everywhere else.</p>
                <input type="text" autoComplete="username" value={who.username} readOnly hidden />
                <label className="flex flex-col gap-1">
                  <span className="text-muted">New password (8+ characters)</span>
                  <input className="px-input" type={show ? 'text' : 'password'} value={pw} onChange={e => setPw(e.target.value)} autoComplete="new-password" minLength={8} maxLength={200} required autoFocus />
                </label>
                {strength && <p className={`-mt-2 text-[16px] ${strength === 'Too short' ? 'text-rose' : strength === 'Strong' ? 'text-moss' : 'text-muted'}`}>{strength}</p>}
                <label className="flex flex-col gap-1">
                  <span className="text-muted">Type it again</span>
                  <input className="px-input" type={show ? 'text' : 'password'} value={pw2} onChange={e => setPw2(e.target.value)} autoComplete="new-password" minLength={8} maxLength={200} required />
                </label>
                <label className="flex items-center gap-2 text-muted"><input type="checkbox" checked={show} onChange={e => setShow(e.target.checked)} /> Show passwords</label>
                {error && <p className="border-2 border-rose px-3 py-2 text-rose" role="alert">{error}</p>}
                <button className="px-solid px-primary !py-2 text-[22px]" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save and enter my room'}</button>
                <button className="px-btn text-muted" type="button" onClick={goHome}>Cancel</button>
              </form>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
