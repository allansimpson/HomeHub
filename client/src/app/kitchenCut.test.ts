import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { cutHeight } from './kitchenDomain'

/**
 * The bisected cut, checked against the stylesheet rather than against itself.
 *
 * `PANTRY_SHELVES` §1 fixes the group treatment and `RECIPES` §6 records that it went wrong three
 * times in one segment. Both failures are the same shape and both are **silent**: a group whose
 * height lands on a row boundary clips only padding, so it renders as a complete list with nothing
 * below it. No error, no clipped glyph — just rows nobody ever finds.
 *
 * The arithmetic is easy to get right and easy to invalidate from a distance: `rowHeight={42}` is
 * only true while the rows in that group are actually 42px, and nothing in the type system connects
 * the two. These tests read both sides and check they still agree.
 */

/**
 * The panels and the stylesheet, as text.
 *
 * The panels come through Vite's `?raw`; the stylesheet cannot, because vitest stubs CSS imports to
 * an empty string and `?raw` still routes through that stub. So the one file that has to be read
 * from disk is read from disk — and this test is the only thing in `src` compiled with Node's
 * types, so no component can quietly reach for `node:fs` and still typecheck.
 */
const screens = Object.entries(
  import.meta.glob('../screens/kitchen/*.tsx', { query: '?raw', import: 'default', eager: true }),
).map(([path, source]) => ({ name: path.split('/').pop()!, source: source as string }))

const css = readFileSync(
  new URL('../components/kitchen.css', import.meta.url), 'utf8')

/** Every `rowHeight={N}` handed to a CutGroup anywhere in the section. */
const rowHeights = [...new Set(cuts().map((c) => c.rowHeight).filter((h): h is number => h != null))]
  .sort((a, b) => a - b)

/**
 * Each `CutGroup` in the section, paired with the row class rendered inside it.
 *
 * Read out of the JSX rather than declared here: a hand-kept list is one more thing that can drift
 * away from the panels, which is the failure being tested for. Everything it cannot resolve is
 * reported rather than skipped — a checker that quietly passes over a third of the panels is worse
 * than none, because it reports green over exactly the cases nobody has looked at.
 */
interface Cut {
  screen: string
  rows: number | null
  rowHeight: number | null
  rowClass: string | null
  cssHeight: number | null
}

function cuts(): Cut[] {
  const found: Cut[] = []

  for (const { name, source } of screens) {
    // `rows={SHELF_ROWS}` is the ordinary form on the destinations, so the constants have to be
    // resolved or those panels drop out of the check entirely.
    const consts = new Map<string, number>(
      [...source.matchAll(/^const (\w+) = (\d+)$/gm)].map((m) => [m[1], Number(m[2])]),
    )
    const num = (raw: string | undefined): number | null => {
      if (raw == null) return null
      const literal = Number(raw)
      return Number.isFinite(literal) ? literal : consts.get(raw) ?? null
    }

    for (const block of source.matchAll(/<CutGroup\b([^>]*)>([\s\S]*?)<\/CutGroup>/g)) {
      const rowClass = rowClassIn(block[2], source)
      found.push({
        screen: name,
        rows: num(/rows=\{([\w]+)\}/.exec(block[1])?.[1]),
        rowHeight: num(/rowHeight=\{([\w]+)\}/.exec(block[1])?.[1]),
        rowClass,
        cssHeight: rowClass ? cssHeightOf(rowClass) : null,
      })
    }
  }
  return found
}

/**
 * The class the rows in this group actually wear.
 *
 * Follows a child component (`<ShopRow …>`) into its own definition, because most panels render
 * their row through one — and a modifier wins over its base, since `--cook` is precisely how a
 * panel gives its rows a height of their own.
 */
function rowClassIn(block: string, source: string): string | null {
  const named = [...block.matchAll(/ml-kitchen__[a-z]+(?:--[a-z]+)?/g)].map((m) => m[0])
  const direct = pick(named)
  if (direct) return direct

  // No class in the group itself — it renders a component. Find it and look in there.
  //
  // Sliced on the next `function` rather than on the first closing brace at column nought: a
  // destructured parameter list closes exactly that way, so brace-matching found the signature and
  // declared the component classless.
  for (const child of block.matchAll(/<([A-Z]\w*)\b/g)) {
    const body = source.split(/\nfunction /).find((chunk) => chunk.startsWith(`${child[1]}(`))
    if (!body) continue
    const inner = pick([...body.matchAll(/ml-kitchen__[a-z]+(?:--[a-z]+)?/g)].map((m) => m[0]))
    if (inner) return inner
  }
  return null
}

