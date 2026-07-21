import type { AssistantOriginName } from '../api/types'

/**
 * Per-profile assistant conversation history, persisted in localStorage (the assistant itself is
 * stateless server-side, per its design). Keyed by profile id so each household member sees only
 * their own conversations (THE_ATTENDANT.md · With History). Newest-first, capped so the kiosk's
 * storage can't grow without bound.
 */
export interface HistoryTurn {
  role: 'user' | 'assistant'
  text: string
  origin?: AssistantOriginName
  escalated?: boolean
}

export interface Conversation {
  id: string
  title: string
  startedAt: number
  lastAt: number
  turns: HistoryTurn[]
}

const MAX_CONVERSATIONS = 50
const key = (profileId: number | null) => `homehub.assistant.v1.${profileId ?? 'guest'}`

export function loadConversations(profileId: number | null): Conversation[] {
  try {
    const raw = localStorage.getItem(key(profileId))
    const parsed = raw ? (JSON.parse(raw) as Conversation[]) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Upsert a conversation and return the updated, newest-first list. */
export function saveConversation(profileId: number | null, convo: Conversation): Conversation[] {
  const next = [convo, ...loadConversations(profileId).filter((c) => c.id !== convo.id)]
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, MAX_CONVERSATIONS)
  try {
    localStorage.setItem(key(profileId), JSON.stringify(next))
  } catch {
    /* storage full / unavailable — history is best-effort */
  }
  return next
}

export function newConversationId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/** Count of user↔assistant exchanges (label reads "N exchanges" / "1 exchange"). */
export function exchangeCount(turns: HistoryTurn[]): number {
  return turns.filter((t) => t.role === 'user').length
}

/** Relative timestamp for a history row: "Just now", "Today · 8:04 AM", "Yesterday · …", weekday, or date. */
export function formatWhen(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (now - ts < 90_000) return 'Just now'

  const startOfDay = (t: number) => {
    const x = new Date(t)
    x.setHours(0, 0, 0, 0)
    return x.getTime()
  }
  const dayDiff = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)
  if (dayDiff === 0) return `Today · ${time}`
  if (dayDiff === 1) return `Yesterday · ${time}`
  if (dayDiff < 7) return `${d.toLocaleDateString('en-US', { weekday: 'long' })} · ${time}`
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${time}`
}
