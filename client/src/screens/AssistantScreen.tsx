import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DrillInHeader, ScreenShell } from '../components'
import { Icon } from '../icons/Icon'
import { api, ApiError } from '../api/client'
import type { AssistantOriginName } from '../api/types'

const SUGGESTIONS = [
  "What's on tomorrow morning?",
  'Set the living room to 70.',
  'How many teaspoons in a tablespoon?',
]

interface Turn {
  role: 'user' | 'assistant'
  text: string
  origin?: AssistantOriginName
  escalated?: boolean
}

interface PendingImage {
  base64: string
  mediaType: string
  name: string
}

/**
 * The Attendant (spec 09): idle state (emblem + TRY ASKING) becomes a conversation transcript
 * once a turn exists. Each assistant turn shows a LOCAL / CLOUD tag from the hybrid router. Text
 * is the primary path; an image can be uploaded for analysis. The mic emblem is present but voice
 * is Stage 8 — tapping it focuses the text entry rather than opening the mic.
 */
export function AssistantScreen() {
  const navigate = useNavigate()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [image, setImage] = useState<PendingImage | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  const send = useCallback(
    async (promptText: string) => {
      const prompt = promptText.trim()
      if ((!prompt && !image) || busy) return
      const history = turns.map((t) => ({ role: t.role, text: t.text }))
      const userText = prompt || (image ? `[Image: ${image.name}]` : '')
      setTurns((cur) => [...cur, { role: 'user', text: userText }])
      setInput('')
      const pendingImage = image
      setImage(null)
      setBusy(true)
      try {
        const res = await api.askAssistant({
          history,
          prompt,
          imageBase64: pendingImage?.base64 ?? null,
          imageMediaType: pendingImage?.mediaType ?? null,
        })
        setTurns((cur) => [...cur, { role: 'assistant', text: res.text, origin: res.origin, escalated: res.escalated }])
      } catch (err) {
        if (err instanceof ApiError) {
          setTurns((cur) => [...cur, { role: 'assistant', text: 'The assistant is unreachable right now. Please try again.', origin: 'Local' }])
        } else throw err
      } finally {
        setBusy(false)
      }
    },
    [turns, image, busy],
  )

  const onPickImage = useCallback((file: File | undefined) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const comma = url.indexOf(',')
      const meta = url.slice(5, url.indexOf(';')) // after "data:"
      setImage({ base64: url.slice(comma + 1), mediaType: meta || 'image/jpeg', name: file.name })
    }
    reader.readAsDataURL(file)
  }, [])

  const idle = turns.length === 0

  return (
    <ScreenShell header={<DrillInHeader title="The Attendant" status="Mic off" onBack={() => navigate('/')} />}>
      <div className="ml-assistant">
        <div className="ml-assistant__scroll" ref={scrollRef}>
          {idle ? (
            <div className="ml-assistant__idle">
              <button type="button" className="ml-emblem" onClick={() => inputRef.current?.focus()} aria-label="Voice arrives in Stage 8; tap to type">
                <span className="ml-emblem__ring">
                  <span className="ml-emblem__core">
                    <Icon id="ico-assist" size="2.375rem" />
                    <span className="ml-emblem__label">Tap to Type</span>
                  </span>
                </span>
              </button>
              <div className="ml-emblem__caption">Microphone stays off until Stage 8</div>

              <div className="ml-section">
                <span className="ml-section__tick" aria-hidden="true" />
                <span className="ml-section__label">Try Asking</span>
              </div>
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="ml-row ml-row--tappable ml-suggestion" onClick={() => send(s)}>
                  <span className="ml-row__title" style={{ whiteSpace: 'normal' }}>{s}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="ml-transcript">
              {turns.map((t, i) => (
                <div key={i} className={'ml-turn ml-turn--' + t.role}>
                  <div className="ml-turn__label">
                    {t.role === 'user' ? 'You' : 'Central'}
                    {t.role === 'assistant' && t.origin && (
                      <span className={'ml-origin ml-origin--' + t.origin.toLowerCase()}>
                        {t.escalated ? `${t.origin} ↑` : t.origin}
                      </span>
                    )}
                  </div>
                  <div className="ml-turn__text">{t.text}</div>
                </div>
              ))}
              {busy && <div className="ml-turn ml-turn--assistant"><div className="ml-turn__text ml-turn__thinking">Thinking…</div></div>}
            </div>
          )}
        </div>

        <div className="ml-assistant__inputbar">
          {image && <div className="ml-assistant__attached">📎 {image.name}</div>}
          <div className="ml-assistant__inputrow">
            <label className="ml-assistant__imgbtn" aria-label="Attach an image">
              <Icon id="ico-add" size="1.25rem" />
              <input type="file" accept="image/*" hidden onChange={(e) => onPickImage(e.target.files?.[0])} />
            </label>
            <input
              ref={inputRef}
              className="ml-assistant__input"
              value={input}
              placeholder="Ask anything…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && send(input)}
            />
            <button type="button" className="ml-assistant__send" onClick={() => send(input)} disabled={busy || (!input.trim() && !image)}>
              Ask
            </button>
          </div>
        </div>
      </div>
    </ScreenShell>
  )
}
