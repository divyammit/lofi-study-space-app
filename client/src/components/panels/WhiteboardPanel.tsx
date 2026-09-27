import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../lib/store'
import { saveFile } from '../../lib/saveFile'
import { Panel } from '../ui'
import { BH, BOARD_COLORS, BW, paintPaper } from '../../lib/board'

type Tool = 'pen' | 'eraser' | 'text'
const COLORS = BOARD_COLORS

export default function WhiteboardPanel({ onClose }: { onClose: () => void }) {
  const { whiteboard, setWhiteboard, toast } = useStore()
  const paperRef = useRef<HTMLCanvasElement>(null)
  const inkRef = useRef<HTMLCanvasElement>(null)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(COLORS[0].c)
  const [size, setSize] = useState(4)
  const [textAt, setTextAtState] = useState<{ x: number; y: number; cx: number; cy: number } | null>(null)
  const [text, setTextState] = useState('')
  // refs mirror the text state so blur/click handlers never read stale values
  const textAtRef = useRef<typeof textAt>(null)
  const textRef = useRef('')
  const textInputRef = useRef<HTMLInputElement>(null)
  const setTextAt = (v: typeof textAt) => { textAtRef.current = v; setTextAtState(v) }
  const setText = (v: string) => { textRef.current = v; setTextState(v) }
  const drawing = useRef<{ x: number; y: number } | null>(null)
  const saveTimer = useRef(0)

  useEffect(() => {
    paintPaper(paperRef.current!.getContext('2d')!)
    if (whiteboard) {
      const img = new Image()
      img.onload = () => inkRef.current?.getContext('2d')!.drawImage(img, 0, 0)
      img.src = whiteboard
    }
  }, [])

  const persist = () => {
    clearTimeout(saveTimer.current)
    saveTimer.current = window.setTimeout(() => {
      try { setWhiteboard(inkRef.current!.toDataURL('image/png')) } catch { /* too large for storage */ }
    }, 400)
  }

  const toBoard = (e: React.PointerEvent) => {
    const r = inkRef.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) / r.width) * BW, y: ((e.clientY - r.top) / r.height) * BH, cx: e.clientX - r.left, cy: e.clientY - r.top }
  }

  const down = (e: React.PointerEvent) => {
    const p = toBoard(e)
    if (tool === 'text') {
      e.preventDefault()
      // a click while a text box is open places that text; the next click starts a new one
      if (textAtRef.current) { commitText(); return }
      setTextAt(p)
      setText('')
      // focus after the browser finishes handling this click, or the click steals focus back
      setTimeout(() => textInputRef.current?.focus(), 0)
      return
    }
    inkRef.current!.setPointerCapture(e.pointerId)
    drawing.current = p
    line(p, p)
  }
  const moveP = (e: React.PointerEvent) => {
    if (!drawing.current) return
    const p = toBoard(e)
    line(drawing.current, p)
    drawing.current = p
  }
  const up = () => { if (drawing.current) { drawing.current = null; persist() } }

  const line = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const c = inkRef.current!.getContext('2d')!
    c.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
    c.strokeStyle = color
    c.lineWidth = tool === 'eraser' ? size * 4 : size
    c.lineCap = 'round'
    c.lineJoin = 'round'
    c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x + 0.01, b.y); c.stroke()
    c.globalCompositeOperation = 'source-over'
  }

  const commitText = () => {
    const at = textAtRef.current
    const value = textRef.current
    if (!at) return
    setTextAt(null)
    setText('')
    if (!value.trim()) return
    const c = inkRef.current!.getContext('2d')!
    c.fillStyle = color
    c.font = `${20 + size * 5}px VT323, monospace`
    c.textBaseline = 'top'
    c.fillText(value, at.x, at.y)
    persist()
  }

  const clear = () => {
    inkRef.current!.getContext('2d')!.clearRect(0, 0, BW, BH)
    setWhiteboard(null)
    toast('Board cleared.')
  }

  const download = async () => {
    const out = document.createElement('canvas')
    out.width = BW; out.height = BH
    const c = out.getContext('2d')!
    c.drawImage(paperRef.current!, 0, 0)
    c.drawImage(inkRef.current!, 0, 0)
    const blob: Blob | null = await new Promise(res => out.toBlob(res, 'image/png'))
    if (!blob) return toast('Could not create the image.')
    const r = await saveFile(`whiteboard-${new Date().toISOString().slice(0, 10)}.png`, blob)
    if (r === 'saved') toast('Board downloaded.')
    else if (r === 'failed') toast('Download is not available here.')
  }

  return (
    <Panel
      title="Whiteboard"
      onClose={onClose}
      wide
      actions={<>
        <button className="px-btn" onClick={download}>[↓] Download</button>
        <button className="px-btn hover:!text-rose" onClick={clear}>[x] Clear</button>
      </>}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="flex gap-1" role="radiogroup" aria-label="Tool">
          {(['pen', 'eraser', 'text'] as Tool[]).map(t => (
            <button key={t} role="radio" aria-checked={tool === t} onClick={() => setTool(t)} className={`px-solid !px-3 !py-1 capitalize ${tool === t ? '!bg-amber !text-[#2a1c10]' : ''}`}>{t}</button>
          ))}
        </div>
        <div className="flex gap-1" role="radiogroup" aria-label="Colour">
          {COLORS.map(k => (
            <button key={k.c} role="radio" aria-checked={color === k.c} aria-label={k.n} onClick={() => { setColor(k.c); if (tool === 'eraser') setTool('pen') }}
              className="h-7 w-7" style={{ background: k.c, boxShadow: color === k.c ? '0 0 0 2px var(--panel-solid), 0 0 0 4px var(--amber)' : 'inset 0 -3px 0 rgba(0,0,0,.25)' }} />
          ))}
        </div>
        <label className="flex min-w-40 flex-1 items-center gap-2">
          <span className="text-muted">Size</span>
          <input type="range" className="px-range" min={1} max={24} value={size} onChange={e => setSize(Number(e.target.value))} />
          <span className="w-6">{size}</span>
        </label>
      </div>
      <div className="relative w-full" style={{ aspectRatio: `${BW} / ${BH}` }}>
        <canvas ref={paperRef} width={BW} height={BH} className="absolute inset-0 h-full w-full" />
        <canvas
          ref={inkRef}
          width={BW}
          height={BH}
          className="absolute inset-0 h-full w-full"
          style={{ touchAction: 'none', cursor: tool === 'text' ? 'text' : 'crosshair' }}
          onPointerDown={down}
          onPointerMove={moveP}
          onPointerUp={up}
          onPointerCancel={up}
          aria-label="Drawing canvas"
        />
        {textAt && (
          <input
            ref={textInputRef}
            className="absolute border-2 border-dashed border-amber bg-[#f6efdf]/90 px-1 font-pixel text-[#2e2940] outline-none"
            style={{ left: textAt.cx, top: textAt.cy, color, fontSize: 14 + size * 2 }}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commitText() }
              if (e.key === 'Escape') { e.stopPropagation(); setTextAt(null); setText('') }
            }}
            onBlur={commitText}
            aria-label="Text to place on the board"
          />
        )}
      </div>
      <p className="mt-2 text-[17px] text-muted">{tool === 'text' ? 'Click the board, type, then press Enter.' : 'Your board is saved to your account.'}</p>
    </Panel>
  )
}
