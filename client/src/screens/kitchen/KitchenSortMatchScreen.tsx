import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router'
import { KitchenDivider, KitchenDrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { ageLabel, amountLabel } from '../../app/pantryDomain'
import type { PantryItemDto } from '../../api/types'

/**
 * TEACHING ONE MATCH (MATCHING_AND_ALIASES §3, panel M2).
 *
 * A chrome-free errand, and the design's answer to the question every pantry app gets wrong: how
 * does the household teach the thing without it becoming a setup chore?
 *
 * **Asked only where it blocks.** Never an onboarding list of 200 ingredients to confirm — the
 * question arrives at the moment it is stopping something useful.
 *
 * **No free-text field anywhere.** Candidates are ranked and finite. Typing is what turns teaching a
 * match into data entry; picking from three is what makes it a minute's work.
 *
 * **`NONE OF THESE` is a real answer.** Not owning a thing is an answer too: the line stays
 * unmatched, stops being asked about, and goes on the list as written. Refusing also suppresses that
 * pair for good, so the same wrong suggestion never comes round again.
 */
export function KitchenSortMatchScreen() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const ingredient = params.get('ingredient') ?? ''

  const [candidates, setCandidates] = useState<PantryItemDto[] | null>(null)
  const [chosen, setChosen] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!ingredient) return
    void api.getMatchCandidates(ingredient, 3).then(setCandidates).catch(() => setCandidates([]))
  }, [ingredient])

  useEffect(load, [load])

  const teach = async () => {
    if (chosen == null) return
    setBusy(true)
    try {
      await api.teachMatch(ingredient, chosen)
      navigate('/kitchen/matching', { replace: true })
    } finally {
      setBusy(false)
    }
  }

  /** `NONE OF THESE` — refuse every candidate offered, so none of them is suggested again. */
  const refuseAll = async () => {
    setBusy(true)
    try {
      for (const item of candidates ?? []) {
        await api.refuseMatch(ingredient, item.id)
      }
      navigate('/kitchen/matching', { replace: true })
    } finally {
      setBusy(false)
    }
  }

  return (
    <ScreenShell
      // Chrome-free: no quick row and no nav. An errand is cancel or commit, with nothing to
      // wander off into halfway through.
      nav={false}
      header={
        <KitchenDrillInHeader
          title="Sorting one line"
          onExit={() => navigate('/kitchen/matching')}
          // `LATER`, not `CANCEL`. The line stays unsorted and the queue is still there — nothing
          // has been abandoned, which is a different promise from the one CANCEL makes.
          exit="LATER"
        />
      }
    >
      <ScrollArea>
        <div className="ml-kitchen__askedfor">
          <span className="ml-kitchen__askedlabel">THE RECIPE ASKS FOR</span>
          <span className="ml-kitchen__askedname">{ingredient}</span>
        </div>

        <KitchenDivider label="Is it one of these?" count={candidates == null ? undefined : `${candidates.length} LIKELY`} gap={false} />

        <div>
          {candidates != null && candidates.length === 0 ? (
            // Nothing on the shelves resembles it, which is itself an answer: it gets bought
            // rather than matched.
            <div className="ml-kitchen__emptyshelf">
              Nothing on the shelves looks like this. It will go on the list as written.
            </div>
          ) : (
            (candidates ?? []).map((item, i) => (
              <button
                key={item.id}
                type="button"
                className={`ml-row ml-kitchen__candidate${chosen === item.id ? ' ml-kitchen__candidate--on' : ''}`}
                aria-pressed={chosen === item.id}
                onClick={() => setChosen(chosen === item.id ? null : item.id)}
              >
                <span className="ml-kitchen__candidatebox">{chosen === item.id ? '✓' : ''}</span>
                <span className="ml-kitchen__candidatetext">
                  <span className="ml-kitchen__recipename">{item.name}</span>
                  {/* Location, amount and last-seen, so the choice is informed rather than a
                      guess between two names. */}
                  <span className="ml-kitchen__recipewhy">
                    {[item.location, amountLabel(item), ageLabel(item.lastSeenAtUtc)]
                      .filter(Boolean).join(' · ')}
                  </span>
                </span>
                {/* The first candidate is the close one; the rest are maybes. Ranked, and said so. */}
                <span
                  className={
                    'ml-kitchen__candidaterank'
                    + (i === 0 ? ' ml-kitchen__candidaterank--close' : '')
                  }
                >
                  {i === 0 ? 'CLOSE MATCH' : 'MAYBE'}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="ml-kitchen__errandactions">
          <button
            type="button"
            className="ml-kitchen__shop"
            disabled={chosen == null || busy}
            onClick={teach}
          >
            YES · REMEMBER IT
          </button>

          {/* Bordered peers, not borderless text: a borderless alternative reads as a caption on
              the primary and misses the 44px floor (M2's note). */}
          <div className="ml-kitchen__errandrow">
            <button
              type="button"
              className="ml-kitchen__errandalt"
              disabled={busy || (candidates?.length ?? 0) === 0}
              onClick={refuseAll}
            >
              NONE OF THESE
            </button>
            <button
              type="button"
              className="ml-kitchen__errandalt"
              disabled={busy}
              onClick={() => navigate('/kitchen/matching', { replace: true })}
            >
              SKIP THIS ONE
            </button>
          </div>
        </div>

        <KitchenDivider label="What saying yes does" />
        <div>
          <div className="ml-kitchen__emptyshelf">
            Every recipe wanting {ingredient} resolves from now on, and so does any future delivery
            line like it. Household-wide, and reversible from the item sheet.
          </div>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}
