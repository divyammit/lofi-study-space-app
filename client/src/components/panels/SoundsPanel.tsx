import { useStore } from '../../lib/store'
import { SOUND_LABELS, engine } from '../../lib/audio'
import type { SoundId } from '../../lib/types'
import { Panel } from '../ui'

const DESC: Record<SoundId, string> = {
  rain: 'Steady rain with drops on the glass',
  fire: 'Low rumble and wood crackle',
  cafe: 'Distant chatter and cups',
  library: 'Quiet hum, page turns, a clock',
  brown: 'Deep, even noise for masking',
  lofi: 'A slow looping beat',
}

export default function SoundsPanel({ onClose }: { onClose: () => void }) {
  const { mix, setSound, settings, setSettings } = useStore()
  const ids = Object.keys(SOUND_LABELS) as SoundId[]
  const playing = ids.filter(id => mix[id].on)
  return (
    <Panel
      title="Ambient sounds"
      onClose={onClose}
      actions={<button className="px-btn" disabled={!playing.length} onClick={() => { ids.forEach(id => mix[id].on && setSound(id, { on: false })); engine.stopAll() }}>[■] Stop all</button>}
    >
      <p className="text-muted">Mix as many as you like. Each has its own volume.</p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {ids.map(id => {
          const s = mix[id]
          return (
            <li key={id} className={`px-card p-3 ${s.on ? 'outline-2 outline-amber' : ''}`}>
              <button className="flex w-full items-start gap-2 text-left" onClick={() => setSound(id, { on: !s.on })} aria-pressed={s.on}>
                <span className="text-amber">{s.on ? '[▶]' : '[ ]'}</span>
                <span>
                  <span className="block text-[21px]">{SOUND_LABELS[id]}</span>
                  <span className="block text-[17px] text-muted">{DESC[id]}</span>
                </span>
              </button>
              <input
                type="range"
                className="px-range mt-3"
                min={0}
                max={1}
                step={0.01}
                value={s.vol}
                onChange={e => setSound(id, { vol: Number(e.target.value) })}
                aria-label={`${SOUND_LABELS[id]} volume`}
              />
            </li>
          )
        })}
      </ul>
      <label className="mt-4 flex items-center gap-3">
        <span className="shrink-0">Master volume</span>
        <input type="range" className="px-range" min={0} max={1} step={0.01} value={settings.masterVolume} onChange={e => setSettings(st => ({ ...st, masterVolume: Number(e.target.value) }))} />
        <span className="w-12 text-right">{Math.round(settings.masterVolume * 100)}%</span>
      </label>
      <p className="mt-4 text-[17px] text-muted">These are generated live in your browser as placeholders, so the panel works without audio files. Real recordings can be dropped in later.</p>
    </Panel>
  )
}
