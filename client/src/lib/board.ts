/** Shared helpers for the notebook-paper whiteboards. */
export const BW = 1200
export const BH = 800

export const BOARD_COLORS = [
  { c: '#2e2940', n: 'Ink' },
  { c: '#3b5ba5', n: 'Blue' },
  { c: '#c2404f', n: 'Red' },
  { c: '#4f7a3a', n: 'Green' },
  { c: '#c9701f', n: 'Amber' },
]

export function paintPaper(c: CanvasRenderingContext2D, w = BW, h = BH) {
  c.fillStyle = '#f6efdf'
  c.fillRect(0, 0, w, h)
  c.fillStyle = '#c9d6ea'
  for (let y = 60; y < h; y += 40) c.fillRect(0, y, w, 2)
  c.fillStyle = '#e8a8a8'
  c.fillRect(90, 0, 2, h)
}

export function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Could not load image'))
    img.src = src
  })
}

/** The saved whiteboard (transparent ink) on paper, as a JPEG data URL for sending in chat. */
export async function boardSnapshot(ink: string | null) {
  const out = document.createElement('canvas')
  out.width = BW
  out.height = BH
  const c = out.getContext('2d')!
  paintPaper(c)
  if (ink) c.drawImage(await loadImage(ink), 0, 0)
  return out.toDataURL('image/jpeg', 0.85)
}

/** Shrink a picked image so it fits chat limits (longest side 1280px, JPEG). */
export async function prepareImage(file: File) {
  if (!file.type.startsWith('image/')) throw new Error('Pick an image file')
  const url = URL.createObjectURL(file)
  try {
    const img = await loadImage(url)
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height))
    const out = document.createElement('canvas')
    out.width = Math.round(img.width * scale)
    out.height = Math.round(img.height * scale)
    const c = out.getContext('2d')!
    c.fillStyle = '#ffffff'
    c.fillRect(0, 0, out.width, out.height)
    c.drawImage(img, 0, 0, out.width, out.height)
    const data = out.toDataURL('image/jpeg', 0.82)
    if (data.length > 1_900_000) throw new Error('That image is too large even after shrinking it')
    return data
  } finally {
    URL.revokeObjectURL(url)
  }
}
