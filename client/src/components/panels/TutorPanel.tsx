import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from '../../lib/store'
import { usePro } from '../../lib/pro'
import { api, ApiError } from '../../lib/api'
import { boardSnapshot, prepareImage } from '../../lib/board'
import type { TutorConversation, TutorMessage, TutorStatus } from '../../lib/types'
import { Panel, Empty } from '../ui'
import Markdown from '../Markdown'
import PixelIcon from '../PixelIcon'

type Attachment =
  | { kind: 'image' | 'whiteboard'; data: string; label: string }
  | { kind: 'note'; noteId: string; label: string }

const SUGGESTIONS = [
  'Explain normalization in DBMS with a simple example',
  'How do I find the eigenvalues of a 2×2 matrix?',
  'Make me a 2-hour study plan for tonight',
  'Give me 5 practice questions on probability',
]

const timeAgo = (ms: number) => {
  const m = Math.round((Date.now() - ms) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Reads a fetch() response body as Server-Sent Events. */
async function readEvents(res: Response, onEvent: (event: string, data: unknown) => void) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  const flush = (chunk: string) => {
    let event = 'message'
    const data: string[] = []
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    if (data.length) { try { onEvent(event, JSON.parse(data.join('\n'))) } catch { /* ignore */ } }
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) >= 0) { flush(buf.slice(0, i)); buf = buf.slice(i + 2) }
  }
  if (buf.trim()) flush(buf)
}

