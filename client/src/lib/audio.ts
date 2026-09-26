import type { SoundId } from './types'

/**
 * Every sound is synthesised with the Web Audio API, so the panel works with no
 * audio files. To use real recordings later, replace a builder below with an
 * <audio>/AudioBuffer source connected to `out`.
 */

interface Voice { out: GainNode; stop: () => void }

type NoiseKind = 'white' | 'pink' | 'brown'

function noiseBuffer(ctx: AudioContext, kind: NoiseKind, seconds = 4) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1
    if (kind === 'white') d[i] = w * 0.5
    else if (kind === 'pink') {
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11
      b6 = w * 0.115926
    } else {
      last = (last + 0.02 * w) / 1.02
      d[i] = last * 3.5
    }
  }
  return buf
}

export const STATIONS: { name: string; bpm: number; chords: number[][]; scale: number[] }[] = [
  {
    name: 'Night Desk Radio: slow jazzy loops',
    bpm: 74,
    chords: [[50, 53, 57, 60, 64], [43, 53, 55, 59, 62], [48, 52, 55, 59, 62], [45, 52, 55, 60, 64]],
    scale: [62, 64, 67, 69, 72, 74, 76],
  },
  {
    name: 'Rainy Window FM: mellow keys',
    bpm: 68,
    chords: [[41, 52, 57, 60, 64], [40, 50, 55, 59, 62], [38, 53, 57, 60, 64], [43, 53, 57, 59, 62]],
    scale: [60, 62, 64, 67, 69, 72, 74],
  },
  {
    name: 'Late Library Beats: soft and steady',
    bpm: 80,
    chords: [[45, 55, 60, 64, 67], [41, 55, 57, 60, 64], [48, 55, 59, 62, 64], [43, 53, 57, 59, 62]],
    scale: [64, 67, 69, 71, 72, 76, 79],
  },
]