function pick(named: string[]): string | null {
  const withHeight = named.filter((c) => cssHeightOf(c) != null)
  return withHeight.find((c) => c.includes('--')) ?? withHeight[0] ?? null
}

function cssHeightOf(cls: string): number | null {
  const rule = new RegExp(`\\.${cls} \\{([^}]*)\\}`).exec(css)
  const height = rule && /\n\s*height: ([\d.]+)rem;/.exec(rule[1])
  return height ? Number(height[1]) * 16 : null
}

describe('the bisected cut', () => {
  it('lands inside a row rather than on a boundary', () => {
    // Four 42px rows: 189px puts the boundary 21px into the fifth row's text box.
    expect(cutHeight(4, 42)).toBe(189)
    expect(cutHeight(4, 42) % 42).toBe(21)
  })

  /**
   * The whole point. A height that is a whole multiple of the row height clips only padding, and
   * the group stops saying it continues.
   */
  it('is never a whole number of rows', () => {
    for (const rows of [1, 2, 3, 4, 5, 9]) {
      for (const h of rowHeights) {
        expect(cutHeight(rows, h) % h).not.toBe(0)
      }
    }
  })

  it('grows by exactly one row per row', () => {
    expect(cutHeight(5, 56) - cutHeight(4, 56)).toBe(56)
  })
})

describe('every cut is grounded in a real row height', () => {
  /**
   * The invalidation-at-a-distance case, and the one that matters most.
   *
   * `rowHeight={42}` is only true while the rows *in that group* are 42px tall, and nothing in the
   * type system connects the two: somebody grows `.ml-kitchen__shelfrow` to 48 for a longer name
   * and the pantry's four groups quietly start cutting in the wrong place. Nothing else would fail.
   *
   * So this pairs each `CutGroup` with the row class actually rendered inside it and checks the two
   * numbers still agree — rather than checking the height merely exists somewhere in the file,
   * which passes happily while four panels cut on a figure nothing wears any more.
   */
  it('cuts each group on the height of the rows inside it', () => {
    const all = cuts()
    expect(all.length).toBeGreaterThan(20)

    for (const { screen, rows, rowHeight, rowClass, cssHeight } of all) {
      // Unresolved is a failure, not a skip. A group this cannot read is a group nobody is checking.
      expect(rows, `${screen}: could not read rows`).not.toBeNull()
      expect(rowHeight, `${screen}: could not read rowHeight`).not.toBeNull()
      expect(rowClass, `${screen}: could not find the row class inside the group`).not.toBeNull()
      expect(
        cssHeight,
        `${screen}: cuts on ${rowHeight}px but .${rowClass} is ${cssHeight}px`,
      ).toBe(rowHeight)
    }
  })

  /**
   * `min-height` is the trap in its purest form: it reads as a row height, it is usually right, and
   * it lets one long name push the cut onto a boundary on exactly the panel somebody is looking at.
   */
  it('pins the rows that sit inside a cut, rather than giving them a floor', () => {
    const cutRowClasses = [
      'ml-kitchen__shelfrow',
      'ml-kitchen__listrow',
      'ml-kitchen__recipe',
      'ml-kitchen__ingrow',
      'ml-kitchen__stepline',
      'ml-kitchen__receiptrow',
      'ml-kitchen__waitingrow',
      'ml-kitchen__shoprow',
      'ml-kitchen__shelfliferow',
      'ml-kitchen__gaprow',
      'ml-kitchen__wantrow',
      'ml-kitchen__awayrow',
      'ml-kitchen__matchedrow',
      'ml-kitchen__parsed',
      'ml-kitchen__aislerow',
    ]

    for (const cls of cutRowClasses) {
      const rule = new RegExp(`\\.${cls} \\{([^}]*)\\}`).exec(css)
      expect(rule, `${cls} has no rule in kitchen.css`).not.toBeNull()
      expect(rule![1], `${cls} should pin its height, not floor it`).not.toMatch(/min-height:/)
      expect(rule![1], `${cls} has no pinned height`).toMatch(/\n\s*height: [\d.]+rem;/)
    }
  })
})
