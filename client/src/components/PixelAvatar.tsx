import { mulberry32 } from '../lib/rng'

const SKIN = ['#f1c9a5', '#e0ac85', '#c68863', '#8d5a3c', '#5e3b28']
const HAIR = ['#2a1d18', '#4a2f22', '#a0663c', '#d9b26f', '#1f2238', '#7a3b4f', '#e6e0d6']
const SHIRT = ['#5f8a6e', '#6b5a8a', '#b8575a', '#4f6d8f', '#c7875a', '#3c3a5e', '#8fa25a']
const BG = ['#2f3350', '#3b2a25', '#2b3a3a', '#3a2f45', '#40302f']

/** Deterministic 16x16 pixel portrait generated from a seed number. */
export default function PixelAvatar({ seed, size = 40, className = '' }: { seed: number; size?: number; className?: string }) {
  const r = mulberry32(seed * 9301 + 49297)
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
  const skin = pick(SKIN), hair = pick(HAIR), shirt = pick(SHIRT), bg = pick(BG)
  const style = Math.floor(r() * 4)
  const phones = r() < 0.35
  const glasses = r() < 0.25
  const px: [number, number, number, number, string][] = []
  const P = (x: number, y: number, w: number, h: number, c: string) => px.push([x, y, w, h, c])
  P(0, 0, 16, 16, bg)
  P(3, 13, 10, 3, shirt); P(2, 14, 12, 2, shirt)
  P(7, 11, 2, 2, skin)
  P(4, 4, 8, 8, skin)
  // hair
  P(4, 2, 8, 3, hair)
  if (style === 0) { P(3, 3, 1, 5, hair); P(12, 3, 1, 5, hair) }
  if (style === 1) { P(3, 3, 1, 9, hair); P(12, 3, 1, 9, hair); P(4, 5, 2, 1, hair) }
  if (style === 2) { P(5, 1, 6, 1, hair); P(4, 5, 8, 1, hair) }
  if (style === 3) { P(3, 2, 10, 2, hair); P(3, 4, 1, 2, hair); P(12, 4, 1, 2, hair) }
  // face
  P(6, 7, 1, 1, '#1b1726'); P(9, 7, 1, 1, '#1b1726')
  P(7, 10, 2, 1, '#9a5b4f')
  if (glasses) { P(5, 6, 3, 3, 'rgba(20,20,30,0.35)'); P(8, 6, 3, 3, 'rgba(20,20,30,0.35)') }
  if (phones) { P(3, 2, 10, 1, '#1d1b28'); P(2, 6, 2, 4, '#1d1b28'); P(12, 6, 2, 4, '#1d1b28'); P(2, 3, 1, 3, '#1d1b28'); P(13, 3, 1, 3, '#1d1b28') }
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} shapeRendering="crispEdges" className={className} aria-hidden="true">
      {px.map(([x, y, w, h, c], i) => <rect key={i} x={x} y={y} width={w} height={h} fill={c} />)}
    </svg>
  )
}
