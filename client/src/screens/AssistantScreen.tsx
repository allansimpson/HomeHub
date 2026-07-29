import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { DrillInHeader, ScreenShell } from '../components'
import { Icon } from '../icons/Icon'
import { useVoice } from '../app/VoiceProvider'
import { useSession } from '../app/SessionProvider'
import { ATTENDANT_NAME } from '../app/attendant'
import { api, ApiError } from '../api/client'
import {
  type Conversation,
  type HistoryTurn,
  clearConversations,
  deleteConversation,
  exchangeCount,
  formatWhen,
  loadConversations,
  newConversationId,
  saveConversation,
} from '../app/assistantHistory'

const SUGGESTIONS = [
  "What's on tomorrow morning?",
  'Set the living room to 70.',
  "Add sunscreen to Theo's swim bag list.",
]

interface PendingImage {
  base64: string
  mediaType: string
  name: string
}

/**
 * The Attendant (THE_ATTENDANT.md — supersedes spec 09). Four states of one screen: Idle (no
 * history), With History (per-profile conversation list), Listening (push-to-talk), and Conversation
 * — the last with a brass Speaking sub-state while the on-device/Piper voice reads a reply. History
 * persists per profile in localStorage; voice turns are transcribed + routed through the assistant and
 * spoken back. Text + image upload remain available.
 */
