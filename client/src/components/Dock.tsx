import type { PanelId } from '../lib/types'
import PixelIcon, { type IconName } from './PixelIcon'

const ITEMS: { id: PanelId; icon: IconName; label: string }[] = [
  { id: 'timer', icon: 'timer', label: 'Timer' },
  { id: 'tasks', icon: 'tasks', label: 'Tasks' },
  { id: 'notes', icon: 'notes', label: 'Notes' },
  { id: 'board', icon: 'board', label: 'Whiteboard' },
  { id: 'sounds', icon: 'sounds', label: 'Sounds' },
  { id: 'stats', icon: 'stats', label: 'Analytics' },
  { id: 'street', icon: 'street', label: 'Study street' },
  { id: 'chats', icon: 'chat', label: 'Chats' },
  { id: 'friends', icon: 'friends', label: 'Friends' },
  { id: 'profile', icon: 'profile', label: 'Profile' },
  { id: 'settings', icon: 'settings', label: 'Settings' },
]

export default function Dock({ active, onPick, onFocus, badges = {} }: { active: PanelId | null; onPick: (p: PanelId) => void; onFocus: () => void; badges?: Partial<Record<PanelId, number>> }) {
  return (
    <nav aria-label="Room tools" className="px-scroll flex max-w-full items-center overflow-x-auto pb-4 md:gap-1">
      <button className="group relative flex shrink-0 flex-col items-center px-[7px] py-1 text-[#ece3d0] hover:text-[#f2a65a] md:px-2" onClick={onFocus} title="Focus mode" aria-label="Focus mode">
        <PixelIcon name="focus" size={24} />
        <span className="pointer-events-none absolute top-full left-1/2 hidden -translate-x-1/2 text-[14px] leading-none whitespace-nowrap opacity-0 md:block transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">Focus</span>
      </button>
      {ITEMS.map(i => (
        <button
          key={i.id}
          onClick={() => onPick(i.id)}
          aria-pressed={active === i.id}
          aria-label={badges[i.id] ? `${i.label}, ${badges[i.id]} new` : i.label}
          title={i.label}
          className={`group relative flex shrink-0 flex-col items-center px-[7px] py-1 md:px-2 ${active === i.id ? 'text-[#f2a65a]' : 'text-[#ece3d0] hover:text-[#f2a65a]'}`}
        >
          <PixelIcon name={i.icon} size={24} />
          {!!badges[i.id] && (
            <span className="absolute top-0 right-0 min-w-[16px] bg-[#e8707e] px-[3px] text-center text-[13px] leading-[16px] text-white" aria-hidden="true">
              {badges[i.id]! > 99 ? '99+' : badges[i.id]}
            </span>
          )}
          <span className={`pointer-events-none absolute top-full left-1/2 hidden -translate-x-1/2 text-[14px] leading-none whitespace-nowrap transition-opacity md:block ${active === i.id ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'}`}>{i.label}</span>
        </button>
      ))}
    </nav>
  )
}
