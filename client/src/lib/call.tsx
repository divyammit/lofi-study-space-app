import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useStore } from './store'
import { useChat } from './chat'
import { api } from './api'
import { engine } from './audio'
import type { BoardState, BoardStroke, CallParticipant, CallSummary } from './types'

/**
 * Group calls use a "mesh": every browser connects directly to every other one (max 8 people).
 * The server only relays the setup messages (offers, answers, network candidates).
 *
 * To avoid tricky renegotiation, every connection is created with exactly one audio and one
 * video slot. Turning the camera on/off or sharing the screen just swaps what's in the video slot.
 */

/** key is 'chat:<chatId>' for chat calls or 'room:<roomId>' for Study Street rooms */
interface ActiveCall { key: string; mySocketId: string; joinedAt: number }

interface CallStore {
  call: ActiveCall | null
  joining: boolean
  participants: CallParticipant[]
  remoteStreams: Record<string, MediaStream>
  localStream: MediaStream | null
  micOn: boolean
  camOn: boolean
  screenOn: boolean
  canShareScreen: boolean
  expanded: boolean
  setExpanded: (v: boolean) => void
  /** connection state per remote person: 'new' | 'connecting' | 'connected' | 'failed' ... */
  peerStates: Record<string, RTCPeerConnectionState>
  relayAvailable: boolean
  /** live sound levels (0..1) measured from the connections: per remote socket id, plus 'me' for your mic */
  levels: Record<string, number>
  /** remote people whose sound packets are actually arriving */
  hearing: Record<string, boolean>
  /** the browser refused to start playing call sound until the user taps something */
  audioBlocked: boolean
  /** start every paused call sound (call from a click/tap) */
  unlockAudio: () => void
  /** rebuild every sound player; can kick phones into the right speaker */
  fixSound: () => void
  join: (key: string, video: boolean) => Promise<void>
  leave: () => void
  toggleMic: () => void
  toggleCam: () => Promise<void>
  toggleScreen: () => Promise<void>
  board: BoardState | null
  openBoard: (bg: string | null) => void
  closeBoard: () => void
  clearBoard: () => void
  sendStroke: (s: BoardStroke) => void
  onStrokes: (fn: (s: BoardStroke[]) => void) => () => void
}

const Ctx = createContext<CallStore | null>(null)
export const useCall = () => {
  const c = useContext(Ctx)
  if (!c) throw new Error('useCall outside CallProvider')
  return c
}

