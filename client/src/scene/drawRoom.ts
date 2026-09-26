import type { ThemeId } from '../lib/types'
import { mulberry32 } from '../lib/rng'

export const W = 320
export const H = 180

interface Palette {
  skyTop: string; skyBot: string
  wall: string; wallAlt: string
  floor: string; floorLine: string
  wood: string; woodDark: string; woodLight: string
  city: string; cityWin: string
  curtain: string; curtainDark: string
  neon: string
  lampOn: boolean
  rain: boolean
  moon: boolean
  sun: boolean
  day: boolean
}

function hex(h: string) {
  const n = parseInt(h.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function mix(a: string, b: string, t: number) {
  const x = hex(a), y = hex(b)
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t))
  return `#${c.map(v => v.toString(16).padStart(2, '0')).join('')}`
}

const NIGHT: Record<ThemeId, Palette> = {
  rainy: {
    skyTop: '#161a38', skyBot: '#4b3868', wall: '#2b2439', wallAlt: '#251f33',
    floor: '#3b2a2c', floorLine: '#2e2023', wood: '#5d3f30', woodDark: '#3e2a21', woodLight: '#7a553f',
    city: '#12122b', cityWin: '#ffcf7a', curtain: '#3c3a5e', curtainDark: '#2c2a47', neon: '#ff7aa8',
    lampOn: true, rain: true, moon: true, sun: false, day: false,
  },
  library: {
    skyTop: '#2a2140', skyBot: '#7a4f5e', wall: '#3b2a25', wallAlt: '#33241f',
    floor: '#4a3326', floorLine: '#3a281e', wood: '#6a4631', woodDark: '#4a2f21', woodLight: '#8a6146',
    city: '#1e1a2c', cityWin: '#f7c46a', curtain: '#5a3a36', curtainDark: '#472d2a', neon: '#ffc36a',
    lampOn: true, rain: false, moon: true, sun: false, day: false,
  },
  coffee: {
    skyTop: '#1c2438', skyBot: '#3e4c69', wall: '#4a2d29', wallAlt: '#3f2622',
    floor: '#3a2b24', floorLine: '#2c201b', wood: '#6b4632', woodDark: '#4a2f22', woodLight: '#8d6045',
    city: '#141a2a', cityWin: '#ffd98a', curtain: '#35503f', curtainDark: '#283d30', neon: '#7ee0d2',
    lampOn: true, rain: true, moon: false, sun: false, day: false,
  },
  sunset: {
    skyTop: '#5b3f86', skyBot: '#ff9f6a', wall: '#553b4f', wallAlt: '#4b3346',
    floor: '#5f4336', floorLine: '#4b342a', wood: '#76503a', woodDark: '#553827', woodLight: '#966a4c',
    city: '#3a2440', cityWin: '#ffd7a0', curtain: '#b86a6a', curtainDark: '#9a5456', neon: '#ffd36a',
    lampOn: false, rain: false, moon: false, sun: true, day: false,
  },
}

export function palette(theme: ThemeId, light: boolean): Palette {
  const p = NIGHT[theme]
  if (!light) return p
  const lift = (c: string, t = 0.28) => mix(c, '#f3e6cf', t)
  return {
    ...p,
    skyTop: theme === 'sunset' ? '#f7a26b' : '#7fb7e0',
    skyBot: theme === 'sunset' ? '#ffe0a3' : '#d6ecf5',
    wall: lift(p.wall, 0.35), wallAlt: lift(p.wallAlt, 0.33),
    floor: lift(p.floor), floorLine: lift(p.floorLine),
    wood: lift(p.wood, 0.15), woodDark: lift(p.woodDark, 0.15), woodLight: lift(p.woodLight, 0.15),
    city: theme === 'sunset' ? '#b0708a' : '#8aa0b8', cityWin: '#c8d8e8',
    curtain: lift(p.curtain, 0.2), curtainDark: lift(p.curtainDark, 0.2),
    lampOn: false, moon: false, sun: theme !== 'coffee', day: true,
  }
}

type Ctx = CanvasRenderingContext2D
const R = (c: Ctx, x: number, y: number, w: number, h: number, col: string) => { c.fillStyle = col; c.fillRect(x, y, w, h) }

