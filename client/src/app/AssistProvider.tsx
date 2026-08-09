import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, ApiError } from '../api/client'
import type { AssistStreamHandlers } from '../api/client'
import type {
  Agent,
  AssistChatResponse,
  Conversation,
  ConversationMessage,
  UpdateConversationRequest,
} from '../api/types'
import { useSession } from './SessionProvider'
import { getLastAgent, setLastAgent } from './assistPrefs'
import { useAssistTurns } from './assistTurns'
import type { TurnState, TurnAttachment } from './assistTurns'

/**
 * Assist's state — the conversation list, the roster, and the one send path.
 *
 * <b>The transcripts are not here.</b> They live on the server, in `Conversation`/`ConversationMessage`,
 * because the design needs them on a phone as well as the panel, searchable by the home server, and
 * deletable from the agent's memory. `assistantHistory.ts` — the panel-local `localStorage` store this
 * replaces — could do none of those things.
 *
 * What this provider owns is the *list*: the thing the tab shows, the thing a poll refreshes, and the
 * thing every gesture mutates. A single chat's stored turns are loaded by the chat screen, which is
 * the only screen that needs them.
 *
 * It also owns the turns still being *written* — see `assistTurns.ts`. Those were the chat screen's
 * own state until leaving the screen was found to destroy them, message and all; they belong to
 * something mounted above the router, and this is it.
 */
interface AssistState extends TurnState {
  conversations: Conversation[]
  agents: Agent[]
  /** The agent whose list is on screen. Chats are scoped to (member, agent). */
  agentKey: string | null
  agent: Agent | null
  archivedCount: number
  storeConversations: boolean
  retentionDays: number
  loading: boolean
  /** Unread chats with the *other* agents — the badge beside the header chevron. */
  otherUnread: number
  selectAgent: (key: string) => void
  refresh: () => Promise<void>
  /** Send a turn and wait for the whole reply. Omitting `conversationId` starts a new chat. */
  send: (prompt: string, conversationId?: number | null, spoken?: boolean) => Promise<AssistChatResponse | null>
  /**
   * Send a turn and receive it as it is produced — the path the chat screen uses.
   *
   * `send` remains for the cases with nothing to stream: a spoken turn, whose reply is handed to
   * text-to-speech whole, and anywhere the caller needs the finished text before it can act.
   */
  stream: (
    prompt: string,
    conversationId: number | null,
    handlers: AssistStreamHandlers,
    signal?: AbortSignal,
    attachment?: TurnAttachment | null,
  ) => Promise<void>
  patch: (id: number, change: UpdateConversationRequest) => Promise<void>
  remove: (ids: number[]) => Promise<number>
}

const AssistContext = createContext<AssistState | null>(null)

/**
 * How often the list re-reads.
 *
 * Assist rides a poll rather than a socket for the same reason the notification feed does: the panel
 * is one client on a LAN, the data is a short list, and a persistent connection would be a second
 * transport to keep alive across the panel's idle/dim/lock cycle for no gain the household would
 * notice. Messages arriving from a phone show up within this window.
 */
const POLL_MS = 20_000

