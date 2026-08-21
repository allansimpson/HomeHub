import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The shell around the Kitchen's content — `design_handoff_kitchen_shell`.
 *
 * That handoff measured eight screens off a phone and found the panels' *contents* largely right
 * and the shell holding them wrong: blocks that never took the gutter, a band that lost its stub,
 * and groups budgeted for a canvas nobody was holding. None of it was catchable here, because none
 * of it is visible without a layout — the assertions that catch it live in the Playwright harness
 * (`shell.mjs`), which now walks every `/kitchen` route at 450 × 1000 as well as at the reference
 * 540 × 1169.
 *
 * What *is* catchable here is the markup those assertions depend on, which is what this file
 * guards. A check with an exemption is only as good as the exemption's bookkeeping: `data-hscroll`
 * is how an element declares that its right edge is meant to run off the fold, and one horizontal
 * scroller missing the attribute does not weaken the check — it fails the build on a correct
 * screen, which is worse, because that is how a check gets switched off.
 */

/**
 * The stylesheet, read from disk.
 *
 * Vitest stubs CSS imports to an empty string and `?raw` still routes through that stub, so the one
 * file that has to come off disk does. This test and `kitchenCut.test.ts` are the only things in
 * `src` compiled with Node's types (`tsconfig.checks.json`), which is what stops a component
 * quietly reaching for `node:fs` and still typechecking.
 */
const css = readFileSync(new URL('../components/kitchen.css', import.meta.url), 'utf8')

const screens: Record<string, string> = import.meta.glob('../screens/kitchen/*.tsx', {
  query: '?raw', import: 'default', eager: true,
})

/** Every class in `kitchen.css` that scrolls sideways, read out of the stylesheet itself. */
function horizontalScrollers(): string[] {
  const found: string[] = []
  for (const rule of css.matchAll(/\.([\w-]+) \{([^}]*)\}/g)) {
    if (/overflow-x:\s*(auto|scroll)/.test(rule[2])) found.push(rule[1])
  }
  return [...new Set(found)]
}

/** The opening tag of every element wearing `cls`, per screen. */
function tagsWearing(cls: string): { screen: string; tag: string }[] {
  const found: { screen: string; tag: string }[] = []
  for (const [path, source] of Object.entries(screens)) {
    for (const open of source.matchAll(/<[a-zA-Z][^>]*>/g)) {
      const tag = open[0]
      if (new RegExp(`className="[^"]*\\b${cls}\\b`).test(tag)) {
        found.push({ screen: path.split('/').pop()!, tag })
      }
    }
  }
  return found
}

describe('sideways scrollers say so in the markup', () => {
  /**
   * The exemption, and why it has to be declared rather than inferred.
   *
   * A cuisine chip clipped by the right edge is the design working — it is the only thing telling
   * anyone the row scrolls, and `RECIPES` is explicit that there is deliberately no "+N" instead.
   * `SKIP` clipped by the right edge is the fault `design_handoff_kitchen_shell` §1 measured. The
   * two are the same geometry, so nothing the harness can measure separates them; the markup has
   * to. Read out of the stylesheet rather than listed here, so a new scroller is caught by the
   * check the day it is written.
   */
  it('marks every horizontal scroller with data-hscroll', () => {
    const scrollers = horizontalScrollers()
    expect(scrollers.length).toBeGreaterThan(0)

    for (const cls of scrollers) {
      const tags = tagsWearing(cls)
      expect(tags.length, `.${cls} scrolls sideways but nothing in the section renders it`)
        .toBeGreaterThan(0)
      for (const { screen, tag } of tags) {
        expect(tag, `${screen}: .${cls} scrolls sideways and must carry data-hscroll`)
          .toMatch(/\bdata-hscroll\b/)
      }
    }
  })

  /**
   * The reverse: an element that claims the exemption and does not need it. It would be a free pass
   * for a genuinely clipped control, which is the whole thing the check exists to catch.
   */
  it('does not claim the exemption anywhere that does not scroll sideways', () => {
    const scrollers = new Set(horizontalScrollers())
    for (const [path, source] of Object.entries(screens)) {
      for (const open of source.matchAll(/<[a-zA-Z][^>]*\bdata-hscroll\b[^>]*>/g)) {
        const classes = /className="([^"]*)"/.exec(open[0])?.[1] ?? ''
        expect(
          classes.split(/\s+/).some((c) => scrollers.has(c)),
          `${path.split('/').pop()}: data-hscroll on "${classes}", which scrolls nowhere`,
        ).toBe(true)
      }
    }
  })
})

describe('the empty list', () => {
  /**
   * `PANTRY_BEHAVIOURS` §6, surface 9e — the screen `design_handoff_kitchen_shell` §8 measured as
   * 65% nothing. The copy is fixed by the spec and the second line is the load-bearing half: an
   * empty list that does not say it fills itself reads as a feature nobody switched on.
   */
  it('says what the spec says, and says why', () => {
    const source = screens['../screens/kitchen/KitchenListScreen.tsx']
    expect(source, 'KitchenListScreen.tsx not found').toBeTruthy()
    expect(source).toContain('Nothing on the list')
    expect(source.replace(/&rsquo;/g, "'"))
      .toContain("Things you'll need for this week's meals turn up here on their own.")
  })

  /**
   * Empty means nothing on it, not nothing *open*. A list holding three ticked lines is a record of
   * a shop that just happened, and calling that empty while the receipts are on screen is the kind
   * of thing that makes a panel look like it is reading a different screen from the one you are.
   */
  it('is empty only when the list holds no lines at all', () => {
    const source = screens['../screens/kitchen/KitchenListScreen.tsx']
    expect(source).toMatch(/const bare = list != null && list\.lines\.length === 0/)
  })
})
