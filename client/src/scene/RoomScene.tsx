import { useEffect, useRef } from 'react'
import type { AnimationLevel, ThemeId } from '../lib/types'
import { H, W, drawDynamic, drawStatic, initState, palette } from './drawRoom'

interface Props { theme: ThemeId; light: boolean; animation: AnimationLevel; dim?: boolean }

export default function RoomScene({ theme, light, animation, dim }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    const bg = document.createElement('canvas')
    bg.width = W; bg.height = H
    const p = palette(theme, light)
    drawStatic(bg.getContext('2d')!, theme, p)

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const level: AnimationLevel = reduced ? 'off' : animation
    const state = initState(level === 'off' ? 'low' : level)
    const animate = level !== 'off'

    const frame = () => {
      ctx.clearRect(0, 0, W, H)
      ctx.drawImage(bg, 0, 0)
      drawDynamic(ctx, state, p, animate)
    }
    frame()
    if (!animate) return

    let raf = 0
    let last = 0
    const interval = level === 'full' ? 1000 / 30 : 1000 / 15
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < interval) return
      last = now
      frame()
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [theme, light, animation])

  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <canvas
        ref={ref}
        width={W}
        height={H}
        className="pixelated block h-full w-full"
        style={{ objectFit: 'cover', objectPosition: '72% 60%' }}
      />
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-700"
        style={{ background: 'radial-gradient(ellipse at 70% 55%, transparent 35%, rgba(8,8,20,0.55) 100%)', opacity: dim ? 1 : 0.55 }}
      />
    </div>
  )
}