export function AssistProvider({ children }: { children: ReactNode }) {
  const { activeProfileId } = useSession()

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [agents, setAgents] = useState<Agent[]>([])
  const [agentKey, setAgentKey] = useState<string | null>(null)
  const [archivedCount, setArchivedCount] = useState(0)
  const [storeConversations, setStoreConversations] = useState(true)
  const [retentionDays, setRetentionDays] = useState(30)
  const [loading, setLoading] = useState(true)

  // The agent is read inside a polling effect that must not re-subscribe every time it changes.
  const agentRef = useRef<string | null>(null)
  agentRef.current = agentKey

  const load = useCallback(async () => {
    try {
      const list = await api.getConversations(agentRef.current)
      setConversations(list.conversations)
      setAgents(list.agents)
      setArchivedCount(list.archivedCount)
      setStoreConversations(list.storeConversations)
      setRetentionDays(list.retentionDays)
      // Settle on an agent the first time, and re-settle if the one on screen is no longer offered —
      // removed from config, or un-assigned from this member since the tab was opened. A header
      // naming an agent they cannot use is worse than one quietly falling back to the one they can.
      if (!agentRef.current || !list.agents.some((a) => a.key === agentRef.current)) {
        const remembered = getLastAgent(activeProfileId)
        const next =
          list.agents.find((a) => a.key === remembered)?.key
          ?? list.agents.find((a) => a.isDefault)?.key
          ?? list.agents[0]?.key
          ?? null
        setAgentKey(next)
        agentRef.current = next
      }
    } catch (err) {
      // A list that cannot load is an offline panel, not a broken one. The chip in the header
      // already says so, and blanking the last-known list would take away the only thing still
      // readable. Anything that is not an API error is a real fault and keeps propagating.
      if (!(err instanceof ApiError)) throw err
    } finally {
      setLoading(false)
    }
  }, [activeProfileId])

  useEffect(() => {
    setLoading(true)
    void load()
    const id = window.setInterval(() => void load(), POLL_MS)
    const onSync = () => void load()
    window.addEventListener('homehub:sync', onSync)
    return () => {
      window.clearInterval(id)
      window.removeEventListener('homehub:sync', onSync)
    }
  }, [load])

  const selectAgent = useCallback((key: string) => {
    setAgentKey(key)
    agentRef.current = key
    setLastAgent(activeProfileId, key)
    // Clear immediately rather than showing the previous agent's chats under the new agent's name
    // for a poll's worth of time. Switching agents switches the entire list — showing the wrong one,
    // however briefly, is the one thing the switch must never do.
    setConversations([])
    setLoading(true)
    void load()
  }, [load, activeProfileId])

  const send = useCallback(
    async (prompt: string, conversationId?: number | null, spoken = false) => {
      const res = await api.sendAssistTurn({
        conversationId: conversationId ?? null,
        // Only when starting a chat. An existing conversation owns its agent permanently — its
        // Hermes session lives in that profile's database and cannot be read from another — so the
        // server ignores this field for an existing chat, and sending it anyway would suggest
        // otherwise to the next person reading this call.
        agentKey: conversationId ? null : agentRef.current,
        prompt,
        spoken,
      })
      // An in-app action (a task added, a set point changed) → refresh the affected screens without
      // a reload, exactly as the overlay did.
      if (res.message.action) window.dispatchEvent(new Event('homehub:sync'))
      else void load()
      return res
    },
    [load],
  )

  const stream = useCallback(
    (
      prompt: string,
      conversationId: number | null,
      handlers: AssistStreamHandlers,
      signal?: AbortSignal,
      attachment?: TurnAttachment | null,
    ) =>
      api.streamAssistTurn(
        {
          conversationId,
          agentKey: conversationId ? null : agentRef.current,
          prompt,
          // Flattened here rather than sent as a nested object: the wire shape predates attachments
          // (an image already had two top-level fields), and adding a second, differently-shaped way
          // to say the same thing would leave the server reading two.
          imageBase64: attachment?.base64 ?? null,
          imageMediaType: attachment?.mediaType ?? null,
          attachmentName: attachment?.name ?? null,
          attachmentKind: attachment?.kind ?? null,
          attachmentBytes: attachment?.bytes ?? null,
          attachmentText: attachment?.text ?? null,
        },
        {
          ...handlers,
          onDone: (result) => {
            handlers.onDone(result)
            // After the answer is on screen, never before: the list refresh is bookkeeping and must
            // not sit between the last delta and the household seeing it.
            if (result.action) window.dispatchEvent(new Event('homehub:sync'))
            else void load()
          },
        },
        signal,
      ),
    [load],
  )

  const patch = useCallback(
    async (id: number, change: UpdateConversationRequest) => {
      // Optimistic: a swipe that waits for a round-trip before the row moves reads as a dropped
      // gesture on a touch panel. The reload behind it is what makes it true.
      setConversations((prev) =>
        prev
          .map((c) => (c.id === id ? applyPatch(c, change) : c))
          // Archiving takes the row out of this list; the archive screen is where it lives now.
          .filter((c) => !(c.id === id && change.archived === true)),
      )
      await api.updateConversation(id, change)
      await load()
    },
    [load],
  )

  const remove = useCallback(
    async (ids: number[]) => {
      setConversations((prev) => prev.filter((c) => !ids.includes(c.id)))
      const res = await api.deleteConversations(ids)
      await load()
      return res.deleted
    },
    [load],
  )

  // Above the router and outside every screen, so a turn survives being navigated away from.
  const { turns, runTurn, cancelTurn, settleTurn, clearTurn, retryTurn } = useAssistTurns(stream, agentKey)

  const agent = useMemo(() => agents.find((a) => a.key === agentKey) ?? null, [agents, agentKey])
  const otherUnread = useMemo(
    () => agents.filter((a) => a.key !== agentKey).reduce((sum, a) => sum + a.unread, 0),
    [agents, agentKey],
  )

  const value = useMemo<AssistState>(
    () => ({
      conversations, agents, agentKey, agent, archivedCount, storeConversations, retentionDays,
      loading, otherUnread, selectAgent, refresh: load, send, stream, patch, remove,
      turns, runTurn, cancelTurn, settleTurn, clearTurn, retryTurn,
    }),
    [conversations, agents, agentKey, agent, archivedCount, storeConversations, retentionDays,
      loading, otherUnread, selectAgent, load, send, stream, patch, remove,
      turns, runTurn, cancelTurn, settleTurn, clearTurn, retryTurn],
  )

  return <AssistContext.Provider value={value}>{children}</AssistContext.Provider>
}

function applyPatch(c: Conversation, change: UpdateConversationRequest): Conversation {
  return {
    ...c,
    // Trimmed here as well as on the server, so the optimistic row and the reloaded one agree rather
    // than the title visibly shifting by a space when the reload lands.
    title: change.title?.trim() || c.title,
    pinned: change.pinned ?? c.pinned,
    archivedAtUtc: change.archived === undefined
      ? c.archivedAtUtc
      : change.archived ? new Date().toISOString() : null,
    unread: change.read === undefined ? c.unread : !change.read,
    unreadCount: change.read ? 0 : c.unreadCount,
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAssist(): AssistState {
  const ctx = useContext(AssistContext)
  if (!ctx) throw new Error('useAssist must be used within an AssistProvider')
  return ctx
}

/**
 * A chat's turns, loaded on open.
 *
 * Deliberately not in the provider: the list is polled and shared, a transcript is neither. Keeping
 * it here means opening a chat is one request and closing it forgets the whole thing, rather than the
 * provider accumulating every conversation the panel has looked at since it booted.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function useConversation(id: number | null) {
  const [messages, setMessages] = useState<ConversationMessage[]>([])
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    if (id === null) {
      setMessages([])
      setConversation(null)
      return
    }
    setLoading(true)
    try {
      const detail = await api.getConversation(id)
      setConversation(detail.conversation)
      setMessages(detail.messages)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { void load() }, [load])

  /** Append locally so the turn appears the instant it is sent, before the reply lands. */
  const append = useCallback((message: ConversationMessage) => {
    setMessages((prev) => [...prev, message])
  }, [])

  return { conversation, messages, loading, reload: load, append }
}
