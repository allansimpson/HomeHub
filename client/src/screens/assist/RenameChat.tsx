import { useEffect, useRef, useState } from 'react'

interface Props {
  /** The name as it stands. The field opens holding it, selected. */
  title: string
  onCancel: () => void
  onConfirm: (title: string) => Promise<void>
}

/** Matches `AssistFieldLimits.Title`. A row is one line; this is far past where it ellipses. */
const MAX = 200

/**
 * Rename a chat.
 *
 * **Why this exists at all.** A chat is named twice before anybody sees it: once from the opening
 * turn, and once by the agent a second later. Both are guesses, and the second one is a guess made by
 * something that read half the conversation. A list the household cannot correct is a list they stop
 * trusting, and the correction has to be one tap from the thing being corrected — which is why the
 * way in is the title in the header rather than a menu.
 *
 * A dialog rather than an inline field in the header. The header is 88px short on its right for the
 * account avatar and holds the back control on its left, so an editable title there would be a text
 * field about a third of the screen wide with a live transcript scrolling underneath it. The panel's
 * on-screen keyboard also takes the bottom half of the screen the moment the field is focused, which
 * a header cannot account for and a centred dialog does not have to.
 *
 * Nothing here is destructive and nothing is lost: cancelling keeps the old name, and the old name
 * itself was never anything the household typed.
 */
export function RenameChat({ title, onCancel, onConfirm }: Props) {
  const [text, setText] = useState(title)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // Open with the whole name selected. The common case is replacing it outright — the name being
  // corrected is one nobody chose — and making that the zero-effort path costs the other case one tap
  // at the end of the field.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(0, el.value.length)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const trimmed = text.trim()
  const unchanged = trimmed === title.trim()

  const save = () => {
    if (!trimmed || unchanged || saving) return
    setSaving(true)
    void onConfirm(trimmed)
  }

  return (
    <div className="ml-modal" role="dialog" aria-modal="true" aria-label="Rename this chat">
      <button type="button" className="ml-modal__scrim" onClick={onCancel} aria-label="Cancel" />

      <div className="ml-modal__dialog">
        <div className="ml-modal__title">
          <span className="serif">Rename this chat</span>
        </div>

        <input
          ref={inputRef}
          className="ml-rename__field"
          value={text}
          maxLength={MAX}
          placeholder="What is this chat about?"
          aria-label="Chat name"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') save() }}
        />

        {/* Said once, plainly. Otherwise the first thing anyone wonders is whether the name they just
            typed is about to be replaced by the agent's — which is exactly what it stops. */}
        <p className="ml-modal__body">
          A name you give a chat is kept. Assist will not rename it again.
        </p>

        <div className="ml-modal__btns">
          <button type="button" className="ml-confirmbtn" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
          <button
            type="button"
            className="ml-confirmbtn ml-confirmbtn--go"
            onClick={save}
            disabled={saving || !trimmed || unchanged}
          >
            {saving ? 'Saving…' : 'Rename'}
          </button>
        </div>
      </div>
    </div>
  )
}
