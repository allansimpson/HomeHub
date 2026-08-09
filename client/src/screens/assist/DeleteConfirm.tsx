import { useState } from 'react'
import { Icon } from '../../icons/Icon'
import type { Conversation } from '../../api/types'

interface Props {
  chats: Conversation[]
  agentName: string
  onCancel: () => void
  onConfirm: () => Promise<void>
}

/** Past this many names the list stops being a reminder and starts being a wall of text. */
const NAMES_SHOWN = 3

/**
 * The delete confirm (ASSIST.md · `1g`, second frame).
 *
 * The only destructive act in Assist, and the only thing in the section behind a modal. Everything
 * else — archiving, pinning, unarchiving — is reversible by doing it again, which is why none of
 * them ask.
 *
 * The body says three things, and each one is there because leaving it out would make the modal a
 * formality: how many chats, that the transcripts leave **the agent's memory** as well as the
 * ledger, and that it cannot be undone. The second is the one people do not expect — deleting a chat
 * here is not tidying an inbox, it is making the agent forget.
 */
export function DeleteConfirm({ chats, agentName, onCancel, onConfirm }: Props) {
  const [deleting, setDeleting] = useState(false)

  const n = chats.length
  const messages = chats.reduce((sum, c) => sum + c.messageCount, 0)

  const names = chats.slice(0, NAMES_SHOWN).map((c) => c.title).join(' · ')
  const more = n > NAMES_SHOWN ? ` · and ${n - NAMES_SHOWN} more` : ''

  return (
    <div className="ml-modal" role="dialog" aria-modal="true" aria-label={`Delete ${n} chats`}>
      {/* Dismissing by the scrim is a cancel. A destructive modal must have an exit that is not the
          destructive button, and the scrim is the one people reach for first. */}
      <button type="button" className="ml-modal__scrim" onClick={onCancel} aria-label="Cancel" />

      <div className="ml-modal__dialog">
        <div className="ml-modal__title">
          <Icon id="ico-trash" size="1.125rem" />
          <span className="serif">{n === 1 ? 'Delete this chat?' : `Delete ${n} chats?`}</span>
        </div>

        <div className="ml-modal__subtitle">
          {`${names}${more} · ${messages} ${messages === 1 ? 'message' : 'messages'}`}
        </div>

        <p className="ml-modal__body">
          {`This removes ${n === 1 ? 'this chat' : `all ${n} chats`} from the ledger and from `}
          <span className="ml-modal__count">{`${agentName}'s memory`}</span>
          {'. It cannot be undone. Continue?'}
        </p>

        <div className="ml-modal__btns">
          <button type="button" className="ml-confirmbtn" onClick={onCancel} disabled={deleting}>
            Cancel
          </button>
          <button
            type="button"
            className="ml-confirmbtn ml-confirmbtn--danger"
            disabled={deleting}
            onClick={() => {
              // Guard the double-tap rather than the second delete: the ids are already gone from
              // the list optimistically, so a second call would delete nothing and report zero.
              setDeleting(true)
              void onConfirm()
            }}
          >
            {deleting ? 'Deleting…' : `Delete (${n})`}
          </button>
        </div>
      </div>
    </div>
  )
}
