/**
 * Timestamps for the Assist inbox.
 *
 * The design's rows read `JUST NOW`, `8:04 AM`, `YESTERDAY`, `TUE`, `JUL 28` — the *coarsest* form
 * that still identifies the moment, which is how a chat list stays scannable. A row that said
 * "Jul 28 · 4:12 PM" would be more precise and less useful: nobody scanning an inbox is comparing
 * minutes on a chat from last month.
 *
 * Replaces `formatWhen` from `assistantHistory.ts`, which produced `Today · 8:04 AM` for a footer
 * line with room for it. This is the same idea at inbox width.
 */

const startOfDay = (t: number): number => {
  const d = new Date(t)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** How a conversation row stamps its last message. */
export function conversationTime(iso: string, now: number = Date.now()): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''

  if (now - ts < 90_000) return 'Just now'

  const d = new Date(ts)
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000)

  if (days === 0) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  // Inside the last week the weekday is the fastest read; past that it stops being unambiguous.
  if (days < 7) return d.toLocaleDateString('en-US', { weekday: 'short' })
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/**
 * A plain calendar date — `JUL 30`.
 *
 * Two rows want this rather than {@link conversationTime}: the archive's `ARCHIVED JUL 30`, and a
 * row in selection mode, whose subtitle becomes `JUL 30 · 12 MESSAGES`. Both are being read rather
 * than scanned, and both are answering "which conversation is this", where `TUE` is no help at all.
 */
export function shortDate(iso: string | null): string {
  if (!iso) return ''
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** A transcript turn's time. Full precision here — you are reading, not scanning. */
export function turnTime(iso: string): string {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return ''
  return new Date(ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
}
