import { useState } from 'react'
import { useStore } from '../../lib/store'
import type { AnimationLevel, ThemeId } from '../../lib/types'
import { Panel, Check, Seg, SectionTitle } from '../ui'

const THEMES: { value: ThemeId; label: string }[] = [
  { value: 'rainy', label: 'Rainy night' },
  { value: 'library', label: 'Cozy library' },
  { value: 'coffee', label: 'Coffee shop' },
  { value: 'sunset', label: 'Sunset bedroom' },
]

export default function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { settings, setSettings, toast, account, logout, deleteAccount } = useStore()
  const [deleting, setDeleting] = useState(false)
  const [password, setPassword] = useState('')
  const set = <K extends keyof typeof settings>(k: K, v: (typeof settings)[K]) => setSettings(s => ({ ...s, [k]: v }))
  const num = (k: 'focusMin' | 'shortMin' | 'longMin' | 'longEvery' | 'dailyGoalMin', label: string, max: number) => (
    <label className="flex flex-col gap-1">
      <span className="text-muted">{label}</span>
      <input type="number" min={1} max={max} className="px-input" value={settings[k]} onChange={e => set(k, Math.max(1, Math.min(max, Number(e.target.value) || 1)))} />
    </label>
  )
  return (
    <Panel title="Settings" onClose={onClose}>
      <SectionTitle>Room</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        {THEMES.map(t => (
          <button key={t.value} onClick={() => set('theme', t.value)} aria-pressed={settings.theme === t.value}
            className={`px-card p-3 text-left ${settings.theme === t.value ? 'outline-2 outline-amber' : 'hover:bg-card-hi'}`}>
            <span className="text-amber">{settings.theme === t.value ? '[X] ' : '[ ] '}</span>{t.label}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span>Environment</span>
        <Seg label="Environment" value={settings.env} onChange={v => set('env', v)} options={[{ value: 'dark', label: 'Night' }, { value: 'light', label: 'Day' }]} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span>Animation</span>
        <Seg<AnimationLevel> label="Animation intensity" value={settings.animation} onChange={v => set('animation', v)} options={[{ value: 'off', label: 'Off' }, { value: 'low', label: 'Low' }, { value: 'full', label: 'Full' }]} />
      </div>

      <SectionTitle>Timer</SectionTitle>
      <div className="grid grid-cols-3 gap-2">
        {num('focusMin', 'Focus min', 180)}
        {num('shortMin', 'Short break', 60)}
        {num('longMin', 'Long break', 90)}
        {num('longEvery', 'Long break every', 12)}
        {num('dailyGoalMin', 'Daily goal (min)', 900)}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        <Check checked={settings.autoStartNext} onChange={v => set('autoStartNext', v)} label="Start the next session automatically" />
        <Check checked={settings.autoSound} onChange={v => set('autoSound', v)} label="Play ambient sound when a focus session starts" />
      </div>

      <SectionTitle>Sound</SectionTitle>
      <label className="flex items-center gap-3">
        <span className="shrink-0">Ambient volume</span>
        <input type="range" className="px-range" min={0} max={1} step={0.01} value={settings.masterVolume} onChange={e => set('masterVolume', Number(e.target.value))} />
        <span className="w-12 text-right">{Math.round(settings.masterVolume * 100)}%</span>
      </label>

      <SectionTitle>Notifications</SectionTitle>
      <div className="flex flex-col gap-2">
        <Check checked={settings.notifyInApp} onChange={v => set('notifyInApp', v)} label="Show a message when a session ends" />
        <Check checked={settings.chime} onChange={v => set('chime', v)} label="Play a soft chime" />
        <Check
          checked={settings.notifyBrowser}
          onChange={async v => {
            set('notifyBrowser', v)
            if (v && 'Notification' in window) {
              try {
                const r = await Notification.requestPermission()
                if (r !== 'granted') toast('Browser notifications are blocked here. In-app messages still work.')
              } catch { toast('Browser notifications are not available here.') }
            }
          }}
          label="Browser notifications (when allowed)"
        />
      </div>

      <SectionTitle>Account</SectionTitle>
      <p className="text-muted">Signed in as @{account.username} ({account.email}). Your settings, tasks, notes and study history are saved to your account.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button className="px-solid" onClick={logout}>Log out</button>
        {!deleting && <button className="px-btn text-muted hover:!text-rose" onClick={() => setDeleting(true)}>Delete account…</button>}
      </div>
      {deleting && (
        <form
          className="mt-3 border-2 border-rose p-3"
          onSubmit={async e => {
            e.preventDefault()
            try { await deleteAccount(password) } catch (err) { toast(err instanceof Error ? err.message : 'Could not delete account') }
          }}
        >
          <p>This permanently deletes your account and everything in it. Enter your password to confirm.</p>
          <input type="password" className="px-input mt-2" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" aria-label="Password" required />
          <div className="mt-2 flex gap-2">
            <button className="px-solid !bg-rose !text-white" type="submit">Delete forever</button>
            <button className="px-btn" type="button" onClick={() => { setDeleting(false); setPassword('') }}>Keep my account</button>
          </div>
        </form>
      )}
    </Panel>
  )
}
