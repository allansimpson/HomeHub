import { describe, expect, it } from 'vitest'
import { classify, refusalFor, sizeLabel, MAX_IMAGE_BYTES } from './attachments'

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