const say = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function CallProvider({ children }: { children: ReactNode }) {
  const { socket, account, toast, settings, myRoom } = useStore()
  const { chats, chatTitle, openChat } = useChat()
  // (chats is read through chatsRef inside socket handlers)
  const [call, setCall] = useState<ActiveCall | null>(null)
  const [joining, setJoining] = useState(false)
  const [participants, setParticipants] = useState<CallParticipant[]>([])
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({})
  const [localStream, setLocalStream] = useState<MediaStream | null>(null)
  const [micOn, setMicOn] = useState(true)
  const [camOn, setCamOn] = useState(false)
  const [screenOn, setScreenOn] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [board, setBoard] = useState<BoardState | null>(null)
  const [peerStates, setPeerStates] = useState<Record<string, RTCPeerConnectionState>>({})
  const [relayAvailable, setRelayAvailable] = useState(false)
  const [levels, setLevels] = useState<Record<string, number>>({})
  const [hearing, setHearing] = useState<Record<string, boolean>>({})
  const [audioBlocked, setAudioBlocked] = useState(false)

  const callRef = useRef<ActiveCall | null>(null)
  callRef.current = call
  const peers = useRef(new Map<string, RTCPeerConnection>())
  const pendingIce = useRef(new Map<string, RTCIceCandidateInit[]>())
  const chains = useRef(new Map<string, Promise<void>>())
  const iceServers = useRef<RTCIceServer[] | null>(null)
  const audioTrack = useRef<MediaStreamTrack | null>(null)
  const camTrack = useRef<MediaStreamTrack | null>(null)
  const screenTrack = useRef<MediaStreamTrack | null>(null)
  const strokeListeners = useRef(new Set<(s: BoardStroke[]) => void>())
  const strokeQueue = useRef<BoardStroke[]>([])
  const strokeTimer = useRef(0)
  const chatsRef = useRef(chats)
  chatsRef.current = chats

  const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices

  const videoTrack = () => screenTrack.current ?? camTrack.current

  const refreshLocal = useCallback(() => {
    const tracks = [videoTrack()].filter((t): t is MediaStreamTrack => !!t)
    setLocalStream(tracks.length ? new MediaStream(tracks) : null)
  }, [])

  const emitMedia = useCallback(() => {
    socket?.emit('call:media', {
      audio: !!audioTrack.current?.enabled,
      video: !!camTrack.current && !screenTrack.current,
      screen: !!screenTrack.current,
    })
  }, [socket])

  const signal = useCallback((to: string, data: unknown) => socket?.emit('rtc:signal', { to, data }), [socket])

  /** Put `track` into the audio or video slot of every connection. */
  const setSlot = useCallback(async (kind: 'audio' | 'video', track: MediaStreamTrack | null) => {
    for (const pc of peers.current.values()) {
      const t = pc.getTransceivers().find(x => x.receiver.track?.kind === kind)
      if (t) await t.sender.replaceTrack(track).catch(() => {})
    }
  }, [])

  // ----- call sound -----
  // Each remote person's voice plays through its own hidden <audio> element that lives directly in
  // <body>, completely separate from the video tiles. That way sound never depends on whether
  // anyone has a camera on, whether the call window is open or minimised, or how React redraws.
  const sinks = useRef(new Map<string, HTMLAudioElement>())
  const blockedSet = useRef(new Set<string>())
  const sinkHolder = () => {
    let h = document.getElementById('lofi-call-audio')
    if (!h) {
      h = document.createElement('div')
      h.id = 'lofi-call-audio'
      h.setAttribute('aria-hidden', 'true')
      h.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none'
      document.body.appendChild(h)
    }
    return h
  }
  const playSink = useCallback((id: string, el: HTMLAudioElement) => {
    if (!el.srcObject) return
    el.muted = false
    el.volume = 1
    el.play().then(
      () => { blockedSet.current.delete(id); setAudioBlocked(blockedSet.current.size > 0) },
      (e: unknown) => {
        // NotAllowedError = autoplay policy; anything else (AbortError) is a harmless interruption
        if (e instanceof DOMException && e.name === 'NotAllowedError') { blockedSet.current.add(id); setAudioBlocked(true) }
      },
    )
  }, [])
  const attachAudio = useCallback((id: string, track: MediaStreamTrack) => {
    let el = sinks.current.get(id)
    if (!el) {
      el = document.createElement('audio')
      el.autoplay = true
      el.setAttribute('playsinline', '')
      el.dataset.peer = id
      sinkHolder().appendChild(el)
      sinks.current.set(id, el)
    }
    const cur = (el.srcObject as MediaStream | null)?.getAudioTracks()[0]
    if (cur !== track) el.srcObject = new MediaStream([track])
    const sink = el
    // a remote track starts "muted" until the first packets arrive, then plays
    track.onunmute = () => playSink(id, sink)
    playSink(id, el)
  }, [playSink])
  const removeAudio = useCallback((id: string) => {
    const el = sinks.current.get(id)
    if (el) { el.pause(); el.srcObject = null; el.remove() }
    sinks.current.delete(id)
    blockedSet.current.delete(id)
    setAudioBlocked(blockedSet.current.size > 0)
  }, [])
  const unlockAudio = useCallback(() => {
    for (const [id, el] of sinks.current) if (el.paused) playSink(id, el)
  }, [playSink])
  const fixSound = useCallback(() => {
    for (const [id, el] of sinks.current) {
      const st = el.srcObject as MediaStream | null
      const t = st?.getAudioTracks()[0]
      el.pause()
      el.srcObject = null
      if (t) { el.srcObject = new MediaStream([t]); playSink(id, el) }
    }
    toast('Restarted call sound. Still silent? Check your volume, or try headphones.')
  }, [playSink, toast])

  const dropPeer = useCallback((id: string) => {
    removeAudio(id)
    peers.current.get(id)?.close()
    peers.current.delete(id)
    pendingIce.current.delete(id)
    chains.current.delete(id)
    setRemoteStreams(s => { const n = { ...s }; delete n[id]; return n })
    setPeerStates(s => { const n = { ...s }; delete n[id]; return n })
  }, [removeAudio])

  const makePeer = useCallback((remoteId: string) => {
    // debugging aid: localStorage.setItem('lofi:forceRelay', '1') forces calls through the TURN relay
    const forceRelay = (() => { try { return localStorage.getItem('lofi:forceRelay') === '1' } catch { return false } })()
    const pc = new RTCPeerConnection({ iceServers: iceServers.current ?? [], iceTransportPolicy: forceRelay ? 'relay' : 'all' })
    peers.current.set(remoteId, pc)
    pc.onicecandidate = e => { if (e.candidate) signal(remoteId, { candidate: e.candidate.toJSON() }) }
    pc.ontrack = e => {
      // sound goes to its own player; the stream given to the tile only carries the picture
      if (e.track.kind === 'audio') attachAudio(remoteId, e.track)
      const vids = pc.getReceivers().map(r => r.track).filter(t => t?.kind === 'video')
      setRemoteStreams(s => ({ ...s, [remoteId]: new MediaStream(vids) }))
    }
    let restarted = false
    let gaveUp = false
    let timer = 0
    const giveUp = () => {
      if (gaveUp || pc.connectionState === 'connected' || pc.connectionState === 'closed') return
      if (!restarted && initiatorRef.current.has(remoteId)) {
        // one retry with fresh network routes before giving up
        restarted = true
        pc.restartIce()
        pc.createOffer({ iceRestart: true }).then(o => pc.setLocalDescription(o)).then(() => signal(remoteId, { sdp: pc.localDescription })).catch(() => {})
        timer = window.setTimeout(giveUp, 15000)
        return
      }
      gaveUp = true
      setPeerStates(s => ({ ...s, [remoteId]: 'failed' }))
      const who = participantsRef.current.find(p => p.socketId === remoteId)?.name ?? 'someone'
      toast(relayRef.current
        ? `Couldn't connect the call with ${who}. Check both internet connections.`
        : `Couldn't connect audio/video with ${who}: a network is blocking direct calls. The site needs a TURN relay (see DEPLOY.md).`)
    }
    // browsers can keep "connecting" forever on a blocked network, so give it a time limit
    timer = window.setTimeout(giveUp, 20000)
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      if (st === 'connected') { clearTimeout(timer); gaveUp = false }
      if (st === 'closed') clearTimeout(timer)
      if (!gaveUp || st === 'connected') setPeerStates(s => ({ ...s, [remoteId]: st }))
      if (st === 'failed') { clearTimeout(timer); giveUp() }
    }
    return pc
  }, [signal, toast, attachAudio])

  const initiatorRef = useRef(new Set<string>()) // peers we sent the first offer to
  const relayRef = useRef(false)
  const participantsRef = useRef(participants)
  participantsRef.current = participants

  /** We joined: call everyone already in the call. */
  const callPeer = useCallback(async (remoteId: string) => {
    initiatorRef.current.add(remoteId)
    const pc = makePeer(remoteId)
    const a = pc.addTransceiver('audio', { direction: 'sendrecv' })
    const v = pc.addTransceiver('video', { direction: 'sendrecv' })
    await a.sender.replaceTrack(audioTrack.current)
    await v.sender.replaceTrack(videoTrack())
    await pc.setLocalDescription(await pc.createOffer())
    signal(remoteId, { sdp: pc.localDescription })
  }, [makePeer, signal])

  const handleSignal = useCallback(async (from: string, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }) => {
    if (!callRef.current) return
    let pc = peers.current.get(from)
    if (data.sdp?.type === 'offer') {
      if (!pc) pc = makePeer(from)
      await pc.setRemoteDescription(data.sdp)
      // answer using the slots the offer created, filled with our mic and camera
      for (const t of pc.getTransceivers()) {
        const kind = t.receiver.track?.kind
        t.direction = 'sendrecv'
        await t.sender.replaceTrack(kind === 'audio' ? audioTrack.current : videoTrack()).catch(() => {})
      }
      await pc.setLocalDescription(await pc.createAnswer())
      signal(from, { sdp: pc.localDescription })
    } else if (data.sdp?.type === 'answer' && pc) {
      await pc.setRemoteDescription(data.sdp)
    } else if (data.candidate) {
      if (pc?.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {})
      else pendingIce.current.set(from, [...(pendingIce.current.get(from) ?? []), data.candidate])
      return
    }
    // network candidates that arrived before the offer/answer
    const queued = pendingIce.current.get(from)
    if (pc?.remoteDescription && queued?.length) {
      pendingIce.current.delete(from)
      for (const c of queued) await pc.addIceCandidate(c).catch(() => {})
    }
  }, [makePeer, signal])

  const cleanup = useCallback(() => {
    for (const id of [...peers.current.keys()]) dropPeer(id)
    ;[audioTrack, camTrack, screenTrack].forEach(r => { r.current?.stop(); r.current = null })
    clearTimeout(strokeTimer.current)
    strokeQueue.current = []
    setCall(null)
    setParticipants([])
    setRemoteStreams({})
    setLocalStream(null)
    setBoard(null)
    setScreenOn(false)
    setCamOn(false)
    setMicOn(true)
    setPeerStates({})
    setLevels({})
    setHearing({})
    initiatorRef.current.clear()
  }, [dropPeer])

  const leave = useCallback(() => {
    if (!callRef.current) return
    socket?.emit('call:leave', {}, () => {})
    cleanup()
  }, [socket, cleanup])

  const join = useCallback(async (key: string, video: boolean) => {
    if (!socket?.connected) { toast('Not connected to the server yet. Try again in a moment.'); return }
    if (callRef.current?.key === key) { setExpanded(true); return }
    if (callRef.current) leave()
    if (!navigator.mediaDevices?.getUserMedia) { toast('Calls need a browser with microphone access over https.'); return }
    setJoining(true)
    try {
      // fetched on every join, so rotating TURN credentials stay fresh
      const cfg = await api<{ iceServers: RTCIceServer[]; relay: boolean }>('/api/rtc-config')
      iceServers.current = cfg.iceServers
      relayRef.current = cfg.relay
      setRelayAvailable(cfg.relay)
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: video ? { width: { ideal: 640 }, height: { ideal: 480 } } : false })
        audioTrack.current = s.getAudioTracks()[0] ?? null
        camTrack.current = s.getVideoTracks()[0] ?? null
      } catch {
        if (video) {
          // camera blocked or missing: try microphone only
          try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true })
            audioTrack.current = s.getAudioTracks()[0] ?? null
            toast("Couldn't use your camera, so you joined with audio only.")
          } catch { toast('Microphone and camera are blocked. You can listen, but others won\'t hear you.') }
        } else {
          toast("Your microphone is blocked. You can listen, but others won't hear you. Allow it in the browser's address bar.")
        }
      }
      setMicOn(!!audioTrack.current)
      setCamOn(!!camTrack.current)
      refreshLocal()
      const res = await new Promise<{ ok: boolean; error?: string; mySocketId: string; participants: CallParticipant[]; board: BoardState | null }>(resolve =>
        socket.timeout(10000).emit('call:join', { key, video: !!camTrack.current }, (err: Error | null, r: { ok: boolean; error?: string; mySocketId: string; participants: CallParticipant[]; board: BoardState | null }) =>
          resolve(err ? { ok: false, error: 'The server did not respond', mySocketId: '', participants: [], board: null } : r)),
      )
      if (!res.ok) { cleanup(); toast(res.error ?? 'Could not join the call'); return }
      const active = { key, mySocketId: res.mySocketId, joinedAt: Date.now() }
      callRef.current = active
      setCall(active)
      setExpanded(true)
      setBoard(res.board)
      setParticipants(res.participants)
      emitMedia()
      for (const p of res.participants) void callPeer(p.socketId).catch(e => console.error('call peer failed', say(e)))
    } catch (e) {
      cleanup()
      toast(`Could not start the call: ${say(e)}`)
    } finally {
      setJoining(false)
    }
  }, [socket, toast, leave, cleanup, refreshLocal, emitMedia, callPeer])

  const toggleMic = useCallback(() => {
    const t = audioTrack.current
    if (!t) { toast("Your microphone isn't available in this call. Rejoin after allowing it."); return }
    t.enabled = !t.enabled
    setMicOn(t.enabled)
    emitMedia()
  }, [toast, emitMedia])

  const toggleCam = useCallback(async () => {
    if (camTrack.current) {
      camTrack.current.stop()
      camTrack.current = null
      setCamOn(false)
      if (!screenTrack.current) await setSlot('video', null)
    } else {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 } } })
        camTrack.current = s.getVideoTracks()[0]
        setCamOn(true)
        if (!screenTrack.current) await setSlot('video', camTrack.current)
      } catch { toast("Couldn't turn on your camera. Check the browser's permission for this site.") }
    }
    refreshLocal()
    emitMedia()
  }, [setSlot, refreshLocal, emitMedia, toast])

  const stopScreen = useCallback(async () => {
    screenTrack.current?.stop()
    screenTrack.current = null
    setScreenOn(false)
    await setSlot('video', camTrack.current)
    refreshLocal()
    emitMedia()
  }, [setSlot, refreshLocal, emitMedia])

  const toggleScreen = useCallback(async () => {
    if (screenTrack.current) { await stopScreen(); return }
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
      const t = s.getVideoTracks()[0]
      t.onended = () => { void stopScreen() } // the browser's own "Stop sharing" button
      screenTrack.current = t
      setScreenOn(true)
      await setSlot('video', t)
      refreshLocal()
      emitMedia()
    } catch { /* user cancelled the picker */ }
  }, [setSlot, refreshLocal, emitMedia, stopScreen])

  // ----- shared whiteboard -----
  const openBoard = useCallback((bg: string | null) => socket?.emit('board:open', { bg }), [socket])
  const closeBoard = useCallback(() => socket?.emit('board:close'), [socket])
  const clearBoard = useCallback(() => socket?.emit('board:clear'), [socket])
  const sendStroke = useCallback((s: BoardStroke) => {
    strokeQueue.current.push(s)
    if (strokeTimer.current) return
    strokeTimer.current = window.setTimeout(() => {
      strokeTimer.current = 0
      const batch = strokeQueue.current.splice(0)
      if (batch.length) socket?.emit('board:strokes', { strokes: batch })
    }, 40)
  }, [socket])
  const onStrokes = useCallback((fn: (s: BoardStroke[]) => void) => {
    strokeListeners.current.add(fn)
    return () => { strokeListeners.current.delete(fn) }
  }, [])

  // ----- socket events -----
  useEffect(() => {
    if (!socket) return
    const onSignal = ({ from, data }: { from: string; data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit } }) => {
      // handle each peer's messages strictly in order
      const prev = chains.current.get(from) ?? Promise.resolve()
      const next = prev.then(() => handleSignal(from, data)).catch(e => console.error('signal error', say(e)))
      chains.current.set(from, next)
    }
    const onState = ({ key, call: summary }: { key: string; call: CallSummary | null }) => {
      if (callRef.current?.key !== key) return
      setParticipants(summary?.participants.filter(p => p.socketId !== callRef.current?.mySocketId) ?? [])
    }
    const onPeerLeft = ({ socketId }: { socketId: string }) => dropPeer(socketId)
    const onRing = ({ chatId, video, from }: { chatId: string; video: boolean; from: { id: string; name: string } }) => {
      if (from.id === account.id || callRef.current?.key === `chat:${chatId}`) return
      const chat = chatsRef.current.find(c => c.id === chatId)
      const where = chat && !chat.isDirect ? ` in ${chatTitle(chat)}` : ''
      if (settings.chime) { engine.chime(); setTimeout(() => engine.chime(), 700) }
      toast(`${from.name} started a ${video ? 'video' : 'voice'} call${where}.`, { label: 'Join', run: () => { openChat(chatId); void join(`chat:${chatId}`, false) } })
    }
    const onBoardState = (b: BoardState | null) => setBoard(b)
    const onBoardStrokes = ({ strokes }: { strokes: BoardStroke[] }) => strokeListeners.current.forEach(fn => fn(strokes))
    const onRemoved = ({ chatId }: { chatId: string }) => {
      if (callRef.current?.key === `chat:${chatId}`) { cleanup(); toast('You were removed from this group, so you left its call.') }
    }
    const onDisconnect = () => {
      if (callRef.current) { cleanup(); toast('Call dropped: the connection to the server was lost.') }
    }
    socket.on('rtc:signal', onSignal)
    socket.on('call:state', onState)
    socket.on('call:peer-left', onPeerLeft)
    socket.on('call:ring', onRing)
    socket.on('board:state', onBoardState)
    socket.on('board:strokes', onBoardStrokes)
    socket.on('disconnect', onDisconnect)
    socket.on('chat:removed', onRemoved)
    return () => {
      socket.off('chat:removed', onRemoved)
      socket.off('rtc:signal', onSignal)
      socket.off('call:state', onState)
      socket.off('call:peer-left', onPeerLeft)
      socket.off('call:ring', onRing)
      socket.off('board:state', onBoardState)
      socket.off('board:strokes', onBoardStrokes)
      socket.off('disconnect', onDisconnect)
    }
  }, [socket, account.id, handleSignal, dropPeer, cleanup, toast, join, openChat, chatTitle, settings.chime])

  // Measure sound from the connection stats twice a second. This shows whether someone's voice is
  // really arriving (so "can't hear" can be told apart from "nothing is being received").
  const inCall = !!call
  useEffect(() => {
    if (!inCall) return
    const lastBytes = new Map<string, { bytes: number; at: number }>()
    let stop = false
    const tick = async () => {
      const lv: Record<string, number> = {}
      const hr: Record<string, boolean> = {}
      let mine = 0
      for (const [id, pc] of peers.current) {
        try {
          const stats = await pc.getStats()
          stats.forEach((r: Record<string, unknown>) => {
            if (r.type === 'inbound-rtp' && r.kind === 'audio') {
              const bytes = Number(r.bytesReceived ?? 0)
              const prev = lastBytes.get(id)
              hr[id] = !!prev && bytes > prev.bytes
              lastBytes.set(id, { bytes, at: Date.now() })
              if (typeof r.audioLevel === 'number') lv[id] = r.audioLevel
            }
            if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') mine = Math.max(mine, r.audioLevel)
          })
        } catch { /* connection closing */ }
      }
      if (stop) return
      lv.me = audioTrack.current?.enabled ? mine : 0
      setLevels(lv)
      setHearing(hr)
    }
    const iv = window.setInterval(() => { void tick() }, 500)
    return () => { stop = true; clearInterval(iv) }
  }, [inCall])

  // browsers may refuse to start sound without a tap; start it on the next tap or key press anywhere
  useEffect(() => {
    if (!inCall) return
    const go = () => unlockAudio()
    for (const ev of ['pointerdown', 'touchend', 'keydown']) document.addEventListener(ev, go, true)
    return () => { for (const ev of ['pointerdown', 'touchend', 'keydown']) document.removeEventListener(ev, go, true) }
  }, [inCall, unlockAudio])

  // leaving a study room (or it closing) ends that room's call for us
  useEffect(() => {
    if (call?.key.startsWith('room:') && myRoom?.id !== call.key.slice(5)) cleanup()
  }, [call, myRoom, cleanup])

  useEffect(() => () => {
    for (const pc of peers.current.values()) pc.close()
    for (const el of sinks.current.values()) { el.pause(); el.srcObject = null; el.remove() }
    ;[audioTrack, camTrack, screenTrack].forEach(r => r.current?.stop())
  }, [])

  const value: CallStore = {
    call, joining, participants, remoteStreams, localStream, micOn, camOn, screenOn, canShareScreen, expanded, setExpanded, peerStates, relayAvailable,
    levels, hearing, audioBlocked, unlockAudio, fixSound,
    join, leave, toggleMic, toggleCam, toggleScreen, board, openBoard, closeBoard, clearBoard, sendStroke, onStrokes,
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
