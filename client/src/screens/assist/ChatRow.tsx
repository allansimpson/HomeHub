import { useCallback } from 'react'
import { Icon } from '../../icons/Icon'
import type { Conversation } from '../../api/types'
import { conversationTime, shortDate } from './assistTime'
import { useRowGesture } from './useRowGesture'
import type { SwipeAction } from './useRowGesture'

interface Props {
  chat: Conversation
  onOpen: (id: number) => void
  onArchive: (id: number) => void
  onTogglePin: (chat: Conversation) => void
  /**
   * Put this row into the selection, or take it out again.
   *
   * One handler for both entry points on purpose: a long press outside selection mode and a tap
   * inside it are the same request — "this one too" — and the screen decides whether that means
   * opening selection or extending it.
   */
  onSelectToggle: (id: number) => void
  /** Null when the screen is not in selection mode. */
  selected: boolean | null
}

/**
 * A conversation row (ASSIST.md · row anatomy, `1f`, `1g`).
 *
 * Unread follows the SMS convention rather than inventing one: the title goes semibold, the preview
 * brightens to the reading colour, the timestamp goes brass, and a count badge sits where a read row
 * shows nothing. A pinned row carries a `PINNED` marker in the badge's place — the two never collide
 * because a pinned row's badge would be the only thing competing for that corner.
 *
 * Three gestures, all of them from {@link useRowGesture}: swipe left archives, swipe right pins or
 * unpins, a long press enters selection. **Delete is never a swipe** — it is the one thing here that
 * cannot be undone, and it lives behind selection mode and a modal for exactly that reason.
 *
 * In selection mode the row stops being a way into the conversation and becomes a checkbox: gestures
 * are off, the tap toggles, and the preview line is replaced by `DATE · n MESSAGES`, because what
 * you need while picking things to delete is which conversation this is, not what was last said in it.
 */
export function ChatRow({ chat, onOpen, onArchive, onTogglePin, onSelectToggle, selected }: Props) {
  const selecting = selected !== null

  const swipe = useCallback(
    (action: SwipeAction) => {
      if (action === 'archive') onArchive(chat.id)
      else onTogglePin(chat)
    },
    [chat, onArchive, onTogglePin],
  )

  const gesture = useRowGesture({
    onSwipe: swipe,
    onHold: () => onSelectToggle(chat.id),
    disabled: selecting,
  })

  const { dx, revealed, armed } = gesture

  return (
    <div className="ml-chatrow__slot">
      {/* The panel the row is sliding off to reveal. Only ever one, and only while the row is
          actually off its mark — a resting row has no action showing. */}
      {revealed && (
        <div
          className={
            `ml-chatrow__panel ml-chatrow__panel--${revealed}` + (armed ? ' ml-chatrow__panel--armed' : '')
          }
          aria-hidden="true"
        >
          <Icon id={revealed === 'archive' ? 'ico-archive' : 'ico-pin'} size="1.25rem" />
          <span>{revealed === 'archive' ? 'Archive' : chat.pinned ? 'Unpin' : 'Pin'}</span>
        </div>
      )}

      <button
        type="button"
        className={
          'ml-chatrow'
          + (chat.unread ? ' ml-chatrow--unread' : '')
          + (dx !== 0 ? ' ml-chatrow--sliding' : '')
          // The inset applies to every row in selection mode, not just the ticked ones — see the
          // stylesheet for why the text must not move as rows are chosen.
          + (selecting ? ' ml-chatrow--selecting' : '')
          + (selected ? ' ml-chatrow--selected' : '')
        }
        // No transition while the finger is down — the row is meant to track it exactly. The spring
        // back to rest is a transition, and it is applied by `--sliding` coming *off*.
        style={dx === 0 ? undefined : { transform: `translateX(${dx}px)` }}
        onClick={() => (selecting ? onSelectToggle(chat.id) : onOpen(chat.id))}
        aria-pressed={selecting ? selected === true : undefined}
        {...gesture.handlers}
      >
        {selecting && (
          <span
            className={'ml-chatrow__check' + (selected ? ' ml-chatrow__check--on' : '')}
            aria-hidden="true"
          >
            {selected && <Icon id="ico-check" size="0.875rem" />}
          </span>
        )}

        <span className="ml-chatrow__main">
          <span className="ml-chatrow__title">{chat.title}</span>
          {selecting ? (
            <span className="ml-chatrow__meta">
              {`${shortDate(chat.lastAtUtc)} · ${chat.messageCount} ${chat.messageCount === 1 ? 'message' : 'messages'}`}
            </span>
          ) : (
            <span className="ml-chatrow__preview">
              {chat.speaker && <span className="ml-chatrow__speaker">{`${chat.speaker} — `}</span>}
              {chat.preview}
            </span>
          )}
        </span>

        <span className="ml-chatrow__aside">
          <span className="ml-chatrow__time">{conversationTime(chat.lastAtUtc)}</span>
          {chat.unread && chat.unreadCount > 0 ? (
            <span className="ml-chatrow__badge">
              {chat.unreadCount}
              <span className="ml-visually-hidden"> unread</span>
            </span>
          ) : chat.pinned ? (
            <span className="ml-chatrow__pinned">Pinned</span>
          ) : null}
        </span>
      </button>
    </div>
  )
}
