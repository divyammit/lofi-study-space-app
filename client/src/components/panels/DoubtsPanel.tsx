import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../lib/api'
import { useStore } from '../../lib/store'
import { usePro } from '../../lib/pro'
import { prepareImage } from '../../lib/board'
import type { DoubtAnswer, DoubtAuthor, DoubtDetail, DoubtSummary, Vote } from '../../lib/types'
import { Panel, Empty, Seg } from '../ui'
import Markdown from '../Markdown'
import PixelAvatar from '../PixelAvatar'
import PixelIcon from '../PixelIcon'

/**
 * Doubt board: everyone on the site can post a study doubt, answer others, vote, and the asker
 * marks the answer that solved it. The AI tutor can add an answer too.
 */

type View = { kind: 'list' } | { kind: 'ask' } | { kind: 'doubt'; id: string }
type Filter = 'all' | 'open' | 'unanswered' | 'solved' | 'mine'
type Sort = 'new' | 'active' | 'top'

const say = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong')

export function ago(t: number) {
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Plain-text preview of Markdown: maths becomes [maths], formatting marks are dropped. */
const plain = (md: string) => md
  .replace(/\$\$[\s\S]*?\$\$/g, ' [maths] ').replace(/\$[^$\n]+\$/g, '[maths]')
  .replace(/```[\s\S]*?(```|$)/g, ' [code] ').replace(/[*_`#>~]+/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  .replace(/\s+/g, ' ').trim()

function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value)
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t) }, [value, ms])
  return v
}

function Votes({ score, myVote, mine, onVote, size = 'md' }: { score: number; myVote: Vote; mine: boolean; onVote: (v: Vote) => void; size?: 'sm' | 'md' }) {
  const btn = (v: 1 | -1) => (
    <button
      className={`leading-none ${myVote === v ? 'text-amber' : 'text-muted hover:text-ink'} disabled:opacity-40`}
      onClick={e => { e.stopPropagation(); onVote(myVote === v ? 0 : v) }}
      disabled={mine}
      aria-label={v === 1 ? 'Upvote' : 'Downvote'}
      aria-pressed={myVote === v}
      title={mine ? "You can't vote on your own post" : v === 1 ? 'Helpful / good question' : 'Not helpful'}
    >
      {v === 1 ? '▲' : '▼'}
    </button>
  )
  return (
    <div className={`flex shrink-0 flex-col items-center ${size === 'sm' ? 'w-9 text-[16px]' : 'w-10 text-[20px]'}`}>
      {btn(1)}
      <span className={`${score > 0 ? 'text-moss' : score < 0 ? 'text-rose' : ''}`} aria-label={`Score ${score}`}>{score}</span>
      {btn(-1)}
    </div>
  )
}

function Byline({ author, at, ai }: { author: DoubtAuthor; at: number; ai?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-[17px] text-muted">
      {ai ? <span className="flex h-6 w-6 items-center justify-center bg-amber text-[#2a1c10]"><PixelIcon name="tutor" size={16} /></span> : <PixelAvatar seed={author.avatar} size={24} />}
      <span className="truncate">
        {ai ? <><span className="text-ink">Lofi Tutor (AI)</span> · asked by {author.name}</> : <><span className="text-ink">{author.name}</span> @{author.username}</>}
        {' · '}{ago(at)}
      </span>
    </div>
  )
}

/** Photo attach button + preview, shared by the ask and answer forms. */
function ImagePick({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  const { toast } = useStore()
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center gap-2">
      <input ref={input} type="file" accept="image/*" hidden onChange={async e => {
        const f = e.target.files?.[0]
        e.target.value = ''
        if (!f) return
        try { onChange(await prepareImage(f)) } catch (err) { toast(say(err)) }
      }} />
      {value ? (
        <>
          <img src={value} alt="Attached" className="h-14 w-20 border-2 border-line object-cover" />
          <button type="button" className="px-btn text-muted" onClick={() => onChange(null)}>Remove photo</button>
        </>
      ) : (
        <button type="button" className="px-btn flex items-center gap-1 text-muted" onClick={() => input.current?.click()}>
          <PixelIcon name="image" size={16} /> Add a photo
        </button>
      )}
    </div>
  )
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <button className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4" onClick={onClose} aria-label="Close photo">
      <img src={src} alt="Full size" className="max-h-full max-w-full" />
    </button>
  )
}

// ---------------- list ----------------
function DoubtList({ open, ask }: { open: (id: string) => void; ask: () => void }) {
  const { socket, toast } = useStore()
  const [text, setText] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [subject, setSubject] = useState('')
  const [sort, setSort] = useState<Sort>('new')
  const [items, setItems] = useState<DoubtSummary[] | null>(null)
  const [subjects, setSubjects] = useState<{ subject: string; count: number; open: number }[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [page, setPage] = useState(0)
  const [fresh, setFresh] = useState(0)
  const query = useDebounced(text.trim())

  const params = useCallback((p: number) => {
    const u = new URLSearchParams({ filter, page: String(p) })
    if (query) u.set('q', query)
    if (subject) u.set('subject', subject)
    u.set('sort', query && sort === 'new' ? 'relevance' : sort)
    return u.toString()
  }, [filter, query, subject, sort])

  useEffect(() => {
    let live = true
    api<{ doubts: DoubtSummary[]; hasMore: boolean }>(`/api/doubts?${params(0)}`)
      .then(r => { if (live) { setItems(r.doubts); setHasMore(r.hasMore); setPage(0) } }, e => toast(say(e)))
    return () => { live = false }
  }, [params, fresh, toast])
  useEffect(() => { api<{ subjects: typeof subjects }>('/api/doubts/subjects').then(r => setSubjects(r.subjects), () => {}) }, [fresh])

  // live: refresh when anyone posts, answers or deletes
  useEffect(() => {
    if (!socket) return
    let t = 0
    const bump = () => { clearTimeout(t); t = window.setTimeout(() => setFresh(n => n + 1), 400) }
    for (const ev of ['doubt:new', 'doubt:updated', 'doubt:deleted']) socket.on(ev, bump)
    return () => { clearTimeout(t); for (const ev of ['doubt:new', 'doubt:updated', 'doubt:deleted']) socket.off(ev, bump) }
  }, [socket])

  const more = async () => {
    const r = await api<{ doubts: DoubtSummary[]; hasMore: boolean }>(`/api/doubts?${params(page + 1)}`)
    setItems(x => [...(x ?? []), ...r.doubts.filter(d => !x?.some(y => y.id === d.id))])
    setHasMore(r.hasMore)
    setPage(page + 1)
  }
  const vote = async (d: DoubtSummary, v: Vote) => {
    try {
      const r = await api<{ score: number; myVote: Vote }>(`/api/doubts/${d.id}/vote`, { body: { value: v } })
      setItems(x => x?.map(y => (y.id === d.id ? { ...y, score: r.score, myVote: r.myVote } : y)) ?? null)
    } catch (e) { toast(say(e)) }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <input className="px-input min-w-0 flex-1" type="search" placeholder="Search doubts… e.g. normalization, integration by parts" value={text} onChange={e => setText(e.target.value)} aria-label="Search doubts" />
        <button className="px-solid px-primary shrink-0" onClick={ask}>Ask a doubt</button>
      </div>
      <Seg<Filter> label="Show" value={filter} onChange={setFilter} options={[
        { value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'unanswered', label: 'Unanswered' },
        { value: 'solved', label: 'Solved' }, { value: 'mine', label: 'Mine' },
      ]} />
      <div className="flex flex-wrap items-center gap-2 text-[18px]">
        <label className="flex items-center gap-1 text-muted">Subject
          <select className="px-input !w-auto !py-0.5" value={subject} onChange={e => setSubject(e.target.value)} aria-label="Subject">
            <option value="">All subjects</option>
            {subjects.map(s => <option key={s.subject} value={s.subject}>{s.subject} ({s.count})</option>)}
          </select>
        </label>
        <label className="flex items-center gap-1 text-muted">Sort
          <select className="px-input !w-auto !py-0.5" value={sort} onChange={e => setSort(e.target.value as Sort)} aria-label="Sort">
            <option value="new">{query ? 'Best match' : 'Newest'}</option>
            <option value="active">Recently answered</option>
            <option value="top">Top voted</option>
          </select>
        </label>
      </div>

      {items === null ? (
        <p className="text-muted">Loading doubts<span className="blink">…</span></p>
      ) : items.length === 0 ? (
        <Empty>{query || subject || filter !== 'all' ? 'No doubts match. Try other words, or ask it yourself!' : 'No doubts yet. Be the first to ask one: someone on the street might know.'}</Empty>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Doubts">
          {items.map(d => (
            <li key={d.id}>
              <div role="button" tabIndex={0} className="px-card flex cursor-pointer gap-3 p-3 hover:brightness-110" onClick={() => open(d.id)} onKeyDown={e => { if (e.key === 'Enter') open(d.id) }}>
                <Votes score={d.score} myVote={d.myVote} mine={d.mine} onVote={v => void vote(d, v)} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start gap-2">
                    <h3 className="min-w-0 flex-1 text-[20px] leading-tight">{d.title}</h3>
                    <span className={`shrink-0 px-1.5 text-[15px] ${d.solved ? 'bg-moss text-[#10200f]' : d.answers ? 'border-2 border-line' : 'border-2 border-amber text-amber'}`}>
                      {d.solved ? '✓ solved' : d.answers ? `${d.answers} answer${d.answers > 1 ? 's' : ''}` : 'unanswered'}
                    </span>
                  </div>
                  {d.excerpt && <p className="mt-0.5 line-clamp-2 text-[17px] text-muted">{plain(d.excerpt)}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="bg-card-hi px-1.5 text-[15px]">{d.subject}</span>
                    {d.hasImage && <span className="text-[15px] text-muted">📷 photo</span>}
                    {d.hasAi && <span className="text-[15px] text-muted">AI answered</span>}
                    {d.solved && d.answers > 1 && <span className="text-[15px] text-muted">{d.answers} answers</span>}
                    <Byline author={d.author} at={d.createdAt} />
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {hasMore && <button className="px-btn self-center" onClick={() => void more()}>Load more</button>}
      <p className="text-[16px] text-muted">The doubt board is public: everyone with an account can see and answer what you post.</p>
    </div>
  )
}

// ---------------- ask ----------------
function AskForm({ done, cancel }: { done: (id: string) => void; cancel: () => void }) {
  const { toast, profile, timer } = useStore()
  const [title, setTitle] = useState('')
  const [subject, setSubject] = useState(timer.subject || profile.favSubject || 'General')
  const [body, setBody] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const [similar, setSimilar] = useState<DoubtSummary[]>([])
  const [subjects, setSubjects] = useState<string[]>([])
  const q = useDebounced(title.trim(), 450)
  useEffect(() => { api<{ subjects: { subject: string }[] }>('/api/doubts/subjects').then(r => setSubjects(r.subjects.map(s => s.subject)), () => {}) }, [])
  // show doubts that already look like this one, so people find existing answers first
  useEffect(() => {
    if (q.length < 6) { setSimilar([]); return }
    let live = true
    api<{ doubts: DoubtSummary[] }>(`/api/doubts?${new URLSearchParams({ q, sort: 'relevance' })}`).then(r => { if (live) setSimilar(r.doubts.slice(0, 3)) }, () => {})
    return () => { live = false }
  }, [q])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      const r = await api<{ id: string }>('/api/doubts', { body: { title, subject, body, image } })
      toast('Doubt posted. You\'ll get a notification when someone answers.')
      done(r.id)
    } catch (err) { toast(say(err)); setBusy(false) }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <label className="flex flex-col gap-1">
        <span className="flex justify-between text-muted"><span>Your doubt in one line</span><span className="text-[15px]">{title.length}/150</span></span>
        <input className="px-input" value={title} onChange={e => setTitle(e.target.value)} minLength={5} maxLength={150} required autoFocus placeholder="e.g. Why does 3NF not always preserve dependencies?" />
      </label>
      {similar.length > 0 && (
        <div className="border-2 border-dashed border-line p-2">
          <p className="text-[16px] text-muted">Similar doubts already asked:</p>
          <ul className="mt-1 flex flex-col gap-1">
            {similar.map(s => (
              <li key={s.id} className="flex items-center gap-2 text-[17px]">
                <span className={s.solved ? 'text-moss' : 'text-muted'}>{s.solved ? '✓' : '•'}</span>
                <button type="button" className="min-w-0 flex-1 truncate text-left underline hover:text-amber" onClick={() => done(s.id)}>{s.title}</button>
                <span className="shrink-0 text-[15px] text-muted">{s.answers} ans.</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <label className="flex flex-col gap-1">
        <span className="text-muted">Subject</span>
        <input className="px-input" value={subject} onChange={e => setSubject(e.target.value)} maxLength={60} list="doubt-subjects" placeholder="General" />
        <datalist id="doubt-subjects">{subjects.map(s => <option key={s} value={s} />)}</datalist>
      </label>
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-muted">Details (what you tried, where you&rsquo;re stuck)</span>
          <button type="button" className="px-btn text-[16px] text-muted" onClick={() => setPreview(p => !p)}>{preview ? 'Edit' : 'Preview'}</button>
        </div>
        {preview
          ? <div className="px-card min-h-[120px] p-3">{body.trim() ? <Markdown text={body} /> : <span className="text-muted">Nothing to preview yet.</span>}</div>
          : <textarea className="px-input min-h-[120px] resize-y" value={body} onChange={e => setBody(e.target.value)} maxLength={8000} aria-label="Details" placeholder={'Markdown and maths work: **bold**, lists, $x^2$, $$\\int_0^1 x\\,dx$$'} />}
      </div>
      <ImagePick value={image} onChange={setImage} />
      <div className="flex gap-2">
        <button className="px-solid px-primary" type="submit" disabled={busy || title.trim().length < 5}>{busy ? 'Posting…' : 'Post doubt'}</button>
        <button className="px-btn" type="button" onClick={cancel}>Cancel</button>
      </div>
    </form>
  )
}

// ---------------- one doubt ----------------
function DoubtView({ id, back }: { id: string; back: () => void }) {
  const { socket, toast } = useStore()
  const { openPro } = usePro()
  const [data, setData] = useState<DoubtDetail | null>(null)
  const [gone, setGone] = useState('')
  const [answer, setAnswer] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [aiBusy, setAiBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)

  const load = useCallback(() => {
    api<DoubtDetail>(`/api/doubts/${id}`).then(setData, e => setGone(say(e)))
  }, [id])
  useEffect(load, [load])
  useEffect(() => {
    if (!socket) return
    const onUpd = (p: { id: string }) => { if (p.id === id) load() }
    const onDel = (p: { id: string }) => { if (p.id === id) setGone('This doubt was deleted.') }
    socket.on('doubt:updated', onUpd)
    socket.on('doubt:deleted', onDel)
    return () => { socket.off('doubt:updated', onUpd); socket.off('doubt:deleted', onDel) }
  }, [socket, id, load])

  if (gone) return <div className="flex flex-col gap-3"><Empty>{gone}</Empty><button className="px-btn self-start" onClick={back}>← All doubts</button></div>
  if (!data) return <p className="text-muted">Loading<span className="blink">…</span></p>
  const { doubt: d, answers } = data

  const voteDoubt = async (v: Vote) => {
    try {
      const r = await api<{ score: number; myVote: Vote }>(`/api/doubts/${d.id}/vote`, { body: { value: v } })
      setData(x => x && { ...x, doubt: { ...x.doubt, score: r.score, myVote: r.myVote } })
    } catch (e) { toast(say(e)) }
  }
  const voteAnswer = async (a: DoubtAnswer, v: Vote) => {
    try {
      const r = await api<{ score: number; myVote: Vote }>(`/api/doubts/answers/${a.id}/vote`, { body: { value: v } })
      setData(x => x && { ...x, answers: x.answers.map(y => (y.id === a.id ? { ...y, score: r.score, myVote: r.myVote } : y)) })
    } catch (e) { toast(say(e)) }
  }
  const accept = async (answerId: string | null) => {
    try { setData(await api<DoubtDetail>(`/api/doubts/${d.id}/accept`, { body: { answerId } })) } catch (e) { toast(say(e)) }
  }
  const delAnswer = async (a: DoubtAnswer) => {
    try { setData(await api<DoubtDetail>(`/api/doubts/answers/${a.id}`, { method: 'DELETE' })) } catch (e) { toast(say(e)) }
  }
  const delDoubt = async () => {
    try { await api(`/api/doubts/${d.id}`, { method: 'DELETE' }); toast('Doubt deleted.'); back() } catch (e) { toast(say(e)) }
  }
  const post = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      setData(await api<DoubtDetail>(`/api/doubts/${d.id}/answers`, { body: { body: answer, image } }))
      setAnswer('')
      setImage(null)
    } catch (err) { toast(say(err)) } finally { setBusy(false) }
  }
  const askAi = async () => {
    setAiBusy(true)
    try {
      const r = await api<DoubtDetail & { usage: { used: number; limit: number } }>(`/api/doubts/${d.id}/ai`, { method: 'POST' })
      setData(r)
      toast(`Lofi Tutor answered. AI questions used today: ${r.usage.used}/${r.usage.limit}.`)
    } catch (e) {
      if (e instanceof ApiError && e.status === 429 && /Pro/.test(e.message)) toast(e.message, { label: 'See Pro', run: () => openPro('tutor') })
      else toast(say(e))
    } finally { setAiBusy(false) }
  }

  return (
    <div className="flex flex-col gap-3">
      {zoom && <Lightbox src={zoom} onClose={() => setZoom(null)} />}
      <button className="px-btn self-start text-muted" onClick={back}>← All doubts</button>
      <article className="px-card flex gap-3 p-3" aria-label="Doubt">
        <Votes score={d.score} myVote={d.myVote} mine={d.mine} onVote={v => void voteDoubt(v)} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="bg-card-hi px-1.5 text-[15px]">{d.subject}</span>
            {d.acceptedAnswerId && <span className="bg-moss px-1.5 text-[15px] text-[#10200f]">✓ solved</span>}
          </div>
          <h3 className="mt-1 font-title text-[20px] leading-snug">{d.title}</h3>
          <div className="mt-1"><Byline author={d.author} at={d.createdAt} /></div>
          {d.body && <div className="mt-2"><Markdown text={d.body} /></div>}
          {d.image && <button className="mt-2 block" onClick={() => setZoom(d.image)} aria-label="Open photo"><img src={d.image} alt="Photo attached to the doubt" className="max-h-64 border-2 border-line" /></button>}
          {d.canDelete && (
            <div className="mt-2 flex items-center gap-2 text-[17px]">
              {confirmDel
                ? <><span>Delete this doubt and its answers?</span><button className="px-solid !bg-rose !py-0 !text-white" onClick={() => void delDoubt()}>Delete</button><button className="px-btn" onClick={() => setConfirmDel(false)}>Keep</button></>
                : <button className="px-btn flex items-center gap-1 text-muted hover:!text-rose" onClick={() => setConfirmDel(true)}><PixelIcon name="trash" size={14} /> Delete</button>}
            </div>
          )}
        </div>
      </article>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="font-title text-[16px] text-muted">{answers.length ? `${answers.length} answer${answers.length > 1 ? 's' : ''}` : 'No answers yet'}</h4>
        {data.ai.configured && !data.ai.answered && (
          <button className="px-solid flex items-center gap-1" onClick={() => void askAi()} disabled={aiBusy}>
            <PixelIcon name="tutor" size={16} /> {aiBusy ? <>Lofi Tutor is writing<span className="blink">…</span></> : 'Ask the AI tutor to answer'}
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-2" aria-label="Answers">
        {answers.map(a => {
          const accepted = d.acceptedAnswerId === a.id
          return (
            <li key={a.id} className={`px-card flex gap-3 p-3 ${accepted ? 'outline-2 outline-moss' : ''}`}>
              <Votes score={a.score} myVote={a.myVote} mine={a.mine} onVote={v => void voteAnswer(a, v)} size="sm" />
              <div className="min-w-0 flex-1">
                {accepted && <p className="mb-1 text-[16px] text-moss">✓ This solved it for {d.author.name}</p>}
                <Byline author={a.author} at={a.createdAt} ai={a.isAi} />
                <div className="mt-1"><Markdown text={a.body} /></div>
                {a.image && <button className="mt-2 block" onClick={() => setZoom(a.image)} aria-label="Open photo"><img src={a.image} alt="Photo in the answer" className="max-h-56 border-2 border-line" /></button>}
                {a.isAi && <p className="mt-1 text-[15px] text-muted">AI answers can be wrong: check them against your notes.</p>}
                <div className="mt-1 flex flex-wrap gap-3 text-[17px]">
                  {d.mine && (accepted
                    ? <button className="px-btn text-muted" onClick={() => void accept(null)}>Unmark solution</button>
                    : <button className="px-btn text-moss" onClick={() => void accept(a.id)}>✓ Mark as solution</button>)}
                  {a.canDelete && <button className="px-btn text-muted hover:!text-rose" onClick={() => void delAnswer(a)}>Delete</button>}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <form className="flex flex-col gap-2 border-t-2 border-line pt-3" onSubmit={post}>
        <label className="text-muted" htmlFor="doubt-answer">Your answer</label>
        <textarea id="doubt-answer" className="px-input min-h-[90px] resize-y" value={answer} onChange={e => setAnswer(e.target.value)} maxLength={8000} required placeholder="Explain how you'd solve it. Markdown and $maths$ work." />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ImagePick value={image} onChange={setImage} />
          <button className="px-solid px-primary" type="submit" disabled={busy || !answer.trim()}>{busy ? 'Posting…' : 'Post answer'}</button>
        </div>
      </form>
    </div>
  )
}

export default function DoubtsPanel({ onClose, openId }: { onClose: () => void; openId?: string | null }) {
  const [view, setView] = useState<View>(openId ? { kind: 'doubt', id: openId } : { kind: 'list' })
  useEffect(() => { if (openId) setView({ kind: 'doubt', id: openId }) }, [openId])
  const scroller = useRef<HTMLDivElement>(null)
  useEffect(() => { scroller.current?.closest('.px-scroll')?.scrollTo({ top: 0 }) }, [view])
  return (
    <Panel title={view.kind === 'ask' ? 'Ask a doubt' : 'Doubt board'} onClose={onClose} wide>
      <div ref={scroller}>
        {view.kind === 'list' && <DoubtList open={id => setView({ kind: 'doubt', id })} ask={() => setView({ kind: 'ask' })} />}
        {view.kind === 'ask' && <AskForm done={id => setView({ kind: 'doubt', id })} cancel={() => setView({ kind: 'list' })} />}
        {view.kind === 'doubt' && <DoubtView id={view.id} back={() => setView({ kind: 'list' })} />}
      </div>
    </Panel>
  )
}
