/**
 * What a household can hand to an agent, and what the panel does to it on the way.
 *
 * <b>Two kinds, because the far end takes two kinds.</b> A turn reaches Hermes as a list of content
 * parts, and a part is either text or an image — there is no file upload. So "attach a file" can only
 * mean a picture the model can look at or text it can read. A PDF is neither until something turns it
 * into one, and an attachment that uploads, appears to send and silently is not there would be worse
 * than one the panel declined in the first place.
 *
 * The judgement lives here rather than in the composer because it is the half that can be wrong in
 * ways nobody notices — a `.csv` classified as binary, a 12 MB photo accepted and then refused by the
 * server, a filename with no extension treated as unreadable. The component's job is to draw the
 * result.
 */

/** The largest picture the server will take. Matches `AssistFieldLimits.MaxImageBytes`. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** The most text the server will keep from a file. Matches `AssistFieldLimits.MaxAttachmentChars`. */
export const MAX_TEXT_CHARS = 10_000

/**
 * Longest edge, in pixels, a picture is reduced to before sending.
 *
 * <b>Not a quality decision — a latency one.</b> A modern phone photo is 4000px and several
 * megabytes, and every one of those bytes crosses the LAN twice (panel to HomeHub, HomeHub to the
 * gateway) before the household sees a single character of reply. 1600px is past the point where any
 * vision model gains from more, and it turns a six-second upload into an instant one.
 *
 * Skipped entirely when the browser cannot decode the format — see {@link readAttachment}.
 */
const MAX_IMAGE_EDGE = 1600

/** Above this, downscaling is worth the decode. Below it, the file is already small enough to send. */
const DOWNSCALE_ABOVE_BYTES = 512 * 1024

/**
 * Extensions the panel will read as text.
 *
 * <b>A list, not a guess.</b> Sniffing "does this look like text" gets `.docx` wrong — it is a zip,
 * and its first bytes are plausible enough to pass a naive check while producing pages of mojibake in
 * the agent's context. Naming the formats means the refusal is honest and the acceptance is certain.
 */
const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'yml', 'yaml', 'xml', 'ini', 'conf',
] as const

/** What the composer holds between picking a file and sending it. */
export interface AttachmentDraft {
  kind: 'image' | 'text'
  /** The file's own name, as the device reported it. */
  name: string
  /** The *original* file's size, which is what the meta line states — not the downscaled one. */
  bytes: number
  /** A picture, base64 without the data-URL prefix. Null for text. */
  base64: string | null
  /** The media type that goes with {@link base64}. */
  mediaType: string | null
  /** A text file's contents, already capped. Null for a picture. */
  text: string | null
  /** An object URL for the thumbnail, or null. The composer revokes this when the draft is dropped. */
  preview: string | null
}

/** Why a file was refused, in the household's terms rather than the format's. */
export class AttachmentRefused extends Error {}

/** The lowercase extension, or an empty string when the name has none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * What kind of thing this is, or null when it is neither.
 *
 * The MIME type is consulted first and the extension second, because a device that knows what it just
 * handed over is more reliable than a filename — but only for images, where `image/*` is
 * unambiguous. A `text/*` type is not enough on its own: browsers report `text/xml` for things nobody
 * wants pasted into a chat, and the extension list is the decision either way.
 */
export function classify(file: { name: string; type: string }): 'image' | 'text' | null {
  if (file.type.startsWith('image/')) return 'image'
  const ext = extensionOf(file.name)
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) return 'text'
  // Some devices report no type at all for a file picked from a cloud provider. The extension is
  // then the only evidence there is, and an unknown one is genuinely unknown.
  if (file.type.startsWith('text/') && ext === '') return 'text'
  return null
}

/**
 * A size, as the meta line says it.
 *
 * Whole kilobytes and one decimal of a megabyte: the figure is there so somebody can tell a snapshot
 * from a panorama, and `1.8 MB` does that while `1,887,436 bytes` does not.
 */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Why this file cannot be attached, or null if it can.
 *
 * Separate from the reading so the composer can refuse instantly, before any decoding — and so the
 * message says what to do instead. "Unsupported file type" tells somebody holding a receipt nothing;
 * "send a photo of the page" tells them exactly what will work.
 */
export function refusalFor(file: { name: string; type: string; size: number }): string | null {
  const kind = classify(file)
  if (kind === null) {
    return extensionOf(file.name) === 'pdf'
      ? 'PDFs cannot be read yet. A photo of the page works.'
      : 'That kind of file cannot be read. Pictures, and text files like .txt, .md or .csv, can.'
  }
  if (kind === 'image' && file.size > MAX_IMAGE_BYTES) {
    return `That picture is ${sizeLabel(file.size)} — the limit is ${sizeLabel(MAX_IMAGE_BYTES)}.`
  }
  return null
}

/**
 * Read a picked file into something sendable.
 *
 * Throws {@link AttachmentRefused} with a sentence worth showing for anything {@link refusalFor}
 * would have caught, so a caller that forgets to check still cannot send something the server will
 * reject.
 *
 * A text file that runs past the cap is **truncated, not refused** — the head of a log answers most
 * questions about it, and a household that attached one has better things to do than split it. The
 * agent is told the truncation happened rather than left to infer it from a sentence stopping
 * mid-word.
 */
export async function readAttachment(file: File): Promise<AttachmentDraft> {
  const refusal = refusalFor(file)
  if (refusal) throw new AttachmentRefused(refusal)

  if (classify(file) === 'text') {
    const whole = await file.text()
    const text = whole.length > MAX_TEXT_CHARS
      ? `${whole.slice(0, MAX_TEXT_CHARS)}\n\n[…truncated — the file is longer than this]`
      : whole
    return { kind: 'text', name: file.name, bytes: file.size, base64: null, mediaType: null, text, preview: null }
  }

  const reduced = await downscale(file)
  return {
    kind: 'image',
    name: file.name,
    // The original's size, deliberately. The meta line is telling somebody what they attached, not
    // what the panel decided to transmit.
    bytes: file.size,
    base64: reduced.base64,
    mediaType: reduced.mediaType,
    text: null,
    preview: URL.createObjectURL(file),
  }
}

/**
 * Shrink a picture, where the browser can.
 *
 * <b>Failure here is not failure.</b> HEIC is the case that matters — it is what an iPhone produces
 * by default, and no browser outside Safari can decode it — so `createImageBitmap` throwing is the
 * expected path for a large fraction of real attachments, not an error. The original bytes are sent
 * instead, which is why {@link MAX_IMAGE_BYTES} is generous enough to carry one.
 */
async function downscale(file: File): Promise<{ base64: string; mediaType: string }> {
  const original = async () => ({ base64: await base64Of(file), mediaType: file.type || 'image/jpeg' })

  // Already small. Decoding and re-encoding would cost a round of generation loss for nothing.
  if (file.size <= DOWNSCALE_ABOVE_BYTES) return original()

  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1) {
      bitmap.close()
      return original()
    }

    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close()
      return original()
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()

    // JPEG rather than the original type: this is a photograph being sent to a model, and PNG would
    // produce a file several times larger for a difference nothing downstream can use.
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
    return { base64: dataUrl.slice(dataUrl.indexOf(',') + 1), mediaType: 'image/jpeg' }
  } catch {
    // The format is one this browser cannot decode — HEIC, most often. Send what we were given.
    return original()
  }
}

/** A file's bytes as base64, without the data-URL prefix the server does not want. */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new AttachmentRefused('That file could not be read.'))
    reader.onload = () => {
      const result = String(reader.result ?? '')
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}
