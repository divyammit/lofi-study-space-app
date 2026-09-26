import { useMemo, useState } from 'react'
import { useStore } from '../../lib/store'
import { uid } from '../../lib/storage'
import { Panel, Empty } from '../ui'

export default function NotesPanel({ onClose }: { onClose: () => void }) {
  const { notes, setNotes, toast } = useStore()
  const [openId, setOpenId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [subject, setSubject] = useState<string>('All')
  const [quick, setQuick] = useState('')

  const subjects = useMemo(() => ['All', ...Array.from(new Set(notes.map(n => n.subject || 'General'))).sort()], [notes])
  const visible = notes
    .filter(n => subject === 'All' || (n.subject || 'General') === subject)
    .filter(n => {
      const q = query.trim().toLowerCase()
      return !q || n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q)
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const open = notes.find(n => n.id === openId)

  const create = (body = '', title = 'Untitled note') => {
    const id = uid()
    setNotes(ns => [{ id, title, subject: subject === 'All' ? 'General' : subject, body, updatedAt: Date.now() }, ...ns])
    return id
  }

  if (open) {
    const patch = (p: Partial<typeof open>) => setNotes(ns => ns.map(n => (n.id === open.id ? { ...n, ...p, updatedAt: Date.now() } : n)))
    return (
      <Panel
        title="Notes"
        onClose={onClose}
        actions={<>
          <button className="px-btn" onClick={() => setOpenId(null)}>[‹] All notes</button>
          <button className="px-btn hover:!text-rose" onClick={() => { setNotes(ns => ns.filter(n => n.id !== open.id)); setOpenId(null); toast('Note deleted.') }}>[x] Delete</button>
        </>}
      >
        <input className="px-input !border-0 !bg-transparent !px-0 font-title !text-[22px]" value={open.title} onChange={e => patch({ title: e.target.value })} aria-label="Note title" placeholder="Title" />
        <label className="mt-1 flex items-center gap-2 text-muted">
          Subject
          <input className="px-input !w-48 !py-0" list="note-subjects" value={open.subject} onChange={e => patch({ subject: e.target.value })} />
          <datalist id="note-subjects">{subjects.filter(s => s !== 'All').map(s => <option key={s} value={s} />)}</datalist>
        </label>
        <textarea
          className="px-input mt-3 min-h-[45vh] resize-y !border-line/50 leading-snug"
          value={open.body}
          onChange={e => patch({ body: e.target.value })}
          placeholder="Write what you learned..."
          aria-label="Note body"
        />
        <p className="mt-2 text-[16px] text-muted">Saved automatically · {new Date(open.updatedAt).toLocaleString()}</p>
      </Panel>
    )
  }

  return (
    <Panel title="Notes" onClose={onClose} actions={<button className="px-btn" onClick={() => setOpenId(create())}>[+] New note</button>}>
      <form
        className="px-card flex gap-2 p-2"
        onSubmit={e => {
          e.preventDefault()
          const text = quick.trim()
          if (!text) return
          const date = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
          create(text, `${date}: ${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`)
          setQuick('')
          toast('Saved to notes.')
        }}
      >
        <input className="px-input" placeholder="Today I learned..." value={quick} onChange={e => setQuick(e.target.value)} aria-label="Quick note" />
        <button className="px-solid shrink-0" type="submit">Save</button>
      </form>

      <input className="px-input mt-3" placeholder="Search notes" value={query} onChange={e => setQuery(e.target.value)} aria-label="Search notes" />
      <div className="mt-2 flex flex-wrap gap-1" role="tablist" aria-label="Subjects">
        {subjects.map(s => (
          <button key={s} role="tab" aria-selected={subject === s} className={`px-btn ${subject === s ? '!text-amber' : 'text-muted'}`} onClick={() => setSubject(s)}>
            {subject === s ? `[${s}]` : s}
          </button>
        ))}
      </div>

      <ul className="mt-3 flex flex-col gap-2">
        {visible.map(n => (
          <li key={n.id}>
            <button className="px-card block w-full p-3 text-left hover:bg-card-hi" onClick={() => setOpenId(n.id)}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-[21px]">{n.title || 'Untitled note'}</span>
                <span className="shrink-0 text-[16px] text-dusk">{n.subject || 'General'}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-muted">{n.body || 'Empty note'}</p>
            </button>
          </li>
        ))}
      </ul>
      {visible.length === 0 && <div className="mt-3"><Empty>{notes.length ? 'No notes match that search.' : 'No notes yet. Jot down one thing you learned today.'}</Empty></div>}
    </Panel>
  )
}
