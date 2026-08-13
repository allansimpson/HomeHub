import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { ScreenShell } from '../../components/ScreenShell'
import { SectionLabel } from '../../components/SectionLabel'
import { Icon } from '../../icons/Icon'
import { useAssist } from '../../app/AssistProvider'
import { selectPendingChat } from '../../app/assistTurns'
import { useSession } from '../../app/SessionProvider'
import { useVoice } from '../../app/VoiceProvider'
import { api, ApiError } from '../../api/client'
import type { Conversation, SearchResults as Results, UpdateConversationRequest } from '../../api/types'
import { AssistComposer } from './AssistComposer'
import { setHandoffAttachment } from './handoff'
import { AgentSwitcher } from './AgentSwitcher'
import { ChatRow } from './ChatRow'
import { DeleteConfirm } from './DeleteConfirm'
import { SearchResults } from './SearchResults'

/**
 * Assist — the inbox (ASSIST.md · `1a`, empty state `1m`).
 *
 * The household's messaging surface: chat-first, voice one tap away. Top to bottom — the agent name,
 * the double rule, search, PINNED, the chats themselves, the `ARCHIVED CHATS (n)` footer row, and the
 * composer above the nav bar.
 *
 * **There is no CONVERSATIONS heading.** It was the design's, and it was removed on use: it sat above
 * the only unlabelled group on a screen whose entire content is that group, so it named the screen
 * rather than a section of it. PINNED stays, because it labels a genuine division — and with nothing
 * pinned it does not appear, which leaves the list heading-free, which is what it should have been.
 * The word is gone from the rest of this surface with it; the household calls these chats.
 *
 * **There is no NEW CHAT button and no EDIT link, and there are no sample prompts.** All three were
 * removed from the design deliberately: typing in the composer starts a chat, so a button for it is
 * a second way to do the thing the input already does, and starter chips are a menu of things to say
 * to something you are supposed to talk to.
 *
 * The screen has three bodies and shows exactly one: search results while there is a query, the
 * empty state while there is nothing, and the list otherwise. Selection mode (`1g`) is a state of
 * the list rather than a fourth body — the rows are the same rows, doing a different job.
 *
 * @category Screen
 */
