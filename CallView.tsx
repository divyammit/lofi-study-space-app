import { useEffect, useRef, useState } from 'react'
import { useCall } from '../lib/call'
import { useChat } from '../lib/chat'
import { useStore } from '../lib/store'
import { fmtClock } from '../lib/dates'
import PixelAvatar from './PixelAvatar'
import PixelIcon, { type IconName } from './PixelIcon'
import SharedBoard from './SharedBoard'

const STATE_LABEL: Partial<Record<RTCPeerConnectionState, string>> = {
  new: 'Connecting…',
  connecting: 'Connecting…',
  disconnected: 'Reconnecting…',
  failed: "Can't connect",
}

function Tile({ stream, muted, mirrored, name, avatar, showVideo, micOff, screen, compact, state }: {
  stream: MediaStream | null; muted?: boolean; mirrored?: boolean; name: string; avatar: number
  showVideo: boolean; micOff: boolean; screen?: boolean; compact?: boolean; state?: RTCPeerConnectionState
}) {
  const ref = useRef<HTMLVideoElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [blocked, setBlocked] = useState(false)
  useEffect(() => {
    // Picture and sound go to separate players. A <video> with a camera track that sends no frames
    // (camera off) never starts playing, which would also silence the audio in it.
    const v = ref.current
    if (v) {
      const vt = stream?.getVideoTracks() ?? []
      const vs = vt.length ? new MediaStream(vt) : null
      v.srcObject = vs
      if (vs) v.play().catch(() => {})
    }
    const a = audioRef.current
    if (a && !muted) {
      const at = stream?.getAudioTracks() ?? []
      const as = at.length ? new MediaStream(at) : null
      a.srcObject = as
      // browsers may refuse to start sound without a click; then we show a "tap to hear" button
      if (as) a.play().then(() => setBlocked(false), () => setBlocked(true))
    }
  }, [stream, muted])
  const unblock = () => { audioRef.current?.play().then(() => setBlocked(false), () => {}) }
  const label = state ? STATE_LABEL[state] : undefined
  return (
    <div className={`relative overflow-hidden bg-[#141626] ${compact ? 'aspect-video' : 'aspect-video min-h-0'}`}>
      {!muted && <audio ref={audioRef} autoPlay />}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={`h-full w-full ${screen ? 'object-contain' : 'object-cover'} ${showVideo ? '' : 'opacity-0'}`}
        style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
      />
      {!showVideo && (
        <div className="absolute inset-0 flex items-center justify-center">
          <PixelAvatar seed={avatar} size={compact ? 44 : 84} />
        </div>
      )}
      {label && (
        <div className={`absolute inset-x-0 top-0 px-2 py-0.5 text-center text-[15px] ${state === 'failed' ? 'bg-rose text-white' : 'bg-black/60 text-[#ece3d0]'}`}>{label}</div>
      )}
      {blocked && (
        <button className="absolute inset-0 flex items-center justify-center bg-black/60 text-[18px] text-[#ece3d0]" onClick={unblock}>
          Tap to hear {name}
        </button>
      )}
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-black/50 px-2 text-[17px] text-[#ece3d0]">
        <span className="truncate">{name}{screen ? ' · sharing screen' : ''}</span>
        {micOff && <PixelIcon name="micOff" size={14} className="shrink-0 text-[#e8707e]" title="Muted" />}
      </div>
    </div>
  )
}

function CtrlButton({ icon, label, onClick, active = false, danger = false }: { icon: IconName; label: string; onClick: () => void; active?: boolean; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={`flex h-11 min-w-11 items-center justify-center gap-2 px-3 ${danger ? 'bg-rose text-white hover:brightness-110' : active ? 'bg-card-hi text-ink' : 'bg-[#e8707e]/85 text-white'} `}
    >
      <PixelIcon name={icon} size={20} />
      <span className="hidden text-[18px] sm:inline">{label}</span>
    </button>
  )
}

export default function CallView() {
  const c = useCall()
  const { chats, chatTitle } = useChat()
  const { profile, now, whiteboard, rooms } = useStore()
  if (!c.call) return null

  const key = c.call.key
  const chat = key.startsWith('chat:') ? chats.find(x => x.id === key.slice(5)) : null
  const room = key.startsWith('room:') ? rooms.find(r => r.id === key.slice(5)) : null
  const title = chat ? chatTitle(chat) : room ? `Study room · ${room.subject}` : 'Call'
  const anyFailed = Object.values(c.peerStates).includes('failed')
  const elapsed = fmtClock(Math.max(0, now - c.call.joinedAt))
  const people = c.participants.length + 1

  const tiles = (compact: boolean) => (
    <>
      <Tile
        stream={c.localStream}
        muted
        mirrored={c.camOn && !c.screenOn}
        name={`${profile.name || 'You'} (you)`}
        avatar={profile.avatar}
        showVideo={!!c.localStream}
        micOff={!c.micOn}
        screen={c.screenOn}
        compact={compact}
      />
      {c.participants.map(p => (
        <Tile
          key={p.socketId}
          stream={c.remoteStreams[p.socketId] ?? null}
          name={p.name}
          avatar={p.avatar}
          showVideo={(p.video || p.screen) && !!c.remoteStreams[p.socketId]}
          micOff={!p.audio}
          screen={p.screen}
          compact={compact}
          state={c.peerStates[p.socketId] ?? 'new'}
        />
      ))}
    </>
  )

  const controls = (
    <div className="flex flex-wrap items-center justify-center gap-2">
      <CtrlButton icon={c.micOn ? 'mic' : 'micOff'} label={c.micOn ? 'Mute' : 'Unmute'} onClick={c.toggleMic} active={c.micOn} />
      <CtrlButton icon={c.camOn ? 'video' : 'videoOff'} label={c.camOn ? 'Camera off' : 'Camera on'} onClick={() => void c.toggleCam()} active={c.camOn} />
      {c.canShareScreen && <CtrlButton icon="screen" label={c.screenOn ? 'Stop sharing' : 'Share screen'} onClick={() => void c.toggleScreen()} active={!c.screenOn} />}
      <CtrlButton icon="board" label={c.board ? 'Close board' : 'Whiteboard'} onClick={() => (c.board ? c.closeBoard() : c.openBoard(whiteboard))} active={!c.board} />
      <CtrlButton icon="hangup" label="Leave" onClick={c.leave} danger />
    </div>
  )

  if (!c.expanded) {
    return (
      <>
        {/* keep everyone's audio playing while minimised */}
        <div className="pointer-events-none fixed top-0 left-0 h-px w-px overflow-hidden opacity-0" aria-hidden="true">{tiles(true)}</div>
        <div className="px-panel panel-in fixed right-3 bottom-14 z-40 flex items-center gap-2 p-2" role="region" aria-label="Ongoing call">
          <button className="flex min-w-0 items-center gap-2 px-1 text-left hover:text-amber" onClick={() => c.setExpanded(true)} aria-label="Open call">
            <span className="blink text-moss">●</span>
            <span className="max-w-[140px] truncate">{title}</span>
            <span className="text-muted">{elapsed} · {people}</span>
          </button>
          <button className={`px-2 py-1 ${c.micOn ? 'bg-card-hi' : 'bg-[#e8707e] text-white'}`} onClick={c.toggleMic} aria-label={c.micOn ? 'Mute' : 'Unmute'}><PixelIcon name={c.micOn ? 'mic' : 'micOff'} size={16} /></button>
          <button className="bg-rose px-2 py-1 text-white" onClick={c.leave} aria-label="Leave call"><PixelIcon name="hangup" size={16} /></button>
        </div>
      </>
    )
  }

  const cols = people <= 1 ? 'grid-cols-1' : people <= 4 ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-2 lg:grid-cols-3'
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/55 p-0 md:p-6" role="dialog" aria-label={`Call in ${title}`}>
      <section className="px-panel panel-in flex h-full w-full max-w-6xl flex-col gap-3 p-3 md:h-[min(90vh,820px)] md:p-4">
        <header className="flex items-center gap-3">
          <span className="blink text-moss">●</span>
          <h2 className="min-w-0 flex-1 truncate font-title text-[18px] md:text-[22px]">{title}</h2>
          <span className="text-muted">{elapsed} · {people} in call</span>
          <button className="px-btn" onClick={() => c.setExpanded(false)} aria-label="Minimise call" title="Minimise (keep talking while using the room)">
            <PixelIcon name="minimize" size={18} />
          </button>
        </header>

        {c.board ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
            <div className="flex min-h-0 flex-1 flex-col"><SharedBoard /></div>
            <div className="px-scroll flex shrink-0 gap-2 overflow-auto md:w-52 md:flex-col">
              <div className="grid w-full grid-cols-3 gap-2 md:grid-cols-1">{tiles(true)}</div>
            </div>
          </div>
        ) : (
          <div className={`px-scroll grid min-h-0 flex-1 content-center gap-2 overflow-auto ${cols}`}>{tiles(false)}</div>
        )}

        {c.participants.length === 0 && !c.board && (
          <p className="text-center text-muted">{room ? 'Waiting for others in the room to join the call.' : 'Waiting for others to join. Everyone in the chat got a notification.'}</p>
        )}
        {anyFailed && (
          <p className="border-2 border-rose px-3 py-1 text-center text-[17px]">
            {c.relayAvailable
              ? "Someone's connection couldn't be reached. Ask them to check their internet or switch networks."
              : "A network is blocking direct calls, so audio/video can't get through. The site owner needs to add a TURN relay (see DEPLOY.md, \"Making calls reliable\")."}
          </p>
        )}
        {controls}
      </section>
    </div>
  )
}
