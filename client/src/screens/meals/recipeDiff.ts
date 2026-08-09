import type { RecipeDto } from '../../api/types'

/** One ingredient line that differs between two saved recipes. */
export interface LineDiff {
  name: string
  from: string | null
  to: string | null
}

/**
 * How two recipes differ, compared on the parsed ingredient `name` (MEALS_FORK §5).
 *
 * Matched on `name` rather than on position, because a fork can add or drop a line and positional
 * comparison would then report every line after it as changed. A line the parser never named falls
 * back to its raw text, which is at least stable between a recipe and its own copy.
 *
 * Exported so the lineage strip can count the differences without rendering them.
 */
export function diffIngredients(from: RecipeDto, to: RecipeDto): LineDiff[] {
  const key = (i: { name: string | null; rawText: string }) =>
    (i.name ?? i.rawText).trim().toLowerCase()
  const amount = (i: { quantity: number | null; unit: string | null; rawText: string }) =>
    [i.quantity ?? '', i.unit ?? ''].join(' ').trim() || i.rawText

  const before = new Map(from.ingredients.map((i) => [key(i), i]))
  const after = new Map(to.ingredients.map((i) => [key(i), i]))
  const out: LineDiff[] = []

  for (const [k, line] of after) {
    const was = before.get(k)
    if (!was) { out.push({ name: line.name ?? line.rawText, from: null, to: amount(line) }); continue }
    if (amount(was) !== amount(line)) {
      out.push({ name: line.name ?? line.rawText, from: amount(was), to: amount(line) })
    }
  }
  // Lines the variation dropped are a difference too — silently omitting them would let a fork that
  // removed an ingredient read as identical.
  for (const [k, line] of before) {
    if (!after.has(k)) out.push({ name: line.name ?? line.rawText, from: amount(line), to: null })
  }
  return out
}
