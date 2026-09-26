import { useState } from 'react'
import { api } from '../lib/api'
import type { AppState } from '../lib/types'
import RoomScene from '../scene/RoomScene'

type Mode = 'login' | 'signup'

export default function AuthScreen({ onAuthed }: { onAuthed: (s: AppState) => void }) {
  const [mode, setMode] = useState<Mode>('login')
  const [form, setForm] = useState({ login: '', username: '', displayName: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(f => ({ ...f, [k]: e.target.value }))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const state = mode === 'login'
        ? await api<AppState>('/api/auth/login', { body: { login: form.login, password: form.password } })
        : await api<AppState>('/api/auth/signup', { body: { username: form.username, displayName: form.displayName, email: form.email, password: form.password } })
      onAuthed(state)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setBusy(false)
    }
  }

  const field = (k: keyof typeof form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="flex flex-col gap-1">
      <span className="text-muted">{label}</span>
      <input className="px-input" value={form[k]} onChange={set(k)} required {...props} />
    </label>
  )

  return (
    <div className="relative h-full w-full overflow-hidden">
      <RoomScene theme="rainy" light={false} animation="full" dim />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center gap-4 p-4 md:items-end md:pr-[8vw]">
          <section className="px-panel panel-in w-full max-w-[420px] p-5" aria-label={mode === 'login' ? 'Log in' : 'Create account'}>
            <h1 className="font-title text-[24px] leading-tight md:text-[28px]">Lo-Fi Study Space</h1>
            <p className="mt-1 text-muted">Your own little study room. Rain on the window, timer on the desk.</p>

            <div className="mt-4 grid grid-cols-2 gap-1" role="tablist">
              {(['login', 'signup'] as Mode[]).map(m => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => { setMode(m); setError('') }}
                  className={`px-solid ${mode === m ? '!bg-amber !text-[#2a1c10]' : ''}`}>
                  {m === 'login' ? 'Log in' : 'Create account'}
                </button>
              ))}
            </div>

            <form className="mt-4 flex flex-col gap-3" onSubmit={submit}>
              {mode === 'login' ? (
                <>
                  {field('login', 'Username or email', { autoComplete: 'username', autoFocus: true })}
                  {field('password', 'Password', { type: 'password', autoComplete: 'current-password' })}
                </>
              ) : (
                <>
                  {field('username', 'Username', { autoComplete: 'username', minLength: 3, maxLength: 20, pattern: '[A-Za-z0-9_]+', title: 'Letters, numbers and underscores', autoFocus: true })}
                  {field('displayName', 'Display name (optional)', { required: false, maxLength: 40, placeholder: 'Shown to friends' })}
                  {field('email', 'Email', { type: 'email', autoComplete: 'email' })}
                  {field('password', 'Password (8+ characters)', { type: 'password', autoComplete: 'new-password', minLength: 8 })}
                </>
              )}
              {error && <p className="border-2 border-rose px-3 py-2 text-rose" role="alert">{error}</p>}
              <button className="px-solid px-primary !py-2 text-[24px]" type="submit" disabled={busy}>
                {busy ? 'One moment…' : mode === 'login' ? 'Enter my room' : 'Create my room'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </div>
  )
}
