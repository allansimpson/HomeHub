import { useMemo } from 'react'
import { useSession } from './SessionProvider'

/**
 * The household's name for the cat, and the handful of phrasings that use it.
 *
 * The Litter-Robot reports that *a* cat is present and never which one, so this is not identity —
 * with one cat in the household it is simply the better word. Every phrasing here falls back to the
 * literal word "cat", because rendering an empty string (or, worse, "unknown") into a sentence about
 * a pet is how a wall panel starts reading like a database.
 *
 * If a second cat ever joins, every one of these reverts to *the cat*: the hardware still cannot tell
 * them apart, and a name on a reading the robot can't attribute would be a lie rather than a nicety.
 */
export interface CatNaming {
  /** The name as set, or null. Only use this to decide whether a name exists. */
  name: string | null
  /** Sentence-leading subject: `Mika` / `The cat`. */
  subject: string
  /** Mid-sentence subject: `Mika` / `the cat`. */
  object: string
  /** Possessive with a curly apostrophe: `Mika’s` / `The cat’s`. */
  possessive: string
  /** The freshness line's right slot: `Mika's box` / `The box`. */
  box: string
}

/** Curly, to match the typography everywhere else — never a straight quote in body copy. */
function possessiveOf(name: string): string {
  return name.endsWith('s') || name.endsWith('S') ? `${name}’` : `${name}’s`
}

export function useCatName(): CatNaming {
  const { settings } = useSession()
  const name = settings?.catName?.trim() || null

  return useMemo<CatNaming>(
    () => ({
      name,
      subject: name ?? 'The cat',
      object: name ?? 'the cat',
      possessive: name ? possessiveOf(name) : 'The cat’s',
      // Apostrophe deliberately straight here: this string lands in letterspaced caps on the
      // freshness line, where a curly mark reads as a stray tick at 10px.
      box: name ? `${name}'s box` : 'The box',
    }),
    [name],
  )
}