export default function TutorPanel({ onClose }: { onClose: () => void }) {
  const { toast, notes, whiteboard } = useStore()
  const { plan, openPro, takeTutorPrefill, tutorSignal } = usePro()
  const [status, setStatus] = useState<TutorStatus | null>(null)
  const [conversations, setConversations] = useState<TutorConversation[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [messages, setMessages] = useState<TutorMessage[]>([])
  const [loadingConv, setLoadingConv] = useState(false)
  const [view, setView] = useState<'chat' | 'history'>('chat')
  const [draft, setDraft] = useState('')
  const [attachment, setAttachment] = useState<Attachment | null>(null)
  const [notePicker, setNotePicker] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<{ text: string; code?: string; retry?: { text: string; attachment: Attachment | null } } | null>(null)
  const [lightbox, setLightbox] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stick = useRef(true)
  const pendingText = useRef('')
  const frame = useRef(0)
  const canAttach = status?.attachments ?? plan.pro

  const loadStatus = useCallback(async () => {
    try { setStatus(await api<TutorStatus>('/api/ai/status')) } catch (e) { toast(e instanceof Error ? e.message : 'Could not load the tutor') }
  }, [toast])
  const loadConversations = useCallback(async () => {
    try { setConversations((await api<{ conversations: TutorConversation[] }>('/api/ai/conversations')).conversations) } catch { /* shown elsewhere */ }
  }, [])

  useEffect(() => { void loadStatus(); void loadConversations() }, [loadStatus, loadConversations])
  // plan changed (just upgraded): refresh limits
  useEffect(() => { void loadStatus() }, [plan.pro, loadStatus])
  // stop any answer in progress if the panel closes
  useEffect(() => () => controller.current?.abort(), [])

  // something else opened the tutor with a question ready (e.g. "Quiz me on this note")
  useEffect(() => {
    const p = takeTutorPrefill()
    if (!p) return
    newChat()
    setDraft(p.text)
    if (p.noteId) {
      const n = notes.find(x => x.id === p.noteId)
      if (n) setAttachment({ kind: 'note', noteId: n.id, label: n.title || 'Untitled note' })
    }
    setTimeout(() => inputRef.current?.focus(), 50)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tutorSignal])

  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages])

  function newChat() {
    controller.current?.abort()
    setActiveId(null)
    setMessages([])
    setError(null)
    setView('chat')
    stick.current = true
  }

  async function openConversation(id: string) {
    controller.current?.abort()
    setView('chat')
    setActiveId(id)
    setError(null)
    setLoadingConv(true)
    stick.current = true
    try {
      const r = await api<{ messages: TutorMessage[] }>(`/api/ai/conversations/${id}`)
      setMessages(r.messages)
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not open that conversation')
      setActiveId(null)
    } finally {
      setLoadingConv(false)
    }
  }

  async function deleteConversation(id: string) {
    try {
      await api(`/api/ai/conversations/${id}`, { method: 'DELETE' })
      setConversations(cs => cs.filter(c => c.id !== id))
      if (id === activeId) newChat()
    } catch (e) { toast(e instanceof Error ? e.message : 'Could not delete') }
  }

  // batch streamed text into one update per animation frame
  const flushDelta = () => {
    frame.current = 0
    const t = pendingText.current
    pendingText.current = ''
    if (t) setMessages(ms => ms.map(m => (m.streaming ? { ...m, content: m.content + t } : m)))
  }

  async function ask(textIn: string, att: Attachment | null) {
    const text = textIn.trim()
    if (!text || streaming) return
    setError(null)
    setDraft('')
    setAttachment(null)
    setNotePicker(false)
    stick.current = true
    const now = Date.now()
    const tempUser: TutorMessage = {
      id: `tmp-u-${now}`, role: 'user', content: text, createdAt: now,
      attachmentKind: att?.kind ?? null,
      attachment: att ? (att.kind === 'note' ? att.label : att.data) : null,
    }
    const tempAnswer: TutorMessage = { id: `tmp-a-${now}`, role: 'assistant', content: '', attachmentKind: null, attachment: null, createdAt: now, streaming: true }
    setMessages(ms => [...ms, tempUser, tempAnswer])
    setStreaming(true)
    const ctrl = new AbortController()
    controller.current = ctrl
    let metaCreated = false
    const fail = (msg: string, code?: string, keepQuestion = true) => {
      setMessages(ms => ms.filter(m => m.id !== tempUser.id && m.id !== tempAnswer.id))
      if (keepQuestion) { setDraft(text); setAttachment(att) }
      setError({ text: msg, code, retry: keepQuestion ? { text, attachment: att } : undefined })
    }
    try {
      const res = await fetch('/api/ai/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        signal: ctrl.signal,
        body: JSON.stringify({
          text,
          conversationId: activeId ?? undefined,
          attachment: att ? (att.kind === 'note' ? { kind: 'note', noteId: att.noteId } : { kind: att.kind, data: att.data }) : undefined,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({})) as { error?: string; code?: string }
        if (res.status === 401) window.dispatchEvent(new Event('lofi:unauthorized'))
        fail(j.error || `Request failed (${res.status})`, j.code)
        if (j.code === 'free_limit' || j.code === 'limit') void loadStatus()
        return
      }
      await readEvents(res, (event, data) => {
        const d = data as Record<string, unknown>
        if (event === 'meta') {
          metaCreated = !!d.created
          const user = d.userMessage as TutorMessage
          const convId = d.conversationId as string
          setActiveId(convId)
          setMessages(ms => ms.map(m => (m.id === tempUser.id ? user : m)))
          setStatus(s => (s ? { ...s, usage: d.usage as TutorStatus['usage'] } : s))
          if (d.created) void loadConversations()
        } else if (event === 'delta') {
          pendingText.current += (d.t as string) ?? ''
          if (!frame.current) frame.current = requestAnimationFrame(flushDelta)
        } else if (event === 'done') {
          cancelAnimationFrame(frame.current); frame.current = 0; pendingText.current = ''
          const saved = d.message as TutorMessage
          setMessages(ms => ms.map(m => (m.streaming ? saved : m)))
          setStatus(s => (s ? { ...s, usage: d.usage as TutorStatus['usage'] } : s))
        } else if (event === 'error') {
          cancelAnimationFrame(frame.current); frame.current = 0; pendingText.current = ''
          setStatus(s => (s && d.usage ? { ...s, usage: d.usage as TutorStatus['usage'] } : s))
          const removed = d.removed as { conversationId?: string | null } | undefined
          if (removed?.conversationId) { setActiveId(null); void loadConversations() }
          fail(d.error as string)
        }
      })
    } catch (e) {
      if (ctrl.signal.aborted) {
        // Stop pressed: the server keeps whatever was written so far
        cancelAnimationFrame(frame.current); frame.current = 0
        const rest = pendingText.current; pendingText.current = ''
        let kept = false
        setMessages(ms => {
          const answer = ms.find(m => m.id === tempAnswer.id)
          const content = (answer?.content ?? '') + rest
          if (!content.trim()) return ms.filter(m => m.id !== tempUser.id && m.id !== tempAnswer.id)
          kept = true
          return ms.map(m => (m.id === tempAnswer.id ? { ...m, content: `${content}\n\n*(answer stopped early)*`, streaming: false } : m))
        })
        // nothing was written: the server removed the question (and a brand-new conversation) and refunded it
        setTimeout(() => { if (!kept) { setDraft(text); setAttachment(att); if (metaCreated) setActiveId(null); void loadStatus() } }, 0)
      } else {
        fail(e instanceof ApiError ? e.message : "Couldn't reach the server. Check your connection.")
      }
    } finally {
      setStreaming(false)
      controller.current = null
      setMessages(ms => ms.filter(m => !(m.streaming && !m.content)).map(m => (m.streaming ? { ...m, streaming: false } : m)))
      void loadConversations()
    }
  }

  const needPro = (reason: string) => { openPro(reason) }

  const pickImage = async (f: File | undefined) => {
    if (!f) return
    try { setAttachment({ kind: 'image', data: await prepareImage(f), label: f.name || 'Photo' }) }
    catch (e) { toast(e instanceof Error ? e.message : 'Could not use that image') }
  }
  const attachBoard = async () => {
    if (!canAttach) return needPro('Ask the tutor about your whiteboard with Pro.')
    if (!whiteboard) { toast('Your whiteboard is empty. Draw something in the Whiteboard panel first.'); return }
    try { setAttachment({ kind: 'whiteboard', data: await boardSnapshot(whiteboard), label: 'My whiteboard' }) } catch { toast('Could not attach the whiteboard') }
  }

  const left = status ? Math.max(0, status.usage.limit - status.usage.used) : null
  const outOfQuestions = left === 0

  // ---------------- render ----------------
  const header = (
    <div className="-mt-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[17px]">
      {status && (
        <span className={outOfQuestions ? 'text-rose' : 'text-muted'}>
          <span className={plan.pro ? 'text-amber' : ''}>{plan.pro ? 'Pro' : 'Free'}</span> · {left} of {status.usage.limit} questions left today
        </span>
      )}
      {!plan.pro && status?.configured && (
        <button className="px-btn !p-0 text-amber underline" onClick={() => openPro(`Get ${status.proLimit} questions a day and ask about photos, your whiteboard and notes.`)}>Upgrade</button>
      )}
      {status?.provider && <span className="ml-auto text-[14px] text-muted/80">Powered by {status.provider}</span>}
    </div>
  )

  const historyView = (
    <div className="px-scroll min-h-0 flex-1 overflow-y-auto">
      {conversations.length === 0 ? <Empty>No conversations yet. Ask your first doubt!</Empty> : (
        <ul className="flex flex-col gap-1">
          {conversations.map(c => (
            <li key={c.id} className={`px-card flex items-center gap-2 p-2 ${c.id === activeId ? 'outline-2 outline-amber' : ''}`}>
              <button className="min-w-0 flex-1 text-left hover:text-amber" onClick={() => void openConversation(c.id)}>
                <span className="block truncate">{c.title}</span>
                <span className="block text-[15px] text-muted">{timeAgo(c.updatedAt)} · {Math.ceil(c.messages / 2)} {Math.ceil(c.messages / 2) === 1 ? 'question' : 'questions'}</span>
              </button>
              <button className="px-btn shrink-0 text-muted hover:!text-rose" onClick={() => void deleteConversation(c.id)} aria-label={`Delete "${c.title}"`} title="Delete">
                <PixelIcon name="trash" size={16} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  const emptyChat = (
    <div className="flex flex-col items-center gap-3 py-4 text-center">
      <PixelIcon name="tutor" size={44} className="text-amber" />
      <p className="font-title text-[18px]">Stuck on something?</p>
      <p className="max-w-md text-muted">Ask any study doubt. Lofi Tutor explains step by step and checks you&rsquo;ve understood, instead of just handing over answers.</p>
      <div className="mt-1 flex w-full max-w-lg flex-col gap-1">
        {SUGGESTIONS.map(s => (
          <button key={s} className="px-card px-3 py-2 text-left hover:bg-card-hi" onClick={() => void ask(s, null)} disabled={streaming || outOfQuestions}>{s}</button>
        ))}
      </div>
      <p className="text-[15px] text-muted">AI can make mistakes. Double-check important facts with your textbook or teacher.</p>
    </div>
  )

  const messageList = (
    <div ref={listRef} className="px-scroll min-h-0 flex-1 overflow-y-auto pr-1" aria-live="polite"
      onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60 }}>
      {loadingConv && <p className="py-6 text-center text-muted">Loading…</p>}
      {!loadingConv && messages.length === 0 && emptyChat}
      {messages.map(m => m.role === 'user' ? (
        <div key={m.id} className="mt-3 flex flex-col items-end">
          {m.attachmentKind && m.attachment && (m.attachmentKind === 'note' ? (
            <span className="mb-1 flex items-center gap-1 bg-card px-2 py-0.5 text-[16px] text-muted"><PixelIcon name="notes" size={14} />{m.attachment}</span>
          ) : (
            <button className="mb-1" onClick={() => setLightbox(m.attachment)} aria-label="Open attached image">
              <img src={m.attachment} alt={m.attachmentKind === 'whiteboard' ? 'Attached whiteboard' : 'Attached photo'} className="max-h-40 max-w-[220px] object-contain" />
            </button>
          ))}
          <div className="max-w-[85%] whitespace-pre-wrap break-words bg-amber px-3 py-1.5 text-[#2a1c10]">{m.content}</div>
        </div>
      ) : (
        <div key={m.id} className="mt-3 flex gap-2">
          <PixelIcon name="tutor" size={22} className="mt-1 shrink-0 text-amber" />
          <div className="min-w-0 flex-1">
            <div className={`px-card px-3 py-2 ${m.streaming ? 'tutor-cursor' : ''}`}>
              {m.content ? <Markdown text={m.content} /> : <span className="text-muted">Thinking<span className="blink">…</span></span>}
            </div>
            {!m.streaming && m.content && (
              <button className="px-btn mt-0.5 flex items-center gap-1 !py-0 text-[15px] text-muted" onClick={() => { void navigator.clipboard?.writeText(m.content).then(() => toast('Answer copied.'), () => {}) }}>
                <PixelIcon name="copy" size={12} />Copy
              </button>
            )}
          </div>
        </div>
      ))}
      {error && (
        <div className="mt-3 border-2 border-rose p-2" role="alert">
          <p>{error.text}</p>
          <div className="mt-1 flex flex-wrap gap-2">
            {(error.code === 'free_limit' || error.code === 'pro_required') && (
              <button className="px-solid px-primary !py-1" onClick={() => openPro(error.text)}>See Pro</button>
            )}
            {error.retry && error.code !== 'free_limit' && error.code !== 'limit' && error.code !== 'pro_required' && (
              <button className="px-solid !py-1" onClick={() => { const r = error.retry!; void ask(r.text, r.attachment) }} disabled={streaming}>Try again</button>
            )}
            <button className="px-btn" onClick={() => setError(null)}>Dismiss</button>
          </div>
        </div>
      )}
    </div>
  )

  const composer = (
    <div className="mt-2 border-t-2 border-line pt-2">
      {attachment && (
        <div className="mb-2 flex items-center gap-2">
          {attachment.kind === 'note'
            ? <PixelIcon name="notes" size={18} className="text-amber" />
            : <img src={attachment.data} alt="" className="h-10 w-14 object-cover" />}
          <span className="min-w-0 flex-1 truncate text-[17px]">{attachment.kind === 'note' ? 'Note: ' : ''}{attachment.label}</span>
          <button className="px-btn text-muted" onClick={() => setAttachment(null)} aria-label="Remove attachment"><PixelIcon name="close" size={14} /></button>
        </div>
      )}
      {notePicker && (
        <div className="px-card px-scroll mb-2 max-h-40 overflow-y-auto p-1">
          {notes.length === 0 ? <p className="p-2 text-muted">You have no notes yet.</p> : notes.slice(0, 50).map(n => (
            <button key={n.id} className="block w-full truncate px-2 py-1 text-left hover:bg-card-hi" onClick={() => { setAttachment({ kind: 'note', noteId: n.id, label: n.title || 'Untitled note' }); setNotePicker(false) }}>
              {n.title || 'Untitled note'} <span className="text-muted">· {n.subject}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-1">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => { void pickImage(e.target.files?.[0]); e.target.value = '' }} />
        <AttachButton icon="image" label="Attach a photo of a question" locked={!canAttach} onClick={() => (canAttach ? fileRef.current?.click() : needPro('Snap a photo of any question and ask about it with Pro.'))} />
        <AttachButton icon="board" label="Attach my whiteboard" locked={!canAttach} onClick={() => void attachBoard()} />
        <AttachButton icon="notes" label="Ask about one of my notes" locked={!canAttach} onClick={() => (canAttach ? setNotePicker(v => !v) : needPro('Ask the tutor to explain or quiz you on your own notes with Pro.'))} />
        <textarea
          ref={inputRef}
          className="px-input ml-1 max-h-32 min-h-[40px] flex-1 resize-none"
          rows={Math.min(4, Math.max(1, draft.split('\n').length))}
          placeholder={outOfQuestions ? 'No questions left today' : 'Ask a doubt… (Enter to send, Shift+Enter for a new line)'}
          value={draft}
          maxLength={4000}
          disabled={outOfQuestions && !streaming}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void ask(draft, attachment) } }}
          aria-label="Your question"
        />
        {streaming ? (
          <button className="px-solid shrink-0 !p-2" onClick={() => controller.current?.abort()} aria-label="Stop the answer" title="Stop"><PixelIcon name="stop" size={20} /></button>
        ) : (
          <button className="px-solid px-primary shrink-0 !p-2" onClick={() => void ask(draft, attachment)} disabled={!draft.trim() || outOfQuestions} aria-label="Ask"><PixelIcon name="send" size={20} /></button>
        )}
      </div>
    </div>
  )

  return (
    <Panel
      title="Study tutor"
      onClose={onClose}
      wide
      fill
      actions={<>
        <button className="px-btn" onClick={() => setView(v => (v === 'history' ? 'chat' : 'history'))} aria-pressed={view === 'history'}>{view === 'history' ? '[‹] Back' : 'History'}</button>
        <button className="px-btn" onClick={newChat}>[+] New</button>
      </>}
    >
      {status && !status.configured ? (
        <Empty>The AI tutor isn&rsquo;t switched on for this site yet. The site owner needs to add an AI API key (see DEPLOY.md, &ldquo;AI study tutor&rdquo;).</Empty>
      ) : (
        <>
          {header}
          {view === 'history' ? historyView : messageList}
          {view === 'chat' && composer}
        </>
      )}
      {lightbox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={() => setLightbox(null)} role="dialog" aria-label="Image">
          <img src={lightbox} alt="" className="max-h-full max-w-full object-contain" />
        </div>
      )}
    </Panel>
  )
}

function AttachButton({ icon, label, locked, onClick }: { icon: 'image' | 'board' | 'notes'; label: string; locked: boolean; onClick: () => void }) {
  return (
    <button className="px-btn relative shrink-0 !p-1" onClick={onClick} aria-label={locked ? `${label} (Pro)` : label} title={locked ? `${label} · Pro` : label}>
      <PixelIcon name={icon} size={22} className={locked ? 'opacity-50' : ''} />
      {locked && <PixelIcon name="lock" size={10} className="absolute right-0 bottom-0 text-amber" />}
    </button>
  )
}