// window glass area
export const GLASS = { x: 172, y: 22, w: 120, h: 86 }

/** Static layer — redrawn only when the theme or environment changes. */
export function drawStatic(c: Ctx, theme: ThemeId, p: Palette) {
  const rand = mulberry32(7 + theme.length * 31)
  c.clearRect(0, 0, W, H)

  // wall
  R(c, 0, 0, W, 140, p.wall)
  if (theme === 'coffee') {
    for (let y = 0; y < 140; y += 6) {
      const off = (y / 6) % 2 ? 0 : 6
      for (let x = -12 + off; x < W; x += 12) R(c, x, y, 11, 5, rand() < 0.5 ? p.wall : p.wallAlt)
    }
  } else if (theme === 'library') {
    for (let x = 0; x < W; x += 20) { R(c, x, 60, 1, 80, p.wallAlt); R(c, x + 2, 64, 16, 1, p.wallAlt) }
    R(c, 0, 58, W, 3, p.woodDark)
  } else {
    for (let x = 0; x < W; x += 8) R(c, x, 0, 3, 140, p.wallAlt)
  }
  // ceiling shadow
  for (let i = 0; i < 6; i++) { c.globalAlpha = 0.08 * (6 - i); R(c, 0, i * 2, W, 2, '#000'); }
  c.globalAlpha = 1

  // floor
  R(c, 0, 140, W, 40, p.floor)
  for (let y = 144; y < H; y += 6) {
    R(c, 0, y, W, 1, p.floorLine)
    const off = (y * 7) % 40
    for (let x = off; x < W; x += 40) R(c, x, y - 5, 1, 5, p.floorLine)
  }
  R(c, 0, 138, W, 3, p.woodDark) // baseboard

  // rug
  for (let y = 152; y < 172; y++) {
    const t = Math.abs(y - 162) / 10
    const half = Math.round(60 * Math.sqrt(1 - t * t))
    R(c, 95 - half, y, half * 2, 1, (y % 4 < 2) ? mix(p.curtain, '#000', 0.2) : mix(p.curtain, '#000', 0.35))
  }

  // sky
  const bands = 12
  for (let i = 0; i < bands; i++) {
    const col = mix(p.skyTop, p.skyBot, i / (bands - 1))
    R(c, GLASS.x, GLASS.y + Math.floor(i * GLASS.h / bands), GLASS.w, Math.ceil(GLASS.h / bands) + 1, col)
  }
  // dither between bands
  for (let i = 1; i < bands; i++) {
    const y = GLASS.y + Math.floor(i * GLASS.h / bands)
    const col = mix(p.skyTop, p.skyBot, (i - 1) / (bands - 1))
    for (let x = GLASS.x; x < GLASS.x + GLASS.w; x += 2) R(c, x + (i % 2), y, 1, 1, col)
  }
  if (!p.day && theme !== 'sunset') {
    for (let i = 0; i < 26; i++) R(c, GLASS.x + Math.floor(rand() * GLASS.w), GLASS.y + Math.floor(rand() * 40), 1, 1, rand() < 0.3 ? '#ffffff' : '#b9b3e0')
  }
  if (p.moon) circle(c, 266, 36, 6, '#f4ecd0', mix(p.skyTop, '#f4ecd0', 0.25))
  if (p.sun) circle(c, 236, 74, 11, p.day && theme !== 'sunset' ? '#fff3c4' : '#ffe08a', mix(p.skyBot, '#fff0b0', 0.4))

  // skyline
  if (theme === 'library') {
    // trees and rooftops
    for (let x = GLASS.x; x < GLASS.x + GLASS.w; x += 6) {
      const h = 16 + Math.floor(rand() * 18)
      R(c, x, GLASS.y + GLASS.h - h, 7, h, p.city)
      R(c, x + 1, GLASS.y + GLASS.h - h - 2, 5, 2, p.city)
    }
  } else {
    let x = GLASS.x - 4
    while (x < GLASS.x + GLASS.w) {
      const bw = 10 + Math.floor(rand() * 14)
      const bh = 24 + Math.floor(rand() * 44)
      const top = GLASS.y + GLASS.h - bh
      R(c, x, top, bw, bh, p.city)
      if (rand() < 0.3) R(c, x + Math.floor(bw / 2), top - 5, 1, 5, p.city)
      if (!p.day || theme === 'sunset') {
        for (let wy = top + 3; wy < GLASS.y + GLASS.h - 2; wy += 4)
          for (let wx = x + 2; wx < x + bw - 2; wx += 3)
            if (rand() < 0.28) R(c, wx, wy, 1, 2, p.cityWin)
      }
      x += bw + Math.floor(rand() * 3)
    }
  }
  if (theme === 'coffee') {
    // street below: lamp posts + awning
    R(c, GLASS.x, GLASS.y + GLASS.h - 6, GLASS.w, 6, mix(p.city, '#000', 0.3))
    ;[190, 250].forEach(lx => { R(c, lx, GLASS.y + 52, 1, 28, '#0d0f1a'); R(c, lx - 2, GLASS.y + 50, 5, 2, '#ffe3a0') })
  }

  // curtains + rod
  R(c, 156, 11, 152, 2, p.woodDark)
  drawCurtain(c, 158, 13, 14, 108, p)
  drawCurtain(c, 292, 13, 14, 108, p)

  // neon backing plate
  R(c, 96, 30, 54, 26, '#12101c')
  R(c, 97, 31, 52, 24, '#1a1726')

  // bookshelf
  drawShelf(c, 14, 24, 70, 116, p, rand, theme === 'library' ? 5 : 4)
  if (theme === 'library') drawShelf(c, 96, 64, 50, 76, p, rand, 3)

  // floor plant (left of desk)
  if (theme !== 'library') drawPlant(c, 100, 118, 24, p, rand)

  // wall art / calendar
  if (theme !== 'library') {
    R(c, 104, 66, 22, 26, mix(p.wall, '#000', 0.35))
    R(c, 106, 68, 18, 22, '#e9dfc8')
    R(c, 106, 68, 18, 5, '#d9625e')
    for (let r = 0; r < 3; r++) for (let q = 0; q < 4; q++) R(c, 107 + q * 4, 75 + r * 5, 2, 2, '#8a8398')
  }

  // desk
  R(c, 148, 117, 164, 3, p.woodLight)
  R(c, 148, 120, 164, 7, p.wood)
  R(c, 148, 126, 164, 1, p.woodDark)
  R(c, 152, 127, 5, 23, p.woodDark)
  R(c, 303, 127, 5, 23, p.woodDark)
  R(c, 262, 127, 40, 22, p.wood)
  R(c, 262, 137, 40, 1, p.woodDark)
  R(c, 279, 131, 6, 2, p.woodLight); R(c, 279, 142, 6, 2, p.woodLight)

  // desk plant + books
  drawPotPlant(c, 156, 104, p)
  R(c, 168, 112, 16, 5, '#6b5a8a'); R(c, 169, 108, 14, 4, '#c7875a'); R(c, 167, 105, 15, 3, '#5f8a6e')

  // CRT monitor
  R(c, 185, 78, 50, 36, '#b8ad97')
  R(c, 185, 78, 50, 2, '#d6ccb5')
  R(c, 185, 112, 50, 2, '#8e846f')
  R(c, 189, 82, 42, 28, '#2a2a2a')
  R(c, 201, 114, 18, 3, '#9a907b')
  R(c, 228, 110, 4, 1, '#79d67a')
  // keyboard
  R(c, 186, 116, 46, 3, '#cfc5ae')
  for (let k = 0; k < 11; k++) R(c, 188 + k * 4, 116, 2, 1, '#9d937e')

  // mug
  R(c, 240, 109, 8, 8, '#e7ddc6'); R(c, 248, 111, 2, 4, '#e7ddc6'); R(c, 241, 110, 6, 1, '#6b4632')

  // lamp
  R(c, 276, 114, 16, 3, '#2d2b36')
  R(c, 283, 96, 2, 18, '#3a3844')
  R(c, 272, 94, 13, 2, '#3a3844')
  R(c, 262, 88, 14, 7, '#2f5b52')
  R(c, 264, 86, 10, 2, '#3d7568')
  R(c, 263, 95, 12, 1, p.lampOn ? '#ffe5a8' : '#1d3a34')

  // chair
  R(c, 198, 128, 26, 22, '#1d1b28')
  R(c, 196, 146, 30, 4, '#232030')
  R(c, 209, 150, 4, 12, '#15131e')
  R(c, 201, 161, 20, 2, '#15131e')
}

