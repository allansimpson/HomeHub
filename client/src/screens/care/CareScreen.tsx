import { useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import { ScreenShell, ScrollArea } from '../../components'
import { useCareSubjects, type CareSubject, type CareSubjectId } from '../../app/careSubjects'
import { ConradView } from './ConradView'
import { MikaView } from './MikaView'

/**
 * Care — one tab, two subjects, two genuinely different views inside one frame.
 *
 * Baby and Litter shared a five-part structure — live status, today's log, quick actions, history,
 * settings — which is why they merged. What they do *not* share is a shape: **a baby is a log you
 * write to; a litter robot is a machine you read.** Conrad leads with hold-to-confirm entry tiles
 * because logging is why you walk over to the panel; Mika leads with the fault because reading the
 * state is why you walk over. A single merged template was considered and rejected — an interleaved
 * feed loses both (CARE.md).
 *
 * So this file owns only what genuinely is shared: the switcher, the double rule, the sync line and
 * the scroll body. Everything below that belongs to the subject.
 */
export function CareScreen() {
  const [params, setParams] = useSearchParams()
  const { subjects, resolved, defaultSubject } = useCareSubjects()

  /**
   * The subject, resolved from three sources in priority order.
   *
   * `?subject=` first, so the redirects from `/baby` and `/litter`, notification deep links and the
   * Attendant can all land on a named subject. Then whatever was tapped. Then the opening default —
   * a hard fault if there is one, otherwise Conrad. **Recency deliberately does not decide**: "most
   * recently active" was considered and rejected, so a quiet day always opens on Conrad.
   */
  const [picked, setPicked] = useState<CareSubjectId | null>(null)
  const latched = useRef(false)
  useEffect(() => {
    // Latched once, after the providers settle. The opening choice is a mount-time decision; a fault
    // that arrives later badges the mark and raises a drawer row, but it does not steal the view
    // from someone mid-way through a hold on a write that cannot be undone.
    if (!resolved || latched.current) return
    latched.current = true
    setPicked((p) => p ?? defaultSubject)
  }, [resolved, defaultSubject])

  const requested = params.get('subject')
  const subject: CareSubjectId = requested === 'conrad' || requested === 'mika'
    ? requested
    : picked ?? 'conrad'

  const select = useCallback(
    (id: CareSubjectId) => {
      setPicked(id)
      // Replace rather than push: the switcher is a view control, and stacking a history entry per
      // tap would turn Back into "undo the last three glances".
      setParams(id === 'conrad' ? {} : { subject: id }, { replace: true })
    },
    [setParams],
  )

  const active = subjects.find((s) => s.id === subject) ?? subjects[0]

  return (
    <ScreenShell header={<CareSwitcher subjects={subjects} active={subject} onSelect={select} />}>
      <div className={`ml-syncline ml-syncline--${active.sync.tone}`}>
        <span className="ml-syncline__dot" aria-hidden="true" />
        <span className="ml-syncline__text">{active.sync.text}</span>
        {active.sync.meta && <span className="ml-syncline__meta">{active.sync.meta}</span>}
      </div>

      <ScrollArea>
        <div className="ml-care__body">
          {subject === 'conrad' ? <ConradView /> : <MikaView />}
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}

/**
 * The header line *is* the switcher.
 *
 * One active name at 29px Marcellus with its metadata beside it; every other subject is a 10px
 * small-caps mark after a hairline divider. **Marks win**: a third subject is another mark, never a
 * second name — the line never holds two names, because two names is a list and a list needs a
 * heading, and then Care has a landing page nobody asked for.
 */
function CareSwitcher({
  subjects, active, onSelect,
}: {
  subjects: CareSubject[]
  active: CareSubjectId
  onSelect: (id: CareSubjectId) => void
}) {
  const current = subjects.find((s) => s.id === active) ?? subjects[0]
  const others = subjects.filter((s) => s.id !== current.id)

  return (
    <header className="ml-header ml-care__switcher">
      <span className="ml-care__name serif">{current.name}</span>
      {current.meta && <span className="ml-care__namemeta">{current.meta}</span>}
      {others.length > 0 && <span className="ml-care__divider" aria-hidden="true" />}
      {others.map((s) => (
        <button
          key={s.id}
          type="button"
          className={'ml-care__mark' + (s.faulted ? ' ml-care__mark--fault' : '')}
          onClick={() => onSelect(s.id)}
        >
          {s.name}
          {/* The fault badges its own mark *and* drops a row in the notification drawer. Both,
              always — and nothing is suppressed overnight (IA.md). */}
          {s.faulted && <span className="ml-care__markdot" aria-hidden="true" />}
        </button>
      ))}
    </header>
  )
}
