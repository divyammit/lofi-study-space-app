import { useState } from 'react'
import { useStore } from '../lib/store'
import { SOUND_LABELS, STATIONS, engine } from '../lib/audio'
import { TICKER_LINES } from '../lib/defaults'
import type { SoundId } from '../lib/types'
import PixelIcon from './PixelIcon'

export default function BottomBar({ dim }: { dim: boolean }) {
  const { mix, setSound, settings, setSettings } = useStore()
  const [station, setStation] = useState(engine.station)
  const lofiOn = mix.lofi.on
  const others = (Object.keys(mix) as SoundId[]).filter(k => k !== 'lofi' && mix[k].on).map(k => SOUND_LABELS[k])
  const nextStation = () => {
    const n = (station + 1) % STATIONS.length
    engine.setStation(n, mix.lofi.vol)
    setStation(n)
    if (!lofiOn) setSound('lofi', { on: true })
  }
  const parts = [
    lofiOn ? `Now playing: ${STATIONS[station].name}` : `${STATIONS[station].name} (press play)`,
    ...(others.length ? [`Ambient: ${others.join(' + ')}`] : []),
    ...TICKER_LINES,
  ]
  const line = parts.join('   ✦   ')
  return (
    <footer className={`pointer-events-auto flex items-center gap-2 bg-black/45 px-3 py-2 text-[#ece3d0] transition-opacity duration-500 sm:gap-3 sm:px-4 ${dim ? 'opacity-40 hover:opacity-100 focus-within:opacity-100' : ''}`}>
      <button className="px-btn !text-[#ece3d0] hover:!text-[#f2a65a]" onClick={() => setSound('lofi', { on: !lofiOn })} aria-label={lofiOn ? 'Pause lo-fi music' : 'Play lo-fi music'} title={lofiOn ? 'Pause' : 'Play lo-fi music'}>
        <PixelIcon name={lofiOn ? 'pause' : 'play'} size={20} />
      </button>
      <PixelIcon name="volume" size={18} className="hidden sm:block" />
      <input type="range" className="px-range hidden !w-28 sm:block" min={0} max={1} step={0.01} value={settings.masterVolume} onChange={e => setSettings(s => ({ ...s, masterVolume: Number(e.target.value) }))} aria-label="Master volume" />
      <button className="px-btn !text-[#ece3d0] hover:!text-[#f2a65a]" onClick={nextStation} aria-label="Next radio station" title="Next station">
        <PixelIcon name="shuffle" size={20} />
      </button>
      <div className="relative min-w-0 flex-1 overflow-hidden whitespace-nowrap" aria-live="polite">
        <div className="ticker-track inline-block">
          <span className="pr-12">{line}</span><span className="pr-12" aria-hidden="true">{line}</span>
        </div>
      </div>
    </footer>
  )
}