export function AssistScreen() {
  const navigate = useNavigate()
  const { activeProfileId } = useSession()
  const {
    conversations, agent, agents, agentKey, selectAgent,
    archivedCount, storeConversations, loading, otherUnread, patch, remove, refresh, turns,
  } = useAssist()

  const [query, setQuery] = useState('')
  const [switcherOpen, setSwitcherOpen] = useState(false)

  /** Null is "not selecting". An empty array is selection mode with nothing picked yet. */
  const [selection, setSelection] = useState<number[] | null>(null)
  const [confirming, setConfirming] = useState(false)

  const [results, setResults] = useState<Results | null>(null)
  const [searching, setSearching] = useState(false)

  const { pinned, rest } = useMemo(() => ({
    pinned: conversations.filter((c) => c.pinned),
    rest: conversations.filter((c) => !c.pinned),
  }), [conversations])

  /** The chat that has been started but does not exist yet — see {@link selectPendingChat}. */
  const pendingChat = useMemo(
    () => selectPendingChat(turns, conversations.map((c) => c.id)),
    [turns, conversations],
  )

  const openChat = useCallback((id: number) => navigate(`/assist/c/${id}`), [navigate])

  // ---- Search (1i) ----

  // The server's own floor (`AssistFieldLimits.MinSearchChars`). Below it a query matches
  // everything, so the screen keeps showing the list rather than swapping in a results view that
  // would only ever say "no matches" for a search nobody ran.
  const term = query.trim().length >= 2 ? query.trim() : ''

  useEffect(() => {
    if (!term) {
      setResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    // Debounced: the panel's on-screen keyboard emits a keystroke per tap and the server is
    // searching whole transcripts. Firing per character would have the household reading results
    // for a prefix of what they typed.
    const id = window.setTimeout(async () => {
      try {
        setResults(await api.searchConversations(agentKey, term))
      } catch (err) {
        // Offline searches nothing rather than claiming nothing was found. The chip in the header
        // is already saying why, and "No matches" would be a different and wrong answer.
        if (!(err instanceof ApiError)) throw err
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => window.clearTimeout(id)
  }, [term, activeProfileId, agentKey])

  // ---- Gestures (1f, 1g) ----

  /**
   * Apply a gesture, and put the row back if it did not take.
   *
   * The provider moves the row optimistically — a swipe that waits for a round-trip reads as a
   * dropped gesture — so an offline panel would otherwise show a conversation as archived when the
   * server never heard about it. Reloading is what makes the list true again.
   */
  const applyGesture = useCallback(
    (id: number, change: UpdateConversationRequest) => {
      void patch(id, change).catch(async (err: unknown) => {
        if (!(err instanceof ApiError)) throw err
        await refresh()
      })
    },
    [patch, refresh],
  )

  const archive = useCallback((id: number) => applyGesture(id, { archived: true }), [applyGesture])

  const togglePin = useCallback(
    (chat: Conversation) => applyGesture(chat.id, { pinned: !chat.pinned }),
    [applyGesture],
  )

  const toggleSelect = useCallback((id: number) => {
    setSelection((prev) => {
      if (prev === null) return [id]
      return prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    })
  }, [])

  const exitSelection = useCallback(() => {
    setSelection(null)
    setConfirming(false)
  }, [])

  const selected = useMemo(
    () => (selection === null ? [] : conversations.filter((c) => selection.includes(c.id))),
    [selection, conversations],
  )

  const confirmDelete = useCallback(async () => {
    try {
      await remove(selected.map((c) => c.id))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      // The rows were taken out of the list the moment the button was pressed. Reloading puts back
      // whatever the server still holds, which is the honest report: the conversations reappearing
      // is how the household learns the delete did not happen.
      await refresh()
    }
    exitSelection()
  }, [remove, refresh, selected, exitSelection])

  // Switching agents replaces the whole list, and searching replaces the body with results — either
  // way a selection made against the rows underneath would be holding conversations nobody can see,
  // in front of a trash button that would still delete them.
  useEffect(() => { setSelection(null); setConfirming(false) }, [agentKey, term])

  // The header names the current agent. With one agent assigned there is no chevron, no badge and no
  // tap target — the agent is locked, and a control that only ever leads back to where you already
  // are is worse than no control (ASSIST.md · Header rule).
  const switchable = agents.length > 1
  const agentName = agent?.name ?? 'Assist'

  const selecting = selection !== null
  // A first chat still being written is not an empty inbox. Showing "No chats yet" over the top of a
  // turn the panel is actively streaming is the same lie the missing row was, told louder.
  const empty = !loading && conversations.length === 0 && !pendingChat

  /**
   * Nothing on this panel that a search could return.
   *
   * The archive counts. Search reads active *and* archived transcripts (`1i`), so an inbox emptied
   * by archiving still has everything to find — which is exactly when the field earns its place.
   * The only case with nothing behind it is no active chats and no archived ones, and a search box
   * over that offers to look through a void.
   *
   * Deliberately keyed off `empty`, which waits for the first load. Hiding on `conversations.length`
   * alone would hide the field on every cold start and then pop it in when the list landed — a
   * flicker on the common path to avoid one on the rare path.
   */
  const nothingToSearch = empty && archivedCount === 0

  const header = (
    /* `ml-header` for the 88px right padding every screen reserves for the account avatar — without
       it the MIC OFF state runs underneath the avatar and clips to "MIC". */
    <header className="ml-header ml-assist__header">
      <div className="ml-assist__identity">
        {switchable ? (
          <button
            type="button"
            className="ml-assist__agent"
            aria-haspopup="menu"
            aria-expanded={switcherOpen}
            onClick={() => setSwitcherOpen((open) => !open)}
          >
            <span className="serif ml-assist__agentname">{agentName}</span>
            <span className={'ml-assist__chev' + (switcherOpen ? ' ml-assist__chev--open' : '')}>
              <Icon id="ico-chevron-down" size="1rem" />
            </span>
            {otherUnread > 0 && (
              <span className="ml-assist__agentbadge">
                {otherUnread}
                <span className="ml-visually-hidden"> unread with other agents</span>
              </span>
            )}
          </button>
        ) : (
          /* One agent: the name alone. No chevron, no badge, no tap target — the agent is locked,
             and a control that only ever leads back to where you already are is worse than none. */
          <span className="serif ml-assist__agentname">{agentName}</span>
        )}
      </div>
      <MicState />
    </header>
  )

  return (
    /* The avatar carries no wants-you badge here, for the same reason the notification inbox
       suppresses it: Assist has its own unread count in the header, and two badges a few
       millimetres apart counting different things is worse than one. */
    <ScreenShell header={header} avatarBadge={false}>
      {switcherOpen && (
        <AgentSwitcher
          agents={agents}
          activeKey={agentKey}
          onSelect={selectAgent}
          onDismiss={() => setSwitcherOpen(false)}
        />
      )}

      {/*
        One row, two shapes. Entering selection slides an exit in on the left and a trash in on the
        right and narrows the search box between them — rather than swapping in a separate toolbar,
        which would make the search field disappear at the moment you might want to narrow a list
        you are picking from. All three boxes are the same height by `align-items: stretch`.

        The whole row goes when there is nothing to search (`nothingToSearch`) — a first-run panel
        with no chats and no archive. It is the one control here that can be absent without hiding a
        capability: with no transcripts on the box, searching them is not a thing the screen can do
        yet, and offering it anyway is the disabled-control problem wearing an input's clothes.
      */}
      {!nothingToSearch && (
        <div className={'ml-assist__searchrow' + (selecting ? ' ml-assist__searchrow--selecting' : '')}>
          {selecting && (
            <button
              type="button"
              className="ml-assist__seltool"
              onClick={exitSelection}
              aria-label="Leave selection"
            >
              <span aria-hidden="true">✕</span>
            </button>
          )}

          <label className="ml-assist__search">
            <Icon id="ico-search" size="1.0625rem" />
            <input
              className="ml-assist__searchinput"
              value={query}
              placeholder="Search all chats…"
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search all chats"
            />
          </label>

          {selecting && (
            <button
              type="button"
              className="ml-assist__seltool ml-assist__seltool--danger"
              onClick={() => setConfirming(true)}
              disabled={selected.length === 0}
              aria-label={`Delete ${selected.length} selected`}
            >
              <Icon id="ico-trash" size="1.0625rem" />
            </button>
          )}
        </div>
      )}

      {selecting && (
        <div className="ml-assist__selcount" role="status">
          {`${selected.length} selected`}
        </div>
      )}

      <div className="ml-assist__list">
        {term ? (
          <SearchResults results={results} searching={searching} onOpen={openChat} />
        ) : empty ? (
          <AssistEmpty agentName={agentName} storing={storeConversations} archived={archivedCount} />
        ) : (
          <>
            {/* Above PINNED, and above everything: it is the newest thing here and the only one still
                happening. Not swipeable and not selectable — archive, pin and delete all need an id,
                and offering gestures that cannot fire would be worse than not offering them. */}
            {pendingChat && !selecting && (
              <PendingChatRow
                agentName={agentName}
                title={pendingChat.title}
                preview={pendingChat.preview}
                status={pendingChat.status}
                onOpen={() => navigate('/assist/c')}
              />
            )}

            {pinned.length > 0 && (
              <>
                <SectionLabel label="Pinned" />
                {pinned.map((c) => (
                  <ChatRow
                    key={c.id}
                    chat={c}
                    onOpen={openChat}
                    onArchive={archive}
                    onTogglePin={togglePin}
                    onSelectToggle={toggleSelect}
                    selected={selection === null ? null : selection.includes(c.id)}
                  />
                ))}
              </>
            )}

            {rest.length > 0 && (
              <>
                {/* No heading — see the screen's own note. The rows follow PINNED directly, and with
                    nothing pinned they follow the search box. */}
                {rest.map((c) => (
                  <ChatRow
                    key={c.id}
                    chat={c}
                    onOpen={openChat}
                    onArchive={archive}
                    onTogglePin={togglePin}
                    onSelectToggle={toggleSelect}
                    selected={selection === null ? null : selection.includes(c.id)}
                  />
                ))}
              </>
            )}
          </>
        )}

        {/*
          The only entry point to the archive. Centred, quiet, and carrying its own count so the
          household knows whether there is anything behind it before tapping.

          Outside the empty/list branch on purpose: archiving the last conversation empties the list,
          and hiding this with it would strand every archived chat behind having to start a new one
          just to get the row back. Hidden while selecting — it is navigation, and leaving the screen
          would drop the selection — and while searching, where the archive is already being read.
        */}
        {archivedCount > 0 && !selecting && !term && (
          <button type="button" className="ml-assist__archiverow" onClick={() => navigate('/assist/archive')}>
            <span>{`Archived chats (${archivedCount})`}</span>
            <Icon id="ico-chevron-right" size="0.75rem" />
          </button>
        )}
      </div>

      {/*
        Typing here starts a new chat — that is what replaced the NEW CHAT button.

        The prompt is handed to the chat screen rather than sent from here. Sending from the list
        meant standing on the inbox for the whole round trip with nothing to show for it, and then
        arriving at a conversation that was already over; now the chat opens on the words just typed
        and the reply streams in underneath them.
      */}
      <AssistComposer
        agentName={agentName}
        emphasised={empty}
        // The words go through the router; anything attached goes through `handoff.ts`, which says
        // why a photo cannot ride in history state.
        onCompose={(prompt, attachment) => {
          setHandoffAttachment(attachment ?? null)
          navigate('/assist/c', { state: { prompt } })
        }}
        // A **spoken** turn does not hand off — it is answered whole and read aloud, and the composer
        // says why it deliberately leaves this screen where it is. With the voice switched off
        // (`app/speech.ts`) that turn would answer into silence: the chat is created and a row
        // appears in the list, but the reply itself is nowhere on screen. Open it so it can be read.
        // Nothing to do when the panel speaks again, which is why this asks rather than assumes.
        // No `onSent`. Spoken turns now hand off through `onCompose` like typed ones (see `readAloud`
        // in the composer), so the chat opens the moment the mic closes rather than after the whole
        // reply has landed. With the voice on, a spoken turn is answered aloud and deliberately leaves
        // this screen where it is — and nothing reaches that path while the voice is off.
      />

      {confirming && selected.length > 0 && (
        <DeleteConfirm
          chats={selected}
          agentName={agentName}
          onCancel={() => setConfirming(false)}
          onConfirm={confirmDelete}
        />
      )}
    </ScreenShell>
  )
}

/**
 * The row for a chat that is still being written — see `pendingChat` for why one is needed.
 *
 * Shaped like a {@link ChatRow} and deliberately not one. A `ChatRow` is a conversation: it swipes to
 * archive, holds to select, and every one of those needs an id this chat does not have yet. What is
 * left is the part that matters here — the words, who is answering, and a way back in.
 *
 * The title is the member's own message, which is also what the chat will be called: the server names
 * an opening turn from its prompt (`AssistTitle.From`), so the row does not rename itself out from
 * under anybody when the real one arrives.
 */
function PendingChatRow({ agentName, title, preview, status, onOpen }: {
  agentName: string
  title: string
  preview: string
  status: string
  onOpen: () => void
}) {
  return (
    <div className="ml-chatrow__slot">
      <button type="button" className="ml-chatrow ml-chatrow--pending" onClick={onOpen}>
        <span className="ml-chatrow__main">
          <span className="ml-chatrow__title">{title}</span>
          <span className="ml-chatrow__preview">
            <span className="ml-chatrow__speaker">{`${agentName} — `}</span>
            {/* The reply so far, or what is holding it up. Never blank: a preview line that empties
                itself while a row is on screen reads as the chat losing its contents. */}
            {preview.trim() || 'Writing…'}
          </span>
        </span>
        <span className="ml-chatrow__aside">
          <span className="ml-chatrow__time">{status}</span>
        </span>
      </button>
    </div>
  )
}

/**
 * Nothing said yet (`1m`).
 *
 * One heading, one line of guidance, and a composer that goes brass to draw the eye. **No sample
 * prompts, no starter chips** — removed from the design deliberately, and the reason they are called
 * out here is that they are exactly what gets re-added by someone filling the space.
 *
 * Three situations, not one, because they are genuinely different and only one of them is "nothing
 * has happened here":
 *
 * - **Storing off.** The list is empty by policy rather than because nobody has talked to the agent,
 *   and the sentence has to say so or the household will keep waiting for chats to appear.
 * - **Everything archived.** Also not "no conversations yet" — there are conversations, they are
 *   just filed. The `ARCHIVED CHATS` row sits directly below this, so the copy points at it.
 * - **Genuinely new.** The original case.
 */
function AssistEmpty({ agentName, storing, archived }: {
  agentName: string
  storing: boolean
  archived: number
}) {
  if (!storing) {
    return (
      <div className="ml-assist__empty">
        <div className="serif ml-assist__emptytitle">Chats are not being kept</div>
        <p className="ml-assist__emptybody">
          {`You can talk to ${agentName}, but nothing is saved — the chat in front of you is all there is. Turn storing back on in Config › Privacy.`}
        </p>
      </div>
    )
  }

  if (archived > 0) {
    return (
      <div className="ml-assist__empty">
        <div className="serif ml-assist__emptytitle">Everything is archived</div>
        <p className="ml-assist__emptybody">
          {`Nothing active with ${agentName}. Your archived chats are below, and typing starts a new one.`}
        </p>
      </div>
    )
  }

  return (
    <div className="ml-assist__empty">
      <div className="serif ml-assist__emptytitle">No chats yet</div>
      <p className="ml-assist__emptybody">
        {`Type below or hold the mic to talk to ${agentName}. Everything you discuss is kept here as a chat you can return to.`}
      </p>
    </div>
  )
}

/** `MIC OFF` / `MIC LIVE` — the header's privacy affordance, in the design's letterspaced caps. */
function MicState() {
  const { supported, listening } = useVoice()
  return (
    <span className={'ml-assist__mic' + (listening ? ' ml-assist__mic--live' : '')}>
      {!supported ? 'No mic' : listening ? 'Mic live' : 'Mic off'}
    </span>
  )
}
