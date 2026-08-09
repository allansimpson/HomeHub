import type { AttachmentDraft } from './attachments'

/**
 * The attachment on a turn started from the inbox, in transit to the chat screen.
 *
 * <b>Why this is not router state.</b> The prompt travels to `/assist/c` in the navigation's `state`,
 * which is the right place for a short string — but an attachment is up to ten megabytes of base64
 * and an object URL, and history state is neither large enough nor the right lifetime for either.
 * Firefox caps history state at about 640 KB, so a photo would not merely be inefficient there; it
 * would throw and take the navigation with it.
 *
 * So the words go through the router and the bytes go through here: one slot, written by the inbox
 * immediately before it navigates and read by the chat screen on the render that follows. It is
 * deliberately not a store — there is exactly one handoff in flight at a time, because there is
 * exactly one way to start a chat.
 */
let held: AttachmentDraft | null = null

/** Leave an attachment for the chat screen about to mount. */
export function setHandoffAttachment(attachment: AttachmentDraft | null): void {
  held = attachment
}

/**
 * Collect it — once.
 *
 * Clearing on read is what stops a second chat started later in the session inheriting the first
 * one's photo. The chat screen's handoff runs behind a ref that fires once per mount, but "once per
 * mount" is not "once ever", and an attachment that outlived its turn would eventually attach itself
 * to a message nobody meant it for.
 */
export function takeHandoffAttachment(): AttachmentDraft | null {
  const attachment = held
  held = null
  return attachment
}