export function AssistantScreen() {
  const { activeProfile, activeProfileId } = useSession()
  const { supported, listening, speaking, partial, startListening, stopListening, speak, stopSpeaking } = useVoice()

  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeConvoId, setActiveConvoId] = useState<string | null>(null)
  const [turns, setTurns] = useState<HistoryTurn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [image, setImage] = useState<PendingImage | null>(null)
  // History management (THE_ATTENDANT.md §5b/§5c): EDIT toggle → per-row trash → inline confirm; CLEAR ALL modal.
  const [manageMode, setManageMode] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const [clearAllOpen, setClearAllOpen] = useState(false)
  const startedAtRef = useRef<number | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Load this profile's history; leaving a conversation returns here.
  useEffect(() => {
    setConversations(loadConversations(activeProfileId))
    setActiveConvoId(null)
    setTurns([])
    setManageMode(false)
    setPendingDelete(null)
    setClearAllOpen(false)
  }, [activeProfileId])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  const send = useCallback(
    async (promptText: string, spoken = false) => {
      const prompt = promptText.trim()
      if ((!prompt && !image) || busy) return

      let convoId = activeConvoId
      if (!convoId) {
        convoId = newConversationId()
        startedAtRef.current = Date.now()
        setActiveConvoId(convoId)
      }
      const history = turns.map((t) => ({ role: t.role, text: t.text }))
      const userText = prompt || (image ? `[Image: ${image.name}]` : '')
      const baseTurns: HistoryTurn[] = [...turns, { role: 'user', text: userText }]
      setTurns(baseTurns)
      setInput('')
      const pendingImage = image
      setImage(null)
      setBusy(true)

      let reply: HistoryTurn
      try {
        const res = await api.askAssistant({
          history,
          prompt,
          imageBase64: pendingImage?.base64 ?? null,
          imageMediaType: pendingImage?.mediaType ?? null,
          profileId: activeProfileId ?? null,
        })
        reply = { role: 'assistant', text: res.text, origin: res.origin, escalated: res.escalated }
        // An in-app action (e.g. a task added) → refresh the affected screens without a reload.
        if (res.action) window.dispatchEvent(new Event('homehub:sync'))
        // Assistant chat is conversational — Warm.
        if (spoken) speak(res.text, 'warm')
      } catch (err) {
        if (!(err instanceof ApiError)) {
          setBusy(false)
          throw err
        }
        reply = { role: 'assistant', text: 'The assistant is unreachable right now. Please try again.', origin: 'Local' }
      }

      const finalTurns = [...baseTurns, reply]
      setTurns(finalTurns)
      const title = (baseTurns.find((t) => t.role === 'user')?.text || userText).trim()
      setConversations(
        saveConversation(activeProfileId, {
          id: convoId,
          title,
          startedAt: startedAtRef.current ?? Date.now(),
          lastAt: Date.now(),
          turns: finalTurns,
        }),
      )
      setBusy(false)
    },
    [turns, image, busy, speak, activeConvoId, activeProfileId],
  )

  const beginVoice = useCallback(() => {
    if (speaking) stopSpeaking() // barge-in
    if (supported) startListening((text) => send(text, true))
    else inputRef.current?.focus()
  }, [speaking, stopSpeaking, supported, startListening, send])

  const startNewChat = useCallback(() => {
    startedAtRef.current = Date.now()
    setActiveConvoId(newConversationId())
    setTurns([])
    setInput('')
  }, [])

  const openConversation = useCallback((convo: Conversation) => {
    startedAtRef.current = convo.startedAt
    setActiveConvoId(convo.id)
    setTurns(convo.turns)
  }, [])

  const removeConversation = useCallback((id: string) => {
    const next = deleteConversation(activeProfileId, id)
    setConversations(next)
    setPendingDelete(null)
    if (next.length === 0) setManageMode(false) // nothing left to manage → back to Idle
  }, [activeProfileId])

  const clearAll = useCallback(() => {
    clearConversations(activeProfileId)
    setConversations([])
    setClearAllOpen(false)
    setManageMode(false)
  }, [activeProfileId])

  // ASSIST has no back button (spec §0) — re-tapping the nav tab re-enters the screen, which routes
  // back to `conversations.length ? History : Idle`. Each tap yields a fresh location key.
  const { key: navKey } = useLocation()
  useEffect(() => {
    setActiveConvoId(null)
    setTurns([])
  }, [navKey])

  const onPickImage = useCallback((file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const comma = url.indexOf(',')
      const meta = url.slice(5, url.indexOf(';'))
      setImage({ base64: url.slice(comma + 1), mediaType: meta || 'image/jpeg', name: file.name })
    }
    reader.readAsDataURL(file)
  }, [])

  const inChat = activeConvoId !== null
  const userLabel = activeProfile?.name ?? 'You'
  const hasContent = input.trim().length > 0 || !!image
  const inHistory = !inChat && !listening && conversations.length > 0

  const headerStatus = manageMode && inHistory ? (
    <button type="button" className="ml-managedone" onClick={() => { setManageMode(false); setPendingDelete(null) }}>
      Done
    </button>
  ) : speaking ? (
    <span className="ml-speaking-status">
      <span className="ml-speaking-status__sq" aria-hidden="true" />
      Speaking
    </span>
  ) : listening ? undefined : (
    'Mic off'
  )

  return (
    <ScreenShell
      avatar={!listening}
      header={
        <DrillInHeader title="THE ATTENDANT" status={headerStatus} />
      }
    >
      <div className="ml-assistant">
        <div className="ml-assistant__scroll" ref={scrollRef}>
          {listening ? (
            <ListeningView partial={partial} onStop={stopListening} />
          ) : inChat ? (
            <div className="ml-transcript">
              {turns.map((t, i) => (
                <div key={i} className={'ml-turn ml-turn--' + t.role}>
                  <div className="ml-turn__label">
                    {t.role === 'user' ? userLabel : ATTENDANT_NAME}
                    {t.role === 'assistant' && t.origin && (
                      <span className={'ml-origin ml-origin--' + t.origin.toLowerCase()}>
                        {t.escalated ? `${t.origin} ↑` : t.origin}
                      </span>
                    )}
                  </div>
                  <div className="ml-turn__text">{t.text}</div>
                </div>
              ))}
              {busy && (
                <div className="ml-turn ml-turn--assistant">
                  <div className="ml-turn__text ml-turn__thinking">Thinking…</div>
                </div>
              )}
              {speaking && !busy && <SpeakingIndicator onStop={stopSpeaking} />}
            </div>
          ) : conversations.length > 0 ? (
            <div className="ml-history">
              <div className="ml-conversations">
                <span className="ml-section__label">Conversations</span>
                {manageMode ? (
                  <span className="ml-history__hint">Tap to delete</span>
                ) : (
                  <span className="ml-conversations__actions">
                    <button type="button" className="ml-history__edit" onClick={() => setManageMode(true)}>Edit</button>
                    <button type="button" className="ml-newchat" onClick={startNewChat}>＋ New Chat</button>
                  </span>
                )}
              </div>
              {conversations.map((c) => {
                const n = exchangeCount(c.turns)
                const meta = (
                  <span className="ml-history__meta">
                    <span>{formatWhen(c.lastAt)}</span>
                    <span className="ml-history__dot" aria-hidden="true" />
                    <span>{n === 1 ? '1 exchange' : `${n} exchanges`}</span>
                  </span>
                )
                if (manageMode && pendingDelete === c.id) {
                  return (
                    <div key={c.id} className="ml-history__confirmwrap">
                      <div className="ml-history__confirm">
                        <span className="ml-history__confirmtext">
                          Delete <span className="ml-history__confirmtitle">“{c.title}”</span>?
                        </span>
                        <span className="ml-history__confirmbtns">
                          <button type="button" className="ml-confirmbtn" onClick={() => setPendingDelete(null)}>Cancel</button>
                          <button type="button" className="ml-confirmbtn ml-confirmbtn--danger" onClick={() => removeConversation(c.id)}>Delete</button>
                        </span>
                      </div>
                    </div>
                  )
                }
                if (manageMode) {
                  return (
                    <div key={c.id} className="ml-history__row ml-history__row--manage">
                      <span className="ml-history__main">
                        <span className="ml-history__title">{c.title}</span>
                        {meta}
                      </span>
                      <button type="button" className="ml-history__trash" onClick={() => setPendingDelete(c.id)} aria-label={`Delete “${c.title}”`}>
                        <Icon id="ico-trash" size="1.25rem" />
                      </button>
                    </div>
                  )
                }
                return (
                  <button key={c.id} type="button" className="ml-history__row" onClick={() => openConversation(c)}>
                    <span className="ml-history__main">
                      <span className="ml-history__title">{c.title}</span>
                      {meta}
                    </span>
                    <span className="ml-history__chev" aria-hidden="true">▸</span>
                  </button>
                )
              })}
            </div>
          ) : (
            <div className="ml-assistant__idle">
              <button type="button" className="ml-emblem" onClick={beginVoice} aria-label={supported ? 'Tap to speak' : 'Tap to type'}>
                <span className="ml-emblem__ring">
                  <span className="ml-emblem__core">
                    <Icon id="ico-assist" size="2.375rem" />
                    <span className="ml-emblem__label">{supported ? 'Tap to Speak' : 'Tap to Type'}</span>
                  </span>
                </span>
              </button>
              <div className="ml-emblem__caption">Microphone stays off until tapped</div>

              <div className="ml-section">
                <span className="ml-section__label">Try Asking</span>
              </div>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="ml-row ml-row--tappable ml-suggestion" onClick={() => send(s)}>
                  <span className="ml-row__title" style={{ whiteSpace: 'normal' }}>{`"${s}"`}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {manageMode && inHistory ? (
          <div className="ml-assistant__managefoot">
            <span className="ml-assistant__managecount label">
              {conversations.length} {conversations.length === 1 ? 'conversation' : 'conversations'}
            </span>
            <button type="button" className="ml-clearall" onClick={() => setClearAllOpen(true)}>
              <Icon id="ico-trash" size="1rem" />
              <span>Clear All</span>
            </button>
          </div>
        ) : !listening ? (
          <div className="ml-assistant__inputbar">
            {image && <div className="ml-assistant__attached">📎 {image.name}</div>}
            <div className="ml-assistant__inputrow">
              <label className="ml-assistant__attach" aria-label="Attach an image">
                <Icon id="ico-add" size="1.25rem" />
                <input type="file" accept="image/*" hidden onChange={(e) => onPickImage(e.target.files?.[0])} />
              </label>
              <span className="ml-assistant__field">
                <input
                  ref={inputRef}
                  className="ml-assistant__input"
                  value={input}
                  placeholder="Ask anything…"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && send(input)}
                />
              </span>
              {hasContent ? (
                <button
                  type="button"
                  className="ml-assistant__mic ml-assistant__mic--send"
                  onClick={() => send(input)}
                  disabled={busy}
                  aria-label="Send"
                >
                  <span className="ml-assistant__sendglyph" aria-hidden="true">→</span>
                </button>
              ) : (
                <button type="button" className="ml-assistant__mic" onClick={beginVoice} aria-label={supported ? 'Speak' : 'Type'}>
                  <Icon id="ico-assist" size="1.625rem" />
                </button>
              )}
            </div>
          </div>
        ) : null}
      </div>

      {clearAllOpen && (
        <div className="ml-modal" role="dialog" aria-modal="true">
          <button type="button" className="ml-modal__scrim" aria-label="Cancel" onClick={() => setClearAllOpen(false)} />
          <div className="ml-modal__dialog">
            <div className="ml-modal__title">
              <Icon id="ico-trash" size="1.5rem" />
              <span className="serif">Clear all conversations?</span>
            </div>
            <p className="ml-modal__body">
              This permanently removes all <span className="ml-modal__count">{conversations.length}</span>{' '}
              conversation{conversations.length === 1 ? '' : 's'} for {userLabel} from the panel. It can’t be undone.
            </p>
            <div className="ml-modal__btns">
              <button type="button" className="ml-confirmbtn" onClick={() => setClearAllOpen(false)}>Cancel</button>
              <button type="button" className="ml-confirmbtn ml-confirmbtn--danger" onClick={clearAll}>Clear All</button>
            </div>
          </div>
        </div>
      )}
    </ScreenShell>
  )
}