function circle(c: Ctx, cx: number, cy: number, r: number, col: string, halo: string) {
  for (let y = -r - 2; y <= r + 2; y++)
    for (let x = -r - 2; x <= r + 2; x++) {
      const d = x * x + y * y
      if (d <= r * r) R(c, cx + x, cy + y, 1, 1, col)
      else if (d <= (r + 2) * (r + 2) && (x + y) % 2 === 0) R(c, cx + x, cy + y, 1, 1, halo)
    }
}

function drawCurtain(c: Ctx, x: number, y: number, w: number, h: number, p: Palette) {
  R(c, x, y, w, h, p.curtain)
  for (let i = 2; i < w; i += 4) R(c, x + i, y, 1, h, p.curtainDark)
  R(c, x, y + h - 2, w, 2, p.curtainDark)
}

function drawShelf(c: Ctx, x: number, y: number, w: number, h: number, p: Palette, rand: () => number, rows: number) {
  R(c, x, y, w, h, p.woodDark)
  R(c, x + 3, y + 3, w - 6, h - 6, mix(p.woodDark, '#000', 0.35))
  const rowH = Math.floor((h - 6) / rows)
  const bookCols = ['#b8575a', '#5f8a6e', '#c7875a', '#6b5a8a', '#d9c49a', '#4f6d8f', '#9a6b4f', '#8fa25a']
  for (let r = 0; r < rows; r++) {
    const by = y + 3 + r * rowH
    R(c, x + 3, by + rowH - 2, w - 6, 2, p.wood)
    let bx = x + 4
    while (bx < x + w - 6) {
      if (rand() < 0.12) { bx += 4; continue }
      const bw = 2 + Math.floor(rand() * 3)
      const bh = rowH - 5 - Math.floor(rand() * 5)
      const col = bookCols[Math.floor(rand() * bookCols.length)]
      R(c, bx, by + rowH - 2 - bh, bw, bh, col)
      R(c, bx, by + rowH - 2 - bh + 2, bw, 1, mix(col, '#fff', 0.3))
      bx += bw + (rand() < 0.2 ? 1 : 0)
    }
  }
  // top decor: small plant
  R(c, x + 8, y - 6, 8, 6, '#9a5b45')
  R(c, x + 6, y - 12, 4, 6, '#6a8f5a'); R(c, x + 11, y - 14, 4, 8, '#7fa36b'); R(c, x + 15, y - 10, 3, 4, '#5b7d4d')
  R(c, x + w - 20, y - 4, 12, 4, '#6b5a8a'); R(c, x + w - 18, y - 7, 9, 3, '#c7875a')
}

