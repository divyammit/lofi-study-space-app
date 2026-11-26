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
  | 'stats' | 'street' | 'chats' | 'friends' | 'profile' | 'settings' | 'tutor' | 'pro' | 'doubts'

export interface Account {
  id: string
  username: string
  email: string
  createdAt: number
}

/** What the server returns after login / signup / GET /api/auth/me */
export interface Plan {
  pro: boolean
  proUntil: number | null
}

export interface AppState {
  user: Account
  plan: Plan
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
  call: CallSummary | null
}

export interface RoomMessage {
  id: string
  roomId: string
  userId: string | null
  name: string
  avatar: number
  kind: 'text' | 'image'
  body: string
  createdAt: number
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

export interface TutorMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachmentKind: 'image' | 'whiteboard' | 'note' | null
  attachment: string | null
  createdAt: number
  streaming?: boolean
}

export interface TutorConversation { id: string; title: string; updatedAt: number; messages: number }

export interface TutorStatus {
  configured: boolean
  provider: string | null
  model: string | null
  plan: Plan
  usage: { used: number; limit: number }
  attachments: boolean
  freeLimit: number
  proLimit: number
}

export interface BillingPlan { id: 'pro_month' | 'pro_year'; name: string; days: number; amount: number; currency: string }
export interface PaymentRecord { id: string; plan: string; amount: number; currency: string; status: 'paid' | 'failed' | 'pending'; provider: 'razorpay' | 'demo' | 'upi'; orderId: string; reference: string | null; utr: string | null; reviewNote: string | null; method: 'card' | 'upi' | null; paymentId: string | null; createdAt: number; paidAt: number | null; proUntilAfter: number | null }
export interface BillingInfo {
  configured: boolean
  mode: 'razorpay_test' | 'razorpay_live' | 'upi' | 'demo' | 'off'
  isAdmin: boolean
  testMode: boolean
  plan: Plan
  plans: BillingPlan[]
  history: PaymentRecord[]
  limits: { freeDaily: number; proDaily: number }
}

export interface ReviewItem {
  id: string
  orderId: string
  plan: string
  planName: string
  amount: number
  status: 'pending' | 'paid' | 'failed'
  reference: string | null
  utr: string | null
  reviewNote: string | null
  createdAt: number
  claimedAt: number | null
  username: string
  name: string
  email?: string
  reviewedBy?: string | null
  reviewedAt?: number | null
}

// ---------- doubt board ----------
export interface DoubtAuthor { id: string; name: string; username: string; avatar: number }
export type Vote = -1 | 0 | 1
export interface DoubtSummary {
  id: string; title: string; subject: string; excerpt: string
  score: number; answers: number; solved: boolean; hasImage: boolean; hasAi: boolean
  createdAt: number; activeAt: number; author: DoubtAuthor; myVote: Vote; mine: boolean
}
export interface DoubtFull {
  id: string; title: string; subject: string; body: string; image: string | null
  score: number; answers: number; acceptedAnswerId: string | null
  createdAt: number; author: DoubtAuthor; myVote: Vote; mine: boolean; canDelete: boolean
}
export interface DoubtAnswer {
  id: string; body: string; image: string | null; isAi: boolean; score: number
  createdAt: number; author: DoubtAuthor; myVote: Vote; mine: boolean; canDelete: boolean
}
export interface DoubtDetail { doubt: DoubtFull; answers: DoubtAnswer[]; ai: { configured: boolean; answered: boolean } }
