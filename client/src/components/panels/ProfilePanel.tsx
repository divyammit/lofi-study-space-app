import { useMemo } from 'react'
import { useStore } from '../../lib/store'
import { computeStats } from '../../lib/stats'
import { fmtHours } from '../../lib/dates'
import { SUBJECTS } from '../../lib/defaults'
import { Panel, SectionTitle } from '../ui'
import PixelAvatar from '../PixelAvatar'

export default function ProfilePanel({ onClose }: { onClose: () => void }) {
  const { profile, setProfile, sessions, tasks, account } = useStore()
  const st = useMemo(() => computeStats(sessions, tasks), [sessions, tasks])
  return (
    <Panel title="Profile" onClose={onClose}>
      <div className="flex items-center gap-4">
        <PixelAvatar seed={profile.avatar} size={96} className="shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-muted">@{account.username} · member since {new Date(account.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</div>
          <label className="mt-2 block text-muted" htmlFor="uname">Display name</label>
          <input id="uname" className="px-input font-title !text-[20px]" value={profile.name} maxLength={40} placeholder="Your name" onChange={e => setProfile(p => ({ ...p, name: e.target.value }))} />
          <label className="mt-2 block text-muted" htmlFor="fav">Favourite subject</label>
          <input id="fav" className="px-input" list="fav-subjects" value={profile.favSubject} onChange={e => setProfile(p => ({ ...p, favSubject: e.target.value }))} />
          <datalist id="fav-subjects">{SUBJECTS.map(s => <option key={s} value={s} />)}</datalist>
        </div>
      </div>

      <SectionTitle>Choose an avatar</SectionTitle>
      <div className="grid grid-cols-6 gap-2 sm:grid-cols-8">
        {Array.from({ length: 16 }, (_, i) => (
          <button
            key={i}
            onClick={() => setProfile(p => ({ ...p, avatar: i }))}
            aria-label={`Avatar ${i + 1}`}
            aria-pressed={profile.avatar === i}
            className="block"
            style={{ boxShadow: profile.avatar === i ? '0 0 0 3px var(--amber)' : undefined }}
          >
            <PixelAvatar seed={i} size={48} className="block h-auto w-full" />
          </button>
        ))}
      </div>

      <SectionTitle>Your numbers</SectionTitle>
      <div className="grid grid-cols-2 gap-2">
        {[
          ['Current streak', `${st.currentStreak} days`],
          ['Total focus', fmtHours(st.totalMinutes)],
          ['Sessions completed', String(st.sessions)],
          ['Most studied', st.topSubject ?? '—'],
        ].map(([k, v]) => (
          <div key={k} className="px-card px-3 py-2">
            <div className="text-[17px] text-muted">{k}</div>
            <div className="font-title text-[20px]">{v}</div>
          </div>
        ))}
      </div>
    </Panel>
  )
}
