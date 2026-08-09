import { useEffect, useState } from 'react'
import { api } from '../api/client'
import type { MeasurementUnitDto } from '../api/types'

/**
 * The units the household measures in, shared by every field that asks for one.
 *
 * **Not a provider.** The unit list is read by four screens in two sections and written by none of
 * them, so wrapping the app in another context to carry thirty immutable rows would be ceremony
 * around a constant that happens to arrive over HTTP. A module-level cache and a hook do the same
 * job in a third of the code, and a screen that mounts a unit field gets the list without its
 * section having to know units exist.
 *
 * The server remains authoritative: it folds, resolves and adopts on save (`UnitRegistry`). What
 * happens here is the same resolution done early, so the field can show what will be stored while
 * somebody is still typing it — a box that quietly rewrites `ounces` to `oz` after the save is a
 * box that looks like it lost the input.
 */

/** Fold a typed unit the way the server does: trimmed, lowercased, whitespace collapsed, periods dropped. */
export function foldUnit(raw: string): string {
  return raw.replace(/\./g, '').trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * The canonical spelling of what was typed, or the folded text when nothing matches.
 *
 * Free text is a normal answer, not a failure: "sleeve" comes back as `sleeve` and becomes a unit
 * of its own the moment the row is saved. Refusing it would be the strictness that makes people
 * write the unit into the item's name instead.
 */
export function resolveUnit(raw: string, units: MeasurementUnitDto[]): string {
  const key = foldUnit(raw)
  if (!key) return ''
  const hit = units.find((u) => u.aliases.some((a) => a === key) || foldUnit(u.canonical) === key)
  return hit ? hit.canonical : key
}

/**
 * What to offer under the box.
 *
 * Ranked rather than filtered, because the useful answer to "ou" is `oz` and not the alphabetical
 * accident that starts with the same two letters. Exact spellings win, then units whose own name
 * starts with what was typed, then any accepted spelling, then anything containing it — and inside
 * each tier the list keeps its server order, which is how often a kitchen reaches for the unit.
 */
export function suggestUnits(
  typed: string,
  units: MeasurementUnitDto[],
  limit = 6,
): MeasurementUnitDto[] {
  const key = foldUnit(typed)
  // Nothing typed yet: the opening hand, which is the first few in reach-for-it order.
  if (!key) return units.slice(0, limit)

  const rank = (u: MeasurementUnitDto): number => {
    if (u.aliases.includes(key) || foldUnit(u.canonical) === key) return 0
    if (foldUnit(u.canonical).startsWith(key)) return 1
    if (u.displayName?.toLowerCase().startsWith(key)) return 2
    if (u.aliases.some((a) => a.startsWith(key))) return 3
    if (u.aliases.some((a) => a.includes(key))) return 4
    return 5
  }

  return units
    .map((u, order) => ({ u, order, rank: rank(u) }))
    .filter((row) => row.rank < 5)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map((row) => row.u)
}

// ---- The shared fetch ----

let cache: MeasurementUnitDto[] = []
let inFlight: Promise<void> | null = null
const listeners = new Set<() => void>()

function load(): void {
  if (inFlight) return
  inFlight = api.getUnits()
    .then((units) => {
      cache = units
      listeners.forEach((notify) => notify())
    })
    // A unit field with no list is still a working text box — the server normalises whatever is
    // typed either way. Suggestions are the convenience; losing them is not worth an error state
    // on a sheet that is about something else.
    .catch(() => { /* no suggestions this session */ })
    .finally(() => { inFlight = null })
}

/**
 * Drop the cached list so the next mount re-reads it.
 *
 * Called after a save that may have introduced a unit — the household typed "sleeve" once and the
 * second person to reach for it should be offered it rather than having to spell it the same way
 * from memory.
 */
export function refreshUnits(): void {
  cache = []
  load()
}

/** The list, fetched once per session and shared by every field on screen. */
export function useUnits(): MeasurementUnitDto[] {
  const [units, setUnits] = useState(cache)

  useEffect(() => {
    const notify = () => setUnits(cache)
    listeners.add(notify)
    if (cache.length === 0) load()
    else notify()
    return () => { listeners.delete(notify) }
  }, [])

  return units
}