function drawPlant(c: Ctx, x: number, y: number, h: number, _p: Palette, rand: () => number) {
  R(c, x - 7, y + h - 12, 16, 12, '#9a5b45')
  R(c, x - 8, y + h - 13, 18, 2, '#b06a50')
  const greens = ['#5b7d4d', '#6a8f5a', '#7fa36b', '#4c6b40']
  for (let i = 0; i < 14; i++) {
    const lx = x + Math.floor((rand() - 0.5) * 22)
    const ly = y + h - 14 - Math.floor(rand() * 30)
    R(c, lx, ly, 3 + Math.floor(rand() * 3), 2 + Math.floor(rand() * 2), greens[i % 4])
    R(c, x, ly + 2, 1, y + h - 13 - ly, '#4c6b40')
  }
}

function drawPotPlant(c: Ctx, x: number, y: number, _p: Palette) {
  R(c, x, y + 6, 10, 8, '#c2754f'); R(c, x - 1, y + 5, 12, 2, '#d88a62')
  R(c, x + 1, y - 2, 3, 7, '#6a8f5a'); R(c, x + 5, y - 5, 3, 10, '#7fa36b'); R(c, x + 7, y, 4, 5, '#5b7d4d'); R(c, x - 2, y + 1, 4, 3, '#7fa36b')
}

