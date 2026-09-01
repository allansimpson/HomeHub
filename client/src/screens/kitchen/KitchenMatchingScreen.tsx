import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { KitchenDivider, KitchenDrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import type { MatchingCoverageDto } from '../../api/types'

/** How `HOW IT GOT LEARNED` reads each source. The wording is the point — see the note below. */
const SOURCE_LABELS: Record<string, string> = {
  Seed: 'Shipped knowing the basics',
  Scan: 'Taught by barcode scans',
  OrderLine: 'Taught by delivery lines',
  Substitution: 'Substitutions you accepted',
  Manual: 'Sorted out by hand',
}

/**
 * WHERE IT STANDS — matching coverage (MATCHING_AND_ALIASES §4, panel M3).
 *
 * The section's most fragile assumption, shown rather than hidden. Every ranked list in the Kitchen
 * rests on knowing that `GV DICED TOMATOES 14.5 OZ` is the tinned tomatoes a recipe wants, and when
 * that fails a perfectly correct panel reads as broken.
 *
 * Three things earn their place here:
 *
 * **One number with a direction of travel.** `83%`, and it was 41% in March. Without the second half
 * the early months feel like a broken app rather than a young one.
 *
 * **Attribution.** Most of the coverage is earned by shopping rather than by configuring, and
 * saying so is what makes the remaining work feel finite.
 *
 * **A queue ordered by recipes unblocked** — which turns a vague chore into a ranked five-minute job.
 */
export function KitchenMatchingScreen() {
  const navigate = useNavigate()
  const [coverage, setCoverage] = useState<MatchingCoverageDto | null>(null)
  /**
   * Three outcomes, not two.
   *
   * A swallowed failure used to leave this screen holding an empty `<div />` forever — no number,
   * no explanation, and no way to tell a slow answer from one that never came. On a panel whose
   * whole job is to admit what the app does not know, a blank body is the worst possible answer.
   */
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')

  const load = useCallback(() => {
    setState('loading')
    void api.getMatching()
      .then((c) => { setCoverage(c); setState('ready') })
      .catch(() => setState('unavailable'))
  }, [])

  useEffect(load, [load])

  if (state !== 'ready' || !coverage) {
    return (
      <ScreenShell header={<Header onExit={() => navigate(-1)} />}>
        <ScrollArea>
          <div className="ml-kitchen__askwhy">
            {state === 'loading'
              ? 'Working out how much of the folder we can match…'
              : "The panel couldn't work out its coverage just now. Nothing is wrong with the "
                + 'matches themselves — this screen is the only thing that could not be counted.'}
          </div>
          {state === 'unavailable' && (
            <div className="ml-kitchen__errandactions">
              <button type="button" className="ml-kitchen__errandalt" onClick={load}>
                TRY AGAIN
              </button>
            </div>
          )}
        </ScrollArea>
      </ScreenShell>
    )
  }

  const sources = Object.entries(coverage.bySource)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])

  return (
    <ScreenShell header={<Header onExit={() => navigate(-1)} />}>
      <ScrollArea>
        <div className="ml-kitchen__coverage">
          <span className="ml-kitchen__coveragepct">{coverage.percent}%</span>
          <span className="ml-kitchen__coveragewhy">
            of recipe lines match something the pantry knows about
            {coverage.totalLines > 0 && ` — ${coverage.matchedLines} of ${coverage.totalLines}`}.
          </span>
        </div>
        <div className="ml-kitchen__bar">
          <span className="ml-kitchen__barfill" style={{ width: `${coverage.percent}%` }} />
        </div>

        {sources.length > 0 && (
          <>
            <KitchenDivider label="How it got learned" gap={false} />
            <div>
              {sources.map(([source, count]) => (
                <div key={source} className="ml-row ml-kitchen__sourcerow">
                  <span className="ml-row__value">{SOURCE_LABELS[source] ?? source}</span>
                  <span className="ml-kitchen__sourcecount">{count}</span>
                </div>
              ))}
            </div>
          </>
        )}

        {coverage.worthSorting.length > 0 && (
          <>
            <KitchenDivider label="Worth sorting" count={coverage.worthSorting.length} amber />
            {/* Ranked, and it bisects rather than stopping at six: the tail is the point of a
                ranked job — you work down it until you stop caring, and a hard slice decides that
                for you. */}
            <div>
              {/* Ordered by how many recipes each one unblocks — a ranked job, not a pile. */}
              {coverage.worthSorting.map((gap) => (
                <button
                  key={gap.name}
                  type="button"
                  className="ml-row ml-kitchen__gaprow"
                  onClick={() => navigate(`/kitchen/matching/sort?ingredient=${encodeURIComponent(gap.name)}`)}
                >
                  <span className="ml-row__value">{gap.name}</span>
                  <span
                    className={
                      'ml-kitchen__gapblocks'
                      + (gap.recipesBlocked > 2 ? ' ml-kitchen__gapblocks--many' : '')
                    }
                  >
                    blocks {gap.recipesBlocked} {gap.recipesBlocked === 1 ? 'recipe' : 'recipes'}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {coverage.undone > 0 && (
          <>
            <KitchenDivider label="What we get wrong" count={coverage.undone} />
            <div>
              {/* A match undone is never suggested again for that pair. Saying so is what makes
                  "none of these" feel like it achieved something. */}
              <div className="ml-kitchen__emptyshelf">
                {coverage.undone} {coverage.undone === 1 ? 'pairing' : 'pairings'} you undid.
                {' '}Never suggested again.
              </div>
            </div>
          </>
        )}
      </ScrollArea>
    </ScreenShell>
  )
}

/** The same header in every state — a failure is this screen, not a different one. */
function Header({ onExit }: { onExit: () => void }) {
  return <KitchenDrillInHeader title="What we know" onExit={onExit} exit="BACK" />
}
