import { describe, expect, it } from 'vitest'

/**
 * The Kitchen's group headings, and the one scroller per screen.
 *
 * Source-level guards, in the manner of `headers.test.ts` and for the same reason: the suite has no
 * DOM, and the defects these pin are ones that read perfectly well in a diff.
 *
 * `design_handoff_kitchen_lists` replaced the full-bleed band with a divider and removed every
 * nested per-group scroller. Both are the kind of change that is 95% done and then quietly
 * incomplete — one screen left on the old vocabulary looks like a rendering fault rather than an
 * omission, and one `CutGroup` left behind traps rows inside a window nobody can see the edge of.
 */
const SOURCES: Record<string, string> = import.meta.glob('./Kitchen*.tsx', {
  query: '?raw', import: 'default', eager: true,
})

const screens = Object.keys(SOURCES).sort()

const nameOf = (path: string) => path.replace('./', '')

/** Every `label="..."` given to a `KitchenDivider`, literal ones only. */
function literalLabels(source: string): string[] {
  return [...source.matchAll(/<KitchenDivider\b[^/]*?label="([^"]*)"/g)].map((m) => m[1])
}

describe('Kitchen section dividers', () => {
  it('finds the screens to check', () => {
    // Guards the guard: a rename that empties this list would make every case below vacuous.
    expect(screens.length).toBeGreaterThan(15)
  })

  it.each(screens)('%s has no full-bleed bands left', (path) => {
    const file = nameOf(path)
    const source = SOURCES[path]

    // `ml-band__meta` and `ml-band-shade` went with it; `ml-kitchen__banddoor` is a different
    // class that survives on the answering page, so the boundary is deliberately `ml-band` + a
    // word boundary rather than a bare substring.
    const bands = [...source.matchAll(/className="[^"]*\bml-band\b[^"]*"/g)]
    expect(bands.map((m) => m[0]), `${file}: still drawing the band the handoff removed`)
      .toEqual([])
  })

  it.each(screens)('%s scrolls once', (path) => {
    const file = nameOf(path)
    const source = SOURCES[path]

    expect(source, `${file}: a per-group scroller inside the screen's own scroller`)
      .not.toMatch(/<CutGroup\b/)
    // The horizontal carousels keep theirs (§2 exempts them by name), so only the vertical axis
    // is asserted on.
    expect(source, `${file}: a nested vertical scroller`).not.toMatch(/overflowY|overflow-y/)
  })

  /**
   * Sentence case, not caps.
   *
   * The divider's whole argument is that a group heading is a *name* read at arm's length rather
   * than a system label scanned for, which is why it is set in the serif at 19px. A label left in
   * the band's shouting caps keeps the old register in the new shape, and that is the failure most
   * likely to survive review — it is correct in every respect except the one that mattered.
   *
   * Household words are exempt by construction: this only reads string literals, and a shelf or an
   * aisle name arrives as an expression.
   */
  it.each(screens)('%s names its groups in sentence case', (path) => {
    const file = nameOf(path)

    for (const label of literalLabels(SOURCES[path])) {
      const letters = label.replace(/[^A-Za-z]/g, '')
      expect(letters.length, `${file}: "${label}" has no letters to case`).toBeGreaterThan(0)
      expect(
        letters === letters.toUpperCase(),
        `${file}: "${label}" is still in the band's caps`,
      ).toBe(false)
      expect(
        label[0] === label[0].toUpperCase(),
        `${file}: "${label}" does not start with a capital`,
      ).toBe(true)
    }
  })
})
