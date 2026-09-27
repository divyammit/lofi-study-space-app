import { useEffect, useRef, useState } from 'react'
import { useCall } from '../lib/call'
import { useStore } from '../lib/store'
import { BH, BOARD_COLORS, BW, loadImage, paintPaper } from '../lib/board'
import type { BoardStroke } from '../lib/types'

/** Whiteboard everyone in a call draws on together. Strokes travel as tiny line segments. */
export default function SharedBoard() {
  const { board, sendStroke, onStrokes, clearBoard, closeBoard } = useCall()
  const { setWhiteboard, toast } = useStore()
  const paperRef = useRef<HTMLCanvasElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const [color, setColor] = useState(BOARD_COLORS[0].c)
  const [size, setSize] = useState(4)
  const [eraser, setEraser] = useState(false)
  const last = useRef<{ x: number; y: number } | null>(null)

  const draw = (s: BoardStroke) => {
    const c = inkRef.current?.getContext('2d')
    if (!c) return
    c.globalCompositeOperation = s.e ? 'destination-out' : 'source-over'
    c.strokeStyle = s.c
    c.lineWidth = s.w
    c.lineCap = 'round'
    c.lineJoin = 'round'
    c.beginPath()
    c.moveTo(s.p[0] * BW, s.p[1] * BH)
    c.lineTo(s.p[2] * BW + 0.01, s.p[3] * BH)
    c.stroke()
    c.globalCompositeOperation = 'source-over'
  }

  // repaint everything when the board opens or is cleared
  useEffect(() => {
    if (!board) return
    let cancelled = false
    const paper = paperRef.current!.getContext('2d')!
    paintPaper(paper)
    const ink = inkRef.current!.getContext('2d')!
    ink.clearRect(0, 0, BW, BH)
    board.strokes.forEach(draw)
    if (board.bg) loadImage(board.bg).then(img => { if (!cancelled) paper.drawImage(img, 0, 0, BW, BH) }).catch(() => {})
    return () => { cancelled = true }
  }, [board])

  useEffect(() => onStrokes(strokes => strokes.forEach(draw)), [onStrokes])

  const pos = (e: React.PointerEvent) => {
    const r = inkRef.current!.getBoundingClientRect()
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }
  }
  const segment = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const s: BoardStroke = { p: [a.x, a.y, b.x, b.y], c: color, w: eraser ? size * 4 : size, e: eraser }
    draw(s)
    sendStroke(s)
  }

  const saveCopy = () => {
    const out = document.createElement('canvas')
    out.width = BW
    out.height = BH
    const c = out.getContext('2d')!
    c.drawImage(paperRef.current!, 0, 0)
    c.drawImage(inkRef.current!, 0, 0)
    setWhiteboard(out.toDataURL('image/png'))
    toast('Saved a copy to your whiteboard.')
  }

  if (!board) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1" role="radiogroup" aria-label="Colour">
          {BOARD_COLORS.map(k => (
            <button key={k.c} role="radio" aria-checked={!eraser && color === k.c} aria-label={k.n} onClick={() => { setColor(k.c); setEraser(false) }}
              className="h-6 w-6" style={{ background: k.c, boxShadow: !eraser && color === k.c ? '0 0 0 2px var(--panel-solid), 0 0 0 4px var(--amber)' : 'inset 0 -3px 0 rgba(0,0,0,.25)' }} />
          ))}
        </div>
        <button className={`px-solid !px-2 !py-0 ${eraser ? '!bg-amber !text-[#2a1c10]' : ''}`} onClick={() => setEraser(v => !v)} aria-pressed={eraser}>Eraser</button>
        <input type="range" className="px-range !w-24" min={1} max={20} value={size} onChange={e => setSize(Number(e.target.value))} aria-label="Brush size" />
        <span className="flex-1" />
        <button className="px-btn" onClick={saveCopy}>Save copy</button>
        <button className="px-btn hover:!text-rose" onClick={clearBoard}>Clear</button>
        <button className="px-btn" onClick={closeBoard}>Close board</button>
      </div>
      <div className="relative mx-auto w-full max-w-full" style={{ aspectRatio: `${BW} / ${BH}`, maxHeight: '100%' }}>
        <canvas ref={paperRef} width={BW} height={BH} className="absolute inset-0 h-full w-full" />
        <canvas
          ref={inkRef}
          width={BW}
          height={BH}
          className="absolute inset-0 h-full w-full"
          style={{ touchAction: 'none', cursor: 'crosshair' }}
          aria-label="Shared whiteboard. Everyone in the call can draw here."
          onPointerDown={e => { inkRef.current!.setPointerCapture(e.pointerId); const p = pos(e); last.current = p; segment(p, p) }}
          onPointerMove={e => { if (!last.current) return; const p = pos(e); segment(last.current, p); last.current = p }}
          onPointerUp={() => { last.current = null }}
          onPointerCancel={() => { last.current = null }}
        />
      </div>
    </div>
  )
}
