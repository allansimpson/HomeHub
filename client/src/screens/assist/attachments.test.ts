import { describe, expect, it } from 'vitest'
import { classify, exifTakenAt, refusalFor, sizeLabel, MAX_IMAGE_BYTES } from './attachments'

/**
 * What the panel will and will not carry.
 *
 * The reading itself needs a browser; this is the judgement, which does not — and the judgement is
 * the half that can be wrong silently. A `.docx` accepted as text produces pages of mojibake in the
 * agent's context and no error anywhere.
 */

const file = (name: string, type = '', size = 1024) => ({ name, type, size })

describe('classify', () => {
  it('takes anything the device calls an image', () => {
    expect(classify(file('IMG_4417.heic', 'image/heic'))).toBe('image')
    expect(classify(file('scan.png', 'image/png'))).toBe('image')
  })

  it('takes the text formats it names', () => {
    for (const name of ['notes.txt', 'README.md', 'shopping.csv', 'data.json', 'error.log', 'stack.yaml']) {
      expect(classify(file(name))).toBe('text')
    }
  })

  it('is case-insensitive about the extension', () => {
    expect(classify(file('NOTES.TXT'))).toBe('text')
  })

  /*
   * The one this list exists for. A .docx is a zip — its first bytes pass a naive "does this look
   * like text" check, and what reaches the agent is unreadable.
   */
  it('refuses office and archive formats that only look like text', () => {
    for (const name of ['letter.docx', 'books.xlsx', 'deck.pptx', 'photos.zip']) {
      expect(classify(file(name))).toBeNull()
    }
  })

  it('refuses a PDF, which is neither', () => {
    expect(classify(file('invoice.pdf', 'application/pdf'))).toBeNull()
  })

  it('refuses a file it cannot identify at all', () => {
    expect(classify(file('receipt'))).toBeNull()
    expect(classify(file('firmware.bin', 'application/octet-stream'))).toBeNull()
  })

  it('trusts a text media type only when there is no extension to disagree with', () => {
    expect(classify(file('page', 'text/plain'))).toBe('text')
    // The extension wins: a device reporting text/xml for a .docx does not make it readable.
    expect(classify(file('letter.docx', 'text/xml'))).toBeNull()
  })
})

describe('refusalFor', () => {
  it('says nothing about a file it will take', () => {
    expect(refusalFor(file('notes.md'))).toBeNull()
    expect(refusalFor(file('IMG_1.jpg', 'image/jpeg', 4 * 1024 * 1024))).toBeNull()
  })

  /* The message has to say what *will* work. "Unsupported file type" helps nobody holding a receipt. */
  it('points a PDF at the thing that does work', () => {
    expect(refusalFor(file('invoice.pdf', 'application/pdf'))).toMatch(/photo of the page/i)
  })

  it('names the sizes when a picture is too big', () => {
    const refusal = refusalFor(file('huge.png', 'image/png', MAX_IMAGE_BYTES + 1))
    expect(refusal).toMatch(/10\.0 MB/)
  })

  it('does not size-limit a text file — those are truncated instead', () => {
    expect(refusalFor(file('enormous.log', '', 50 * 1024 * 1024))).toBeNull()
  })
})

describe('sizeLabel', () => {
  it('reads the way the meta line needs it to', () => {
    expect(sizeLabel(512)).toBe('512 B')
    expect(sizeLabel(2048)).toBe('2 KB')
    expect(sizeLabel(1_887_437)).toBe('1.8 MB')
  })
})

/**
 * The capture date, and the one ordering that matters about it.
 *
 * Hand-assembled rather than fixture files: the parser walks segment lengths and IFD offsets, and a
 * builder that writes those offsets out longhand is the only way to be sure the test is exercising
 * the arithmetic rather than agreeing with it. The screenshot case is the one that has to keep
 * working — it is a third of the inputs this feature was asked for, and it carries no EXIF at all.
 */
describe('exifTakenAt', () => {
  /** A JPEG carrying nothing but an APP1 block with `DateTimeOriginal` in it. */
  function jpegWithExif(stamp: string): File {
    const tiff = new Uint8Array(44 + 20)
    const view = new DataView(tiff.buffer)
    const LITTLE = true

    view.setUint16(0, 0x4949, LITTLE) // "II" — little-endian
    view.setUint16(2, 0x002a, LITTLE)
    view.setUint32(4, 8, LITTLE) // IFD0 begins immediately after the header

    view.setUint16(8, 1, LITTLE) // IFD0: one entry, the pointer to the Exif sub-IFD
    view.setUint16(10, 0x8769, LITTLE)
    view.setUint16(12, 4, LITTLE) // LONG
    view.setUint32(14, 1, LITTLE)
    view.setUint32(18, 26, LITTLE)
    view.setUint32(22, 0, LITTLE) // no IFD1

    view.setUint16(26, 1, LITTLE) // Exif IFD: one entry, the stamp
    view.setUint16(28, 0x9003, LITTLE)
    view.setUint16(30, 2, LITTLE) // ASCII
    view.setUint32(32, 20, LITTLE)
    view.setUint32(36, 44, LITTLE) // 20 bytes never fit inline, so this is always a pointer
    view.setUint32(40, 0, LITTLE)

    for (let i = 0; i < stamp.length; i++) tiff[44 + i] = stamp.charCodeAt(i)

    const header = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]) // "Exif\0\0"
    const app1 = new Uint8Array(4 + header.length + tiff.length)
    app1.set([0xff, 0xe1], 0)
    new DataView(app1.buffer).setUint16(2, 2 + header.length + tiff.length) // big-endian, as JPEG lengths are
    app1.set(header, 4)
    app1.set(tiff, 4 + header.length)

    return new File([new Uint8Array([0xff, 0xd8]), app1], 'IMG_4417.jpg', { type: 'image/jpeg' })
  }

  it('reads DateTimeOriginal as this device’s local time', async () => {
    const taken = await exifTakenAt(jpegWithExif('2026:08:12 09:41:07\0'))
    expect(taken).toBe(new Date(2026, 7, 12, 9, 41, 7).toISOString())
  })

  it('says nothing for a screenshot, which carries no EXIF', async () => {
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'Screenshot.png', { type: 'image/png' })
    expect(await exifTakenAt(png)).toBeNull()
  })

  /*
   * A camera whose clock was never set writes this, and it means "I do not know" rather than "the
   * first century". Passing it on would date a photograph two thousand years ago and label the
   * event's source block with it.
   */
  it('rejects the all-zero stamp of an unset camera clock', async () => {
    expect(await exifTakenAt(jpegWithExif('0000:00:00 00:00:00\0'))).toBeNull()
  })

  it('is not fooled by a JPEG whose APP1 is something other than EXIF', async () => {
    const xmp = new Uint8Array(4 + 8)
    xmp.set([0xff, 0xe1], 0)
    new DataView(xmp.buffer).setUint16(2, 10)
    xmp.set([0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x00], 4) // "http://" — an XMP packet
    const file = new File([new Uint8Array([0xff, 0xd8]), xmp], 'edited.jpg', { type: 'image/jpeg' })
    expect(await exifTakenAt(file)).toBeNull()
  })
})
