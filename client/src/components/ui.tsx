import type { ReactNode } from 'react'
import PixelIcon from './PixelIcon'

/** `fill` makes the panel full height with a non-scrolling body, for layouts that manage their own scrolling (chat). */
export function Panel({ title, onClose, actions, children, wide, fill, lead }: { title: string; onClose: () => void; actions?: ReactNode; children: ReactNode; wide?: boolean; fill?: boolean; lead?: ReactNode }) {
  return (
    <section
      className={`px-panel panel-in flex max-h-full w-full flex-col ${fill ? 'h-full' : ''} ${wide ? 'md:w-[min(720px,58vw)]' : 'md:w-[min(560px,46vw)]'}`}
      aria-label={title}
    >
      <header className="flex items-start justify-between gap-3 px-5 pt-4 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          {lead}
          <h2 className="truncate font-title text-[22px] leading-tight tracking-wide uppercase md:text-[26px]">{title}</h2>
        </div>
        <button className="px-btn mt-1 shrink-0 text-muted" onClick={onClose} aria-label="Close panel">
          <PixelIcon name="close" size={16} />
        </button>
      </header>
      {actions && <div className="flex flex-wrap gap-x-4 gap-y-1 px-5 pb-2 text-[20px]">{actions}</div>}
      <div className={fill ? 'flex min-h-0 flex-1 flex-col px-3 pb-3 md:px-5' : 'px-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-5'}>{children}</div>
    </section>
  )
}

/** [X] style checkbox */
export function Check({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean }) {
  return (
    <label className={`flex cursor-pointer items-start gap-2 ${disabled ? 'opacity-50' : ''}`}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="shrink-0 text-amber peer-focus-visible:outline-2 peer-focus-visible:outline-dashed peer-focus-visible:outline-amber" aria-hidden="true">
        {checked ? '[X]' : '[ ]'}
      </span>
      <span>{label}</span>
    </label>
  )
}

/** Blocky progress bar like [■■■■■□□□] */
export function BlockBar({ value, blocks = 14, className = '' }: { value: number; blocks?: number; className?: string }) {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * blocks)
  return (
    <div className={`flex items-center gap-[3px] ${className}`} role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <span className="text-muted">[</span>
      {Array.from({ length: blocks }, (_, i) => (
        <span key={i} className={`h-[14px] flex-1 ${i < filled ? 'bg-ink' : 'bg-line/60'}`} />
      ))}
      <span className="text-muted">]</span>
    </div>
  )
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {options.map(o => (
        <button
          key={o.value}
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`px-solid !px-3 !py-1 ${value === o.value ? '!bg-amber !text-[#2a1c10]' : ''}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="mt-5 mb-2 border-b-2 border-line pb-1 font-title text-[15px] tracking-wide text-muted">{children}</h3>
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-card px-4 py-6 text-center text-muted">{children}</p>
}
