/**
 * Finding the links in a turn's text.
 *
 * Kept apart from the component that draws them because this is the half that can be wrong in ways
 * nobody notices: a pattern that swallows the full stop at the end of a sentence produces a link
 * that 404s, and one that misses the closing bracket of a Wikipedia URL produces a link to the wrong
 * article. Both render perfectly. A pure function is the only place those cases can be pinned down.
 */

/** One run of a message: either prose, or something worth making tappable. */
export type TextSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string }

/**
 * What counts as a link.
 *
 * Deliberately narrow. `https://…` and `www.…` are the two forms a person actually pastes, and both
 * announce themselves — the alternative is guessing at bare domains, which turns "the file is in
 * config.json" into a link to a Japanese TLD. A household reading a reply is not helped by a panel
 * that is confidently wrong about what a word was.
 *
 * `mailto:` is included because an agent that hands back an address is handing back the one thing on
 * the screen you would otherwise have to copy by hand.
 */
const LINK_PATTERN = /\b(?:https?:\/\/|www\.|mailto:)[^\s<>"']+/gi

/**
 * Trailing characters that are punctuation rather than URL.
 *
 * A URL at the end of a sentence ends with the sentence, not with the URL — `see https://a.io/b.`
 * points at `/b`, and including the stop breaks it. Brackets are handled separately below, because
 * a closing one is only punctuation when nothing opened it inside the link itself.
 */
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/

/** Closing brackets, and the opener each one answers to. */
const BRACKETS: Record<string, string> = { ')': '(', ']': '[', '}': '{' }

/**
 * Trim a matched run down to the part that is actually the address.
 *
 * The bracket rule is the one worth stating: a trailing `)` is kept when the link contains an
 * unmatched `(`, and dropped otherwise. That is what tells
 * `https://en.wikipedia.org/wiki/Salt_(chemistry)` — where the bracket is part of the article name —
 * apart from `(see https://example.com)`, where it closes the aside around it.
 */
function trimTrailing(raw: string): string {
  let url = raw
  for (;;) {
    const before = url

    url = url.replace(TRAILING_PUNCTUATION, '')

    const last = url.at(-1)
    if (last && last in BRACKETS) {
      const opens = url.split(BRACKETS[last]).length - 1
      const closes = url.split(last).length - 1
      if (closes > opens) url = url.slice(0, -1)
    }

    if (url === before) return url
  }
}

/**
 * The address to actually navigate to.
 *
 * `www.` has no scheme, and a bare `href="www.example.com"` is resolved against the current page —
 * so the panel would navigate to `/assist/c/12/www.example.com` and show the household its own
 * not-found. It is the one form that has to be completed rather than passed through.
 */
function hrefFor(url: string): string {
  return /^www\./i.test(url) ? `https://${url}` : url
}

/**
 * Split a message into prose and links, in order.
 *
 * Always returns at least one segment for a non-empty message, and the concatenated `text` of every
 * segment is exactly the input — nothing is dropped or rewritten on the way to the screen. What was
 * said and what is displayed have to be the same string; a link that quietly tidied its own text
 * would make the transcript a paraphrase.
 */
export function segmentLinks(text: string): TextSegment[] {
  if (!text) return []

  const segments: TextSegment[] = []
  let cursor = 0

  // Reset explicitly: the pattern is a module-level regex with /g, so it carries `lastIndex` between
  // calls and a second message would start reading from wherever the first one stopped.
  LINK_PATTERN.lastIndex = 0

  for (let match = LINK_PATTERN.exec(text); match !== null; match = LINK_PATTERN.exec(text)) {
    const raw = match[0]
    const url = trimTrailing(raw)

    // Nothing left once the punctuation came off — a bare `www.` at the end of a sentence. It is
    // prose, and the loop below would otherwise emit a zero-length link.
    if (!url) continue

    if (match.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.index) })
    segments.push({ kind: 'link', text: url, href: hrefFor(url) })
    cursor = match.index + url.length

    // The trimmed tail has to be re-read as prose, not skipped: `lastIndex` is sitting past the
    // punctuation this match gave back.
    LINK_PATTERN.lastIndex = cursor
  }

  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) })
  return segments
}
