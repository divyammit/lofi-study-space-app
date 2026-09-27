export type Priority = 'low' | 'medium' | 'high'
export type TaskStatus = 'backlog' | 'progress' | 'done'

export interface Task {
  id: string
  title: string
  priority: Priority
  deadline?: string // YYYY-MM-DD
  status: TaskStatus
  createdAt: number
  completedAt?: number
}

export interface Note {
  id: string
  title: string
  subject: string
  body: string
  updatedAt: number
}

export interface Session {
  id: string
  date: string // YYYY-MM-DD (local)
  start: number
  minutes: number
  subject: string
  sample?: boolean // generated demo history
}

export type ThemeId = 'rainy' | 'library' | 'coffee' | 'sunset'
export type AnimationLevel = 'off' | 'low' | 'full'

export interface Settings {
  env: 'dark' | 'light'
  theme: ThemeId
  animation: AnimationLevel
  masterVolume: number // 0..1
  focusMin: number
  shortMin: number
  longMin: number
  longEvery: number
  dailyGoalMin: number
  autoStartNext: boolean
  autoSound: boolean
  notifyInApp: boolean
  notifyBrowser: boolean
  chime: boolean
}

export interface Profile {
  name: string
  avatar: number
  favSubject: string
}

export type SoundId = 'rain' | 'fire' | 'cafe' | 'library' | 'brown' | 'lofi'
export type SoundMix = Record<SoundId, { on: boolean; vol: number }>

export type PanelId =
  | 'timer' | 'tasks' | 'notes' | 'board' | 'sounds'
  | 'stats' | 'street' | 'chats' | 'friends' | 'profile' | 'settings'

export interface Account {
  id: string
  username: string
  email: string
  createdAt: number
}

/** What the server returns after login / signup / GET /api/auth/me */
export interface AppState {
  user: Account
  profile: Profile
  settings: Partial<Settings>
  whiteboard: string | null
  tasks: Task[]
  notes: Note[]
  sessions: Session[]
}

export interface MemberStatus {
  mode: 'focus' | 'short' | 'long'
  running: boolean
  endsAt: number | null // server clock
  remaining: number
  total: number
  subject: string
}

export interface RoomMember {
  id: string
  name: string
  avatar: number
  status: MemberStatus | null
}

export interface StudyRoom {
  id: string
  hostId: string
  host: string
  subject: string
  startedAt: number
  members: RoomMember[]
}

export interface Friend {
  id: string
  username: string
  name: string
  avatar: number
  online?: boolean
  roomId?: string | null
  subject?: string | null
  studying?: boolean
}

export interface FriendsData {
  friends: Friend[]
  incoming: Friend[]
  outgoing: Friend[]
}

export interface ChatMember {
  id: string
  username: string
  name: string
  avatar: number
  role: 'admin' | 'member'
}

export interface ChatMessage {
  id: string
  chatId: string
  userId: string | null
  kind: 'text' | 'image' | 'system'
  body: string
  createdAt: number
  pending?: boolean // shown before the server confirms it
  failed?: boolean
}

export interface CallParticipant {
  socketId: string
  userId: string
  name: string
  avatar: number
  audio: boolean
  video: boolean
  screen: boolean
}

export interface CallSummary {
  startedAt: number
  video: boolean
  board: boolean
  participants: CallParticipant[]
}

export interface Chat {
  id: string
  name: string | null
  isDirect: boolean
  createdAt: number
  lastReadAt: number
  unread: number
  members: ChatMember[]
  lastMessage: Pick<ChatMessage, 'id' | 'kind' | 'userId' | 'body' | 'createdAt'> | null
  call: CallSummary | null
}

/** One stroke segment on the shared call whiteboard, in 0..1 board coordinates. */
export interface BoardStroke { p: [number, number, number, number]; c: string; w: number; e: boolean }
export interface BoardState { strokes: BoardStroke[]; bg: string | null; openedBy: string }
