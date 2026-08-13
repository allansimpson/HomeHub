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
  /**
   * When the camera was pointed at it — EXIF `DateTimeOriginal` as an ISO instant, or null.
   *
   * <b>Null is ordinary rather than missing.</b> A screenshot of a text message carries no EXIF, and
   * a screenshot of a text message is one of the three things this feature was asked to read. That
   * case shows ADDED rather than TAKEN on the event's source block; it never falls back to the file's
   * modification time, which records when a phone wrote a file and not when anybody photographed
   * anything.
   */
  takenAt: string | null
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
    return { kind: 'text', name: file.name, bytes: file.size, base64: null, mediaType: null, text, preview: null, takenAt: null }
  }

  // Before the downscale, and that ordering is the whole point: `downscale` redraws the picture
  // through a canvas, and a canvas re-encode keeps the pixels and throws the metadata away. Read
  // after it and every photograph in the house looks like a screenshot.
  const takenAt = await exifTakenAt(file)

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
    takenAt,
  }
}

/** How far into a file the EXIF block is looked for. APP1 is the first segment in practice. */
const EXIF_SCAN_BYTES = 256 * 1024

/**
 * When the photograph was taken, as an ISO instant — or null when the file does not say.
 *
 * <b>Hand-parsed, and deliberately so.</b> One tag out of one segment is not worth a dependency on
 * a metadata library, and the failure mode of getting this wrong is mild in exactly the right
 * direction: anything unreadable returns null, which is the same answer a screenshot gives, and the
 * event's source block already has a sentence for that.
 *
 * The stamp EXIF carries has no timezone in it — it is the wall clock of wherever the camera was.
 * It is read as this device's local time, which is the closest thing to a household zone that
 * exists here, and is right for the case that actually happens: a photograph taken in the kitchen
 * and confirmed on the panel in the hall.
 */
export async function exifTakenAt(file: File): Promise<string | null> {
  try {
    const head = new DataView(await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer())
    if (head.byteLength < 4 || head.getUint16(0) !== 0xffd8) return null // Not a JPEG. PNGs and WebPs off a phone carry no capture date worth trusting.

    // Walk the segment chain to APP1. Every segment states its own length, so this is a series of
    // hops rather than a search for a byte pattern that could occur inside the image data.
    let offset = 2
    while (offset + 4 <= head.byteLength) {
      if (head.getUint8(offset) !== 0xff) return null
      const marker = head.getUint8(offset + 1)
      if (marker === 0xda || marker === 0xd9) return null // Start of scan: the pixels begin, the metadata is behind us.
      const length = head.getUint16(offset + 2)
      if (length < 2) return null
      if (marker === 0xe1) {
        const stamp = readExifDate(head, offset + 4, Math.min(offset + 2 + length, head.byteLength))
        if (stamp) return stamp
      }
      offset += 2 + length
    }
    return null
  } catch {
    // A file that cannot be sliced or read is not a reason to refuse the attachment — the picture
    // itself is still perfectly sendable, and this is only ever a label on a screen.
    return null
  }
}

/** EXIF tag numbers. `DateTimeOriginal` is when the shutter fired; `DateTime` is when it was last written. */
const TAG_DATE_TIME_ORIGINAL = 0x9003
const TAG_DATE_TIME = 0x0132
const TAG_EXIF_IFD_POINTER = 0x8769

/** The date out of one APP1 segment, or null if it is not an EXIF segment or carries no date. */
function readExifDate(view: DataView, start: number, end: number): string | null {
  // "Exif\0\0" — an APP1 that says anything else is XMP, which this does not read.
  const header = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]
  if (start + header.length + 8 > end) return null
  for (let i = 0; i < header.length; i++) if (view.getUint8(start + i) !== header[i]) return null

  const tiff = start + header.length
  const endian = view.getUint16(tiff)
  if (endian !== 0x4949 && endian !== 0x4d4d) return null
  const little = endian === 0x4949
  if (view.getUint16(tiff + 2, little) !== 0x002a) return null

  const ifd0 = tiff + view.getUint32(tiff + 4, little)
  // `DateTimeOriginal` lives in the Exif sub-IFD, which IFD0 only points at. IFD0's own `DateTime`
  // is the fallback: less precisely "when it was taken", but far better than nothing.
  const exifIfd = findTag(view, ifd0, end, little, TAG_EXIF_IFD_POINTER)
  const stamp =
    (exifIfd !== null ? readAscii(view, tiff + exifIfd, end, TAG_DATE_TIME_ORIGINAL, tiff, little) : null)
    ?? readAscii(view, ifd0, end, TAG_DATE_TIME, tiff, little)
  return stamp ? parseExifStamp(stamp) : null
}

/** One IFD entry's value as an unsigned long, or null when the tag is not in this directory. */
function findTag(view: DataView, ifd: number, end: number, little: boolean, tag: number): number | null {
  if (ifd + 2 > end) return null
  const count = view.getUint16(ifd, little)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return null
    if (view.getUint16(entry, little) === tag) return view.getUint32(entry + 8, little)
  }
  return null
}

/** An ASCII tag's text, trimmed of its trailing NUL. Null when absent or malformed. */
function readAscii(view: DataView, ifd: number, end: number, tag: number, tiff: number, little: boolean): string | null {
  if (ifd + 2 > end) return null
  const count = view.getUint16(ifd, little)
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12
    if (entry + 12 > end) return null
    if (view.getUint16(entry, little) !== tag) continue

    const length = view.getUint32(entry + 4, little)
    // A stamp is "YYYY:MM:DD HH:MM:SS\0" — 20 bytes, so it never fits inline and is always a pointer.
    if (length < 19 || length > 32) return null
    const at = tiff + view.getUint32(entry + 8, little)
    if (at + length > end) return null

    let text = ''
    for (let c = 0; c < length; c++) {
      const byte = view.getUint8(at + c)
      if (byte === 0) break
      text += String.fromCharCode(byte)
    }
    return text
  }
  return null
}

/**
 * `YYYY:MM:DD HH:MM:SS` as an ISO instant, read in this device's zone.
 *
 * Rejects the all-zero stamp some cameras write when their clock has never been set — `0000:00:00
 * 00:00:00` is a camera saying it does not know, and passing it on as a date would put a photograph
 * in the first century.
 */
function parseExifStamp(raw: string): string | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s] = m.map(Number)
  if (!y || !mo || !d) return null
  const when = new Date(y, mo - 1, d, h, mi, s)
  return Number.isNaN(when.getTime()) ? null : when.toISOString()
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
    /*
     * `from-image`, stated rather than assumed.
     *
     * A phone held sideways writes its pixels in the sensor's orientation and an EXIF tag saying
     * which way up they go, and whether `createImageBitmap` honours that tag by default has changed
     * underneath this API: the option was specified as `none` originally and later respecified as
     * `from-image`, so the answer depends on the browser and its version. That is precisely the kind
     * of thing not to leave to a default — the failure is a flyer rotated 90°, which reads badly to
     * a vision model and is then *stored* that way, so one ambiguity costs both the reading and the
     * picture somebody goes back to check.
     *
     * Naming it costs nothing and removes the question. The canvas below re-encodes from this
     * bitmap, so an upright bitmap is an upright JPEG — which is also what makes the rotation
     * permanent rather than dependent on the next viewer reading EXIF too.
     */
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
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