/** Listening state (THE_ATTENDANT.md · 3): live partial transcript, waveform, square stop control. */
function ListeningView({ partial, onStop }: { partial: string; onStop: () => void }) {
  return (
    <div className="ml-listening">
      <div className="ml-listening__hearing">Hearing…</div>
      <div className="ml-listening__partial">{partial || '…'}</div>

      <div className="ml-waveform" aria-hidden="true">
        {[12, 26, 36, 20, 30, 14, 24].map((h, i) => (
          <span key={i} className="ml-waveform__bar" style={{ ['--h' as string]: `${h}px`, animationDelay: `${i * 90}ms` }} />
        ))}
      </div>

      <button type="button" className="ml-emblem ml-emblem--listening" onClick={onStop} aria-label="Tap to stop">
        <span className="ml-emblem__ring">
          <span className="ml-emblem__core">
            <span className="ml-listening__stopglyph" aria-hidden="true" />
            <span className="ml-emblem__label">Tap to Stop</span>
          </span>
        </span>
      </button>
      <div className="ml-emblem__caption">Stops by itself after 5 seconds of quiet</div>
    </div>
  )
}

/** Speaking sub-state (THE_ATTENDANT.md · 4): brass 5-bar wave + label + stop chip while Piper/TTS plays. */
function SpeakingIndicator({ onStop }: { onStop: () => void }) {
  return (
    <div className="ml-speaking">
      <div className="ml-speaking__wave" aria-hidden="true">
        {[8, 15, 11, 16, 7].map((h, i) => (
          <span key={i} className="ml-speaking__bar" style={{ ['--h' as string]: `${h}px`, animationDelay: `${i * 90}ms` }} />
        ))}
      </div>
      <span className="ml-speaking__label">Speaking</span>
      <button type="button" className="ml-speaking__stop" onClick={onStop}>
        Tap to Stop
      </button>
    </div>
  )
}