export class AmbientEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private buffers: Partial<Record<NoiseKind, AudioBuffer>> = {}
  private voices: Partial<Record<SoundId, Voice>> = {}
  private masterLevel = 0.7
  station = 0

  /** Switch the lo-fi loop to another progression; crossfades if it is playing. */
  setStation(i: number, vol: number) {
    this.station = ((i % STATIONS.length) + STATIONS.length) % STATIONS.length
    if (this.voices.lofi) { this.set('lofi', false, 0); this.set('lofi', true, vol) }
  }

  private ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.ctx = new AC()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.masterLevel
      this.master.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private noise(kind: NoiseKind) {
    const ctx = this.ensure()
    if (!this.buffers[kind]) this.buffers[kind] = noiseBuffer(ctx, kind)
    const src = ctx.createBufferSource()
    src.buffer = this.buffers[kind]!
    src.loop = true
    src.loopStart = Math.random()
    return src
  }

  setMaster(v: number) {
    this.masterLevel = v
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.1)
  }

  set(id: SoundId, on: boolean, vol: number) {
    if (!on) {
      const v = this.voices[id]
      if (v && this.ctx) {
        v.out.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25)
        delete this.voices[id]
        setTimeout(() => v.stop(), 1500)
      }
      return
    }
    const ctx = this.ensure()
    let v = this.voices[id]
    if (!v) {
      v = this.build(id)
      v.out.gain.value = 0
      v.out.connect(this.master!)
      this.voices[id] = v
    }
    v.out.gain.setTargetAtTime(vol, ctx.currentTime, 0.3)
  }

  stopAll() {
    (Object.keys(this.voices) as SoundId[]).forEach(id => this.set(id, false, 0))
  }

  chime() {
    const ctx = this.ensure()
    const t = ctx.currentTime
    ;[659.25, 987.77, 1318.5].forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = f
      g.gain.setValueAtTime(0, t + i * 0.18)
      g.gain.linearRampToValueAtTime(0.18, t + i * 0.18 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 1.4)
      o.connect(g).connect(this.master!)
      o.start(t + i * 0.18)
      o.stop(t + i * 0.18 + 1.5)
    })
  }

  // ---------- builders ----------
  private build(id: SoundId): Voice {
    switch (id) {
      case 'rain': return this.rain()
      case 'fire': return this.fire()
      case 'cafe': return this.cafe()
      case 'library': return this.library()
      case 'brown': return this.brown()
      case 'lofi': return this.lofi()
    }
  }

  /** helper: fire short filtered noise bursts at random intervals */
  private bursts(out: AudioNode, opts: { min: number; max: number; dur: [number, number]; freq: [number, number]; q: number; gain: [number, number]; type?: BiquadFilterType }) {
    const ctx = this.ctx!
    let alive = true
    let timer = 0
    const fire = () => {
      if (!alive) return
      const t = ctx.currentTime
      const dur = opts.dur[0] + Math.random() * (opts.dur[1] - opts.dur[0])
      const src = this.noise('white')
      const f = ctx.createBiquadFilter()
      f.type = opts.type ?? 'bandpass'
      f.frequency.value = opts.freq[0] + Math.random() * (opts.freq[1] - opts.freq[0])
      f.Q.value = opts.q
      const g = ctx.createGain()
      const peak = opts.gain[0] + Math.random() * (opts.gain[1] - opts.gain[0])
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(peak, t + Math.min(0.01, dur / 4))
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      src.connect(f).connect(g).connect(out)
      src.start(t)
      src.stop(t + dur + 0.05)
      timer = window.setTimeout(fire, opts.min + Math.random() * (opts.max - opts.min))
    }
    timer = window.setTimeout(fire, opts.min)
    return () => { alive = false; clearTimeout(timer) }
  }

  private rain(): Voice {
    const ctx = this.ensure()
    const out = ctx.createGain()
    const a = this.noise('pink')
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 400
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 6500
    const ga = ctx.createGain(); ga.gain.value = 0.9
    a.connect(hp).connect(lp).connect(ga).connect(out)
    // slow swell
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.08
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.2
    lfo.connect(lfoG).connect(ga.gain)
    a.start(); lfo.start()
    const stopDrops = this.bursts(out, { min: 40, max: 260, dur: [0.01, 0.04], freq: [2500, 6000], q: 3, gain: [0.05, 0.25] })
    return { out, stop: () => { stopDrops(); a.stop(); lfo.stop(); out.disconnect() } }
  }

  private fire(): Voice {
    const ctx = this.ensure()
    const out = ctx.createGain()
    const a = this.noise('brown')
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 450
    const g = ctx.createGain(); g.gain.value = 1.1
    a.connect(lp).connect(g).connect(out)
    a.start()
    const stopCrackle = this.bursts(out, { min: 25, max: 320, dur: [0.005, 0.05], freq: [1500, 5000], q: 1.2, gain: [0.1, 0.6], type: 'highpass' })
    const stopPop = this.bursts(out, { min: 800, max: 3000, dur: [0.06, 0.15], freq: [300, 900], q: 2, gain: [0.3, 0.7] })
    return { out, stop: () => { stopCrackle(); stopPop(); a.stop(); out.disconnect() } }
  }

  private cafe(): Voice {
    const ctx = this.ensure()
    const out = ctx.createGain()
    const room = this.noise('pink')
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 600; bp.Q.value = 0.6
    const rg = ctx.createGain(); rg.gain.value = 0.5
    room.connect(bp).connect(rg).connect(out)
    room.start()
    // babble: narrow bands wandering through speech formant range
    const voices: { src: AudioBufferSourceNode; f: BiquadFilterNode; g: GainNode }[] = []
    for (let i = 0; i < 4; i++) {
      const src = this.noise('white')
      const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 9; f.frequency.value = 400
      const g = ctx.createGain(); g.gain.value = 0
      src.connect(f).connect(g).connect(out)
      src.start()
      voices.push({ src, f, g })
    }
    const wander = window.setInterval(() => {
      const t = ctx.currentTime
      voices.forEach(v => {
        v.f.frequency.setTargetAtTime(250 + Math.random() * 800, t, 0.05)
        v.g.gain.setTargetAtTime(Math.random() < 0.4 ? 0 : 0.15 + Math.random() * 0.35, t, 0.06)
      })
    }, 180)
    // cups and spoons
    let alive = true
    let clinkT = 0
    const clink = () => {
      if (!alive) return
      const t = ctx.currentTime
      ;[1, 2.76].forEach(mult => {
        const o = ctx.createOscillator(); o.type = 'sine'
        o.frequency.value = (2200 + Math.random() * 1400) * mult
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.04 / mult, t)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
        o.connect(g).connect(out); o.start(t); o.stop(t + 0.4)
      })
      clinkT = window.setTimeout(clink, 1800 + Math.random() * 5000)
    }
    clinkT = window.setTimeout(clink, 1500)
    return {
      out,
      stop: () => { alive = false; clearTimeout(clinkT); clearInterval(wander); room.stop(); voices.forEach(v => v.src.stop()); out.disconnect() },
    }
  }

  private library(): Voice {
    const ctx = this.ensure()
    const out = ctx.createGain()
    const hum = this.noise('brown')
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260
    const g = ctx.createGain(); g.gain.value = 0.5
    hum.connect(lp).connect(g).connect(out)
    hum.start()
    const pages = this.bursts(out, { min: 4000, max: 11000, dur: [0.18, 0.4], freq: [1800, 3500], q: 0.8, gain: [0.08, 0.16] })
    const tick = window.setInterval(() => {
      const t = ctx.currentTime
      const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = 2400
      const tg = ctx.createGain()
      tg.gain.setValueAtTime(0.012, t); tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.02)
      o.connect(tg).connect(out); o.start(t); o.stop(t + 0.03)
    }, 1000)
    return { out, stop: () => { pages(); clearInterval(tick); hum.stop(); out.disconnect() } }
  }

  private brown(): Voice {
    const ctx = this.ensure()
    const out = ctx.createGain()
    const a = this.noise('brown')
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900
    a.connect(lp).connect(out)
    a.start()
    return { out, stop: () => { a.stop(); out.disconnect() } }
  }

  /** A small procedural lo-fi loop: ii–V–I–vi chords, swung drums, bass, vinyl crackle. */
  private lofi(): Voice {
    const ctx = this.ensure()
    const out = ctx.createGain()
    const warm = ctx.createBiquadFilter(); warm.type = 'lowpass'; warm.frequency.value = 2600
    warm.connect(out)
    // tape wobble shared by chord voices
    const wob = ctx.createOscillator(); wob.frequency.value = 0.45
    const wobG = ctx.createGain(); wobG.gain.value = 9
    wob.connect(wobG); wob.start()

    const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12)
    const st = STATIONS[this.station] ?? STATIONS[0]
    const chords = st.chords
    const scale = st.scale
    const bpm = st.bpm
    const step16 = 60 / bpm / 4
    let step = 0
    let next = ctx.currentTime + 0.1

    const note = (m: number, t: number, dur: number, gain: number, type: OscillatorType, detune = 0) => {
      const o = ctx.createOscillator(); o.type = type; o.frequency.value = mtof(m); o.detune.value = detune
      wobG.connect(o.detune)
      const g = ctx.createGain()
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(gain, t + 0.04)
      g.gain.setTargetAtTime(0, t + dur, 0.25)
      o.connect(g).connect(warm)
      o.start(t); o.stop(t + dur + 1.5)
      o.onended = () => { try { wobG.disconnect(o.detune) } catch { /* already gone */ } }
    }
    const drum = (t: number, kind: 'kick' | 'snare' | 'hat') => {
      if (kind === 'kick') {
        const o = ctx.createOscillator(); o.type = 'sine'
        o.frequency.setValueAtTime(120, t); o.frequency.exponentialRampToValueAtTime(42, t + 0.25)
        const g = ctx.createGain(); g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
        o.connect(g).connect(out); o.start(t); o.stop(t + 0.4)
      } else {
        const src = this.noise('white')
        const f = ctx.createBiquadFilter()
        f.type = kind === 'snare' ? 'bandpass' : 'highpass'
        f.frequency.value = kind === 'snare' ? 1600 : 7000
        const g = ctx.createGain()
        const peak = kind === 'snare' ? 0.25 : 0.05
        const len = kind === 'snare' ? 0.18 : 0.04
        g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + len)
        src.connect(f).connect(g).connect(out); src.start(t); src.stop(t + len + 0.05)
      }
    }

    const schedule = () => {
      while (next < ctx.currentTime + 0.2) {
        const bar = Math.floor(step / 16) % 4
        const s = step % 16
        const swing = s % 2 === 1 ? step16 * 0.28 : 0
        const t = next + swing
        const chord = chords[bar]
        if (s === 0) chord.slice(1).forEach((m, i) => note(m, t + i * 0.012, step16 * 14, 0.035, 'triangle', i % 2 ? 6 : -6))
        if (s === 0 || s === 10) note(chord[0] - 12, t, step16 * 5, 0.16, 'sine')
        if (s === 0 || s === 7 || s === 10) drum(t, 'kick')
        if (s === 4 || s === 12) drum(t, 'snare')
        if (s % 2 === 0) drum(t, 'hat')
        if (s % 4 === 2 && Math.random() < 0.35) note(scale[Math.floor(Math.random() * scale.length)], t, step16 * 3, 0.03, 'sine')
        next += step16
        step++
      }
    }
    schedule()
    const iv = window.setInterval(schedule, 50)
    const crackle = this.noise('brown')
    const cg = ctx.createGain(); cg.gain.value = 0.05
    crackle.connect(cg).connect(out); crackle.start()
    const pops = this.bursts(out, { min: 60, max: 600, dur: [0.002, 0.006], freq: [2000, 6000], q: 1, gain: [0.05, 0.2], type: 'highpass' })
    return { out, stop: () => { clearInterval(iv); pops(); crackle.stop(); wob.stop(); out.disconnect() } }
  }
}

export const engine = new AmbientEngine()

export const SOUND_LABELS: Record<SoundId, string> = {
  rain: 'Rain',
  fire: 'Fireplace',
  cafe: 'Coffee shop',
  library: 'Library',
  brown: 'Brown noise',
  lofi: 'Lo-fi music',
}