// ---------- tiny 3x5 glyphs for the neon sign ----------
const GLYPHS: Record<string, string[]> = {
  l: ['1..', '1..', '1..', '1..', '11.'],
  o: ['...', '111', '1.1', '1.1', '111'],
  '-': ['...', '...', '111', '...', '...'],
  f: ['.11', '1..', '111', '1..', '1..'],
  i: ['.1.', '...', '.1.', '.1.', '.1.'],
}

// ---------- dynamic layer ----------
export interface SceneState {
  drops: { x: number; y: number; v: number; l: number }[]
  dust: { x: number; y: number; vx: number; vy: number; a: number }[]
  steam: { x: number; y: number; a: number }[]
  codeLines: number[]
  codeOffset: number
  neonOff: number
  t: number
}

export function initState(level: 'off' | 'low' | 'full'): SceneState {
  const nDrops = level === 'full' ? 90 : level === 'low' ? 35 : 0
  const nDust = level === 'full' ? 24 : level === 'low' ? 10 : 0
  const rand = Math.random
  return {
    drops: Array.from({ length: nDrops }, () => ({ x: GLASS.x + rand() * GLASS.w, y: GLASS.y + rand() * GLASS.h, v: 1.5 + rand() * 1.8, l: 3 + Math.floor(rand() * 4) })),
    dust: Array.from({ length: nDust }, () => ({ x: 230 + rand() * 80, y: 70 + rand() * 60, vx: (rand() - 0.5) * 0.08, vy: -0.03 - rand() * 0.05, a: rand() })),
    steam: [],
    codeLines: Array.from({ length: 40 }, () => 4 + Math.floor(Math.random() * 30)),
    codeOffset: 0,
    neonOff: 0,
    t: 0,
  }
}

