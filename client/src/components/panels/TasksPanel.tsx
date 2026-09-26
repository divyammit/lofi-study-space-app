import { useState } from 'react'
import { useStore } from '../../lib/store'
import type { Priority, Task, TaskStatus } from '../../lib/types'
import { uid } from '../../lib/storage'
import { dayKey, parseDay } from '../../lib/dates'
import { Panel, BlockBar, Seg, Empty } from '../ui'

const COLS: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'progress', label: 'In progress' },
  { id: 'done', label: 'Done' },
]
const PRIO: Record<Priority, { mark: string; cls: string; label: string }> = {
  high: { mark: '!!!', cls: 'text-rose', label: 'High' },
  medium: { mark: '!!', cls: 'text-amber', label: 'Medium' },
  low: { mark: '!', cls: 'text-moss', label: 'Low' },
}
type Filter = 'all' | 'active' | 'done'

export default function TasksPanel({ onClose }: { onClose: () => void }) {
  const { tasks, setTasks, toast } = useStore()
  const [adding, setAdding] = useState(false)
  const [filter, setFilter] = useState<Filter>('all')
  const [draft, setDraft] = useState({ title: '', priority: 'medium' as Priority, deadline: '' })
  const [dragId, setDragId] = useState<string | null>(null)

  const done = tasks.filter(t => t.status === 'done').length
  const update = (id: string, patch: Partial<Task>) => setTasks(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t)))
  const move = (id: string, status: TaskStatus) => update(id, { status, completedAt: status === 'done' ? Date.now() : undefined })
  const add = () => {
    const title = draft.title.trim()
    if (!title) return
    setTasks(ts => [...ts, { id: uid(), title, priority: draft.priority, deadline: draft.deadline || undefined, status: 'backlog', createdAt: Date.now() }])
    setDraft({ title: '', priority: draft.priority, deadline: '' })
  }
  const archive = () => {
    if (!done) return toast('Nothing in Done to archive yet.')
    setTasks(ts => ts.filter(t => t.status !== 'done'))
    toast(`Archived ${done} finished task${done > 1 ? 's' : ''}.`)
  }
  const cols = COLS.filter(c => filter === 'all' || (filter === 'active' ? c.id !== 'done' : c.id === 'done'))

  return (
    <Panel
      title="Kanban board"
      onClose={onClose}
      wide
      actions={<>
        <button className="px-btn" onClick={() => setAdding(a => !a)} aria-expanded={adding}>[+] Card</button>
        <button className="px-btn" onClick={archive}>[✓] Archive done</button>
      </>}
    >
      {adding && (
        <form className="px-card mb-4 grid gap-2 p-3 sm:grid-cols-[1fr_auto_auto_auto]" onSubmit={e => { e.preventDefault(); add() }}>
          <input autoFocus className="px-input" placeholder="What needs doing?" value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} aria-label="Task title" />
          <select className="px-input sm:w-32" value={draft.priority} onChange={e => setDraft(d => ({ ...d, priority: e.target.value as Priority }))} aria-label="Priority">
            <option value="high">High</option><option value="medium">Medium</option><option value="low">Low</option>
          </select>
          <input type="date" className="px-input sm:w-44" value={draft.deadline} onChange={e => setDraft(d => ({ ...d, deadline: e.target.value }))} aria-label="Deadline (optional)" />
          <button className="px-solid px-primary" type="submit">Add task</button>
        </form>
      )}

      <Seg label="Filter tasks" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'done', label: 'Completed' }]} />

      <div className={`mt-3 grid gap-3 ${cols.length === 3 ? 'md:grid-cols-3' : cols.length === 2 ? 'sm:grid-cols-2' : ''}`}>
        {cols.map(col => {
          const items = tasks.filter(t => t.status === col.id).sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.priority] - { high: 0, medium: 1, low: 2 }[b.priority]))
          return (
            <div
              key={col.id}
              className={`min-h-24 border-2 border-dashed p-1 transition-colors ${dragId ? 'border-line' : 'border-transparent'}`}
              onDragOver={e => { e.preventDefault() }}
              onDrop={() => { if (dragId) move(dragId, col.id); setDragId(null) }}
            >
              <h3 className="mb-2 font-title text-[16px] tracking-wide">{col.label} <span className="text-muted">{items.length}</span></h3>
              <div className="flex flex-col gap-2">
                {items.length === 0 && <p className="px-2 py-3 text-muted">{col.id === 'done' ? 'Finished tasks land here.' : 'Empty. Drag a card here.'}</p>}
                {items.map(t => <Card key={t.id} task={t} onMove={move} onUpdate={update} onDelete={id => setTasks(ts => ts.filter(x => x.id !== id))} onDrag={setDragId} />)}
              </div>
            </div>
          )
        })}
      </div>
      {tasks.length === 0 && <Empty>No tasks yet. Add one with [+] Card.</Empty>}

      <div className="mt-4 border-t-2 border-line pt-3">
        <div className="flex items-center gap-3">
          <BlockBar value={tasks.length ? done / tasks.length : 0} className="flex-1" />
          <span className="whitespace-nowrap">{done} / {tasks.length} tasks completed</span>
        </div>
      </div>
    </Panel>
  )
}

