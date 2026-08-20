import { describe, expect, it } from 'vitest'

/**
 * Every exit in the Kitchen is labelled.
 *
 * A source-level guard rather than a rendered one, because the suite has no DOM — but the defect it
 * pins was real and shipped: `KitchenAddScreen` rendered a bare back arrow where `ADD_TO_PANTRY` §1
 * requires `CANCEL`, and the file's own doc comment said so while the JSX did not.
 *
 * The rule the specs actually state is narrow. A **destination** reached from the quick row has no
 * back control at all and uses {@link KitchenHeader}. A **drill-in or errand** has one, and it is
 * named — `BACK`, `CANCEL`, `LATER`, `PAUSE`, `STOP`, `UNDO ALL` — because the word is the promise:
 * `CANCEL` throws work away, `LATER` keeps it, and an arrow makes no promise at all.
 */
/**
 * The sources, read through Vite rather than `node:fs`.
 *
 * The client is typed for the browser and has no `@types/node`; pulling that in so one test can
 * call `readFileSync` would widen the whole project's type surface to buy a single guard.
 */
const SOURCES: Record<string, string> = import.meta.glob('./Kitchen*.tsx', {
  query: '?raw', import: 'default', eager: true,
})

const screens = Object.keys(SOURCES).sort()

const nameOf = (path: string) => path.replace('./', '')

/** The vocabulary the reference designs use. Anything else is a word nobody agreed on. */
const LABELS = ['BACK', 'CANCEL', 'LATER', 'PAUSE', 'STOP', 'UNDO ALL']

/** Header openings, brace-balanced so a header carrying nested JSX is read whole. */
function headers(source: string): string[] {
  const found: string[] = []
  const opens = [...source.matchAll(/<DrillInHeader\b/g)]
  for (const open of opens) {
    let i = open.index + open[0].length
    let depth = 0
    while (i < source.length) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') depth -= 1
      else if (source[i] === '>' && depth === 0) break
      i += 1
    }
    found.push(source.slice(open.index, i))
  }
  return found
}

describe('Kitchen drill-in headers', () => {
  it('finds the screens to check', () => {
    // Guards the guard: a rename that empties this list would make every case below vacuous.
    expect(screens.length).toBeGreaterThan(15)
  })

  it.each(screens)('%s labels every back control it renders', (path) => {
    const file = nameOf(path)
    const source = SOURCES[path]

    for (const header of headers(source)) {
      if (!header.includes('onBack')) continue
      // `title=""` marks the not-found guard — a screen with nothing to name yet.
      if (/title=""/.test(header)) continue

      const label = /backLabel="([^"]*)"/.exec(header)
      expect(label, `${file}: a back control with no word on it`).not.toBeNull()
      expect(LABELS, `${file}: "${label?.[1]}" is not one of the agreed words`)
        .toContain(label![1])
    }
  })
})