export function drawDynamic(c: Ctx, s: SceneState, p: Palette, animate: boolean) {
  s.t += 1
  const t = s.t

  // rain inside the window
  if (p.rain) {
    c.save()
    c.beginPath(); c.rect(GLASS.x, GLASS.y, GLASS.w, GLASS.h); c.clip()
    c.fillStyle = p.day ? 'rgba(255,255,255,0.55)' : 'rgba(170,190,255,0.45)'
    for (const d of s.drops) {
      for (let i = 0; i < d.l; i++) c.fillRect(Math.floor(d.x - i * 0.35), Math.floor(d.y - i), 1, 1)
      if (animate) {
        d.y += d.v; d.x += 0.35 * d.v * 0.5
        if (d.y > GLASS.y + GLASS.h + 6) { d.y = GLASS.y - Math.random() * 20; d.x = GLASS.x - 10 + Math.random() * (GLASS.w + 10) }
      }
    }
    c.restore()
  }

  // window frame + muntins over the glass
  const frame = p.woodDark
  R(c, 168, 18, 128, 4, frame); R(c, 168, 108, 128, 4, frame)
  R(c, 168, 18, 4, 94, frame); R(c, 292, 18, 4, 94, frame)
  R(c, 231, 22, 2, 86, frame); R(c, 172, 64, 120, 2, frame)
  R(c, 164, 111, 136, 4, p.woodLight); R(c, 164, 115, 136, 1, p.woodDark)
  // glass sheen
  c.globalAlpha = p.day ? 0.18 : 0.07
  for (let i = 0; i < 18; i++) R(c, 178 + i, 26 + i * 2, 2, 1, '#ffffff')
  c.globalAlpha = 1

  // sleeping cat on the sill, tail swaying
  const cat = '#16141f'
  R(c, 238, 104, 18, 7, cat); R(c, 240, 102, 12, 2, cat)
  R(c, 252, 100, 6, 5, cat); R(c, 252, 98, 2, 2, cat); R(c, 256, 98, 2, 2, cat)
  const sway = animate ? Math.round(Math.sin(t / 40) * 2) : 0
  R(c, 234, 108, 4, 2, cat); R(c, 232 + sway, 105, 2, 4, cat)

  // CRT screen content
  const sx = 190, sy = 83, sw = 40, sh = 26
  R(c, sx, sy, sw, sh, p.day ? '#1c2a26' : '#10201c')
  c.save(); c.beginPath(); c.rect(sx, sy, sw, sh); c.clip()
  if (animate && t % 12 === 0) s.codeOffset = (s.codeOffset + 1) % s.codeLines.length
  for (let i = 0; i < 8; i++) {
    const len = s.codeLines[(s.codeOffset + i) % s.codeLines.length]
    const indent = (len % 3) * 2
    R(c, sx + 2 + indent, sy + 2 + i * 3, Math.min(len, sw - 6 - indent), 1, i % 3 === 0 ? '#9be89c' : '#6fcf97')
  }
  if (Math.floor(t / 20) % 2 === 0) R(c, sx + 2, sy + 2 + 8 * 3, 2, 2, '#c8ffc8')
  c.restore()
  c.globalAlpha = 0.12 + (animate ? Math.sin(t / 7) * 0.02 : 0)
  R(c, sx - 3, sy - 3, sw + 6, sh + 6, '#7dffb0')
  c.globalAlpha = 1

  // neon sign
  if (animate) {
    if (s.neonOff > 0) s.neonOff--
    else if (Math.random() < 0.004) s.neonOff = 3 + Math.floor(Math.random() * 6)
  }
  const lit = s.neonOff === 0 || s.neonOff % 2 === 0
  const neon = lit ? p.neon : mix(p.neon, '#1a1726', 0.7)
  const text = 'lo-fi'
  let gx = 103
  for (const ch of text) {
    const g = GLYPHS[ch]
    for (let yy = 0; yy < 5; yy++) for (let xx = 0; xx < 3; xx++)
      if (g[yy][xx] === '1') {
        if (lit) { c.globalAlpha = 0.25; R(c, gx + xx * 2 - 1, 35 + yy * 3 - 1, 4, 4, neon); c.globalAlpha = 1 }
        R(c, gx + xx * 2, 35 + yy * 3, 2, 2, neon)
      }
    gx += 8
  }
  if (lit) {
    c.globalAlpha = 0.06
    R(c, 88, 24, 70, 38, p.neon)
    c.globalAlpha = 1
  }

  // steam from the mug
  if (animate) {
    if (t % 14 === 0) s.steam.push({ x: 243 + Math.random() * 3, y: 107, a: 0.5 })
    s.steam.forEach(q => { q.y -= 0.12; q.x += Math.sin((q.y + t) / 6) * 0.08; q.a -= 0.004 })
    s.steam = s.steam.filter(q => q.a > 0)
  }
  for (const q of s.steam) { c.globalAlpha = q.a; R(c, Math.round(q.x), Math.round(q.y), 1, 2, '#e9e3d8') }
  c.globalAlpha = 1

  // lamp glow
  if (p.lampOn) {
    const flick = animate ? 0.9 + Math.sin(t / 13) * 0.02 + (Math.random() - 0.5) * 0.02 : 0.9
    const g = c.createRadialGradient(269, 104, 2, 269, 104, 70)
    g.addColorStop(0, `rgba(255,196,120,${0.45 * flick})`)
    g.addColorStop(0.5, `rgba(255,170,90,${0.14 * flick})`)
    g.addColorStop(1, 'rgba(255,160,80,0)')
    c.globalCompositeOperation = 'lighter'
    c.fillStyle = g
    c.fillRect(190, 30, 130, 130)
    c.globalCompositeOperation = 'source-over'
    // light pool on desk
    c.globalAlpha = 0.18 * flick
    R(c, 250, 117, 44, 2, '#ffd9a0')
    c.globalAlpha = 1
  }

  // dust motes in the light
  for (const d of s.dust) {
    if (animate) {
      d.x += d.vx; d.y += d.vy; d.a += 0.02
      if (d.y < 60) { d.y = 130; d.x = 230 + Math.random() * 80 }
    }
    c.globalAlpha = 0.25 + Math.abs(Math.sin(d.a)) * 0.35
    R(c, Math.round(d.x), Math.round(d.y), 1, 1, p.lampOn ? '#ffe6b8' : '#ffffff')
  }
  c.globalAlpha = 1

  // overall mood tint for night
  if (!p.day) {
    c.globalAlpha = 0.12
    R(c, 0, 0, W, H, '#1a1440')
    c.globalAlpha = 1
  }
}