function Card({ task, onMove, onUpdate, onDelete, onDrag }: {
  task: Task
  onMove: (id: string, s: TaskStatus) => void
  onUpdate: (id: string, p: Partial<Task>) => void
  onDelete: (id: string) => void
  onDrag: (id: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(task.title)
  const idx = COLS.findIndex(c => c.id === task.status)
  const overdue = task.deadline && task.status !== 'done' && task.deadline < dayKey()
  const due = task.deadline ? parseDay(task.deadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : null
  const p = PRIO[task.priority]
  return (
    <article
      className={`px-card group p-3 ${task.status === 'done' ? 'opacity-70' : ''}`}
      draggable={!editing}
      onDragStart={() => onDrag(task.id)}
      onDragEnd={() => onDrag(null)}
    >
      <div className="flex items-start gap-2">
        <button
          className="px-btn shrink-0 !p-0 text-amber"
          onClick={() => onMove(task.id, task.status === 'done' ? 'backlog' : 'done')}
          aria-label={task.status === 'done' ? `Mark "${task.title}" as not done` : `Mark "${task.title}" as done`}
        >
          {task.status === 'done' ? '[X]' : '[ ]'}
        </button>
        {editing ? (
          <form className="flex-1" onSubmit={e => { e.preventDefault(); if (title.trim()) onUpdate(task.id, { title: title.trim() }); setEditing(false) }}>
            <input autoFocus className="px-input" value={title} onChange={e => setTitle(e.target.value)} onBlur={() => { if (title.trim()) onUpdate(task.id, { title: title.trim() }); setEditing(false) }} aria-label="Edit task title" />
          </form>
        ) : (
          <button className={`flex-1 text-left ${task.status === 'done' ? 'line-through' : ''}`} onClick={() => setEditing(true)} title="Click to edit">{task.title}</button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[18px]">
        <span className={p.cls} title={`${p.label} priority`}>{p.mark} <span className="sr-only">{p.label} priority</span></span>
        <select
          className="bg-transparent text-muted outline-none hover:text-ink"
          value={task.priority}
          onChange={e => onUpdate(task.id, { priority: e.target.value as Priority })}
          aria-label="Change priority"
        >
          <option value="high">high</option><option value="medium">medium</option><option value="low">low</option>
        </select>
        {due && <span className={overdue ? 'text-rose' : 'text-muted'}>{overdue ? 'overdue ' : 'due '}{due}</span>}
        <span className="ml-auto flex gap-1">
          <button className="px-btn !px-1" disabled={idx === 0} onClick={() => onMove(task.id, COLS[idx - 1].id)} aria-label="Move left">‹</button>
          <button className="px-btn !px-1" disabled={idx === 2} onClick={() => onMove(task.id, COLS[idx + 1].id)} aria-label="Move right">›</button>
          <button className="px-btn !px-1 text-muted hover:!text-rose" onClick={() => onDelete(task.id)} aria-label={`Delete "${task.title}"`}>del</button>
        </span>
      </div>
    </article>
  )
}
