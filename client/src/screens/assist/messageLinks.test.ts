import { describe, expect, it } from 'vitest'
import { segmentLinks } from './messageLinks'

/** The whole message survives the round trip — nothing dropped, nothing rewritten. */
const rebuilt = (text: string) => segmentLinks(text).map((s) => s.text).join('')

describe('segmentLinks', () => {
  it('leaves prose alone', () => {
    expect(segmentLinks('The bins go out on Tuesday.')).toEqual([
      { kind: 'text', text: 'The bins go out on Tuesday.' },
    ])
  })

  it('returns nothing for an empty message', () => {
    expect(segmentLinks('')).toEqual([])
  })

  it('finds a link with prose either side', () => {
    expect(segmentLinks('Try https://example.com/a today')).toEqual([
      { kind: 'text', text: 'Try ' },
      { kind: 'link', text: 'https://example.com/a', href: 'https://example.com/a' },
      { kind: 'text', text: ' today' },
    ])
  })

  it('gives a scheme-less www link one to navigate with', () => {
    const [link] = segmentLinks('www.example.com')
    expect(link).toEqual({ kind: 'link', text: 'www.example.com', href: 'https://www.example.com' })
  })

  it('leaves the full stop at the end of a sentence out of the link', () => {
    const segments = segmentLinks('It is at https://example.com/recipe.')
    expect(segments[1]).toEqual({
      kind: 'link', text: 'https://example.com/recipe', href: 'https://example.com/recipe',
    })
    expect(segments[2]).toEqual({ kind: 'text', text: '.' })
    expect(rebuilt('It is at https://example.com/recipe.')).toBe('It is at https://example.com/recipe.')
  })

  it('keeps a bracket the URL opened itself', () => {
    const url = 'https://en.wikipedia.org/wiki/Salt_(chemistry)'
    expect(segmentLinks(url)).toEqual([{ kind: 'link', text: url, href: url }])
  })

  it('drops a bracket that closed the aside around the link', () => {
    const segments = segmentLinks('(see https://example.com/x)')
    expect(segments[1]).toEqual({
      kind: 'link', text: 'https://example.com/x', href: 'https://example.com/x',
    })
    expect(segments[2]).toEqual({ kind: 'text', text: ')' })
  })

  it('finds every link in a message, not just the first', () => {
    const segments = segmentLinks('https://a.io and https://b.io')
    expect(segments.filter((s) => s.kind === 'link')).toHaveLength(2)
  })

  it('links a mailto address', () => {
    const [link] = segmentLinks('mailto:someone@example.com')
    expect(link).toEqual({
      kind: 'link', text: 'mailto:someone@example.com', href: 'mailto:someone@example.com',
    })
  })

  it('does not link a bare word that merely looks domain-ish', () => {
    expect(segmentLinks('open config.json')).toEqual([{ kind: 'text', text: 'open config.json' }])
  })

  it('preserves the message exactly, however it was split', () => {
    const messages = [
      'Try https://example.com/a today',
      '(see https://example.com/x), then www.b.io.',
      'no links here at all',
      'https://example.com/path?q=1&r=2#frag',
      'trailing www. and nothing else',
    ]
    for (const message of messages) expect(rebuilt(message)).toBe(message)
  })

  it('reads the same message the same way twice', () => {
    const message = 'Try https://example.com/a today'
    expect(segmentLinks(message)).toEqual(segmentLinks(message))
  })
})
