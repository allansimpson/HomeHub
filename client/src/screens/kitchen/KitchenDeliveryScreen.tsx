import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { CutGroup, DrillInHeader, ScreenShell, ScrollArea } from '../../components'
import { api } from '../../api/client'
import { AttachmentRefused, readAttachment } from '../assist/attachments'
import { DecisionCard } from './DecisionCard'
import { sortImportLines } from '../../app/kitchenDomain'
import type {
  OrderImportDto, OrderImportLineDto, PantryItemDto, ReadLineDto,
} from '../../api/types'

/** Two names for the same shelf. Casing and surrounding space are not a difference. */
function same(a: string, b: string | null): boolean {
  return b != null && a.trim().toLowerCase() === b.trim().toLowerCase()
}

/** One screenshot, and the line range it covered. */
interface Shot {
  preview: string | null
  lines: ReadLineDto[]
  from: number
  to: number
}

/** How a disagreement got settled. Held here; nothing writes until the footer. */
type Settlement = 'same' | 'separate' | 'skip' | 'typed'

/**
 * READING A DELIVERY IN (SETTINGS_AND_IMPORT §3, panel S3).
 *
 * A chrome-free errand ending in the same put-away commit as a shop.
 *
 * **Screenshots, not credentials.** Deliveries arrive as photographs of the finished order. There
 * is no consumer API worth having, and no reason to ask a household to hand over an account
 * password to get one. The store is a chip you set, and nothing in the panel depends on which one
 * it is.
 *
 * **One shot rarely covers a big order**, so shots are collected — each labelled with the lines it
 * produced — and read into one import.
 *
 * **Unasked-for things still count.** Lines nobody put on the list are added anyway: a pantry that
 * only knows about planned purchases is wrong by however much the household improvises.
 */
export function KitchenDeliveryScreen() {
  const navigate = useNavigate()
  const picker = useRef<HTMLInputElement>(null)

  const [store, setStore] = useState('Walmart')
  const [shots, setShots] = useState<Shot[]>([])
  const [reading, setReading] = useState(false)
  const [trouble, setTrouble] = useState<string | null>(null)
  const [imported, setImported] = useState<OrderImportDto | null>(null)
  const [answers, setAnswers] = useState<Map<number, Settlement>>(new Map())
  const [pantry, setPantry] = useState<PantryItemDto[]>([])
  const [busy, setBusy] = useState(false)

  // The shelves, so `SAME THING` has something to be the same *as*.
  useEffect(() => {
    let cancelled = false
    void api.getPantry().then((p) => { if (!cancelled) setPantry(p.items) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const addShot = async (file: File) => {
    setTrouble(null)
    setReading(true)
    try {
      const attachment = await readAttachment(file)
      if (attachment.base64 == null) {
        setTrouble('That file is not a picture.')
        return
      }
      const result = await api.readPurchasePhoto({
        imageBase64: attachment.base64,
        mediaType: attachment.mediaType,
      })
      if (result.reason) setTrouble(result.reason)
      if (result.lines.length === 0) return

      setShots((prev) => {
        const from = prev.reduce((n, s) => n + s.lines.length, 0) + 1
        return [...prev, {
          preview: attachment.preview,
          lines: result.lines,
          from,
          to: from + result.lines.length - 1,
        }]
      })
      if (result.vendorLabel) setStore(result.vendorLabel)
    } catch (e) {
      setTrouble(e instanceof AttachmentRefused ? e.message : 'That one could not be read.')
    } finally {
      setReading(false)
    }
  }

  /** Hand every shot's lines over as one payload — the existing parser does the rest. */
  const parse = async () => {
    setBusy(true)
    try {
      setImported(await api.createImport({
        source: 'Photo',
        vendorLabel: store,
        rawPayload: shots.flatMap((s) => s.lines.map((l) => l.rawText)).join('\n'),
      }))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Settle the questions, then apply.
   *
   * The answers used to be collected, counted in the footer and then dropped on the floor —
   * `applyImport` saw an untouched import and did whatever it would have done unasked. So `SAME
   * THING` never taught anything and `KEEP SEPARATE` was indistinguishable from it.
   */
  const commit = async () => {
    if (!imported) return
    setBusy(true)
    try {
      for (const line of questions) {
        const how = answers.get(line.id)

        if (how === 'same') {
          // What arrived is the thing already on the shelf under the household's own name. Point
          // the line at it and teach the raw text, so the next delivery spelling it that way lands
          // without asking.
          const shelf = pantry.find((i) => same(i.name, line.proposedName))
          if (shelf) {
            await api.updateImportLine(imported.id, line.id, { matchedPantryItemId: shelf.id })
            await api.teachMatch(line.rawText, shelf.id)
          }
        } else if (how === 'separate') {
          // Its own thing, filed under what actually came rather than what was ordered.
          await api.updateImportLine(imported.id, line.id, { proposedName: line.rawText })
        }

        // `skip`, and anything still unanswered, needs no write: apply already leaves an Unreadable
        // line behind. `typed` navigated away from this errand and is settled on the add screen.
      }

      await api.applyImport(imported.id)
      navigate('/kitchen/pantry')
    } finally {
      setBusy(false)
    }
  }

  const lines = imported?.lines ?? []
  const { matched, questions, unasked, going } = sortImportLines(lines)
  const open = questions.filter((q) => !answers.has(q.id))

  return (
    <ScreenShell
      nav={false}
      header={
        <DrillInHeader
          title="A delivery came"
          onBack={() => navigate('/kitchen/pantry')}
          backLabel="CANCEL"
        />
      }
    >
      <ScrollArea>
        {/* A chip, not a login. Walmart is the common case and nothing here depends on it. */}
        <div className="ml-kitchen__chips">
          {['Walmart', 'Tesco', 'Butcher'].map((name) => (
            <button
              key={name}
              type="button"
              className={`ml-kitchen__chip${store === name ? ' ml-kitchen__chip--on' : ''}`}
              onClick={() => setStore(name)}
            >
              {name.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="ml-band">
          <span className="ml-band__label">WHAT WAS READ</span>
          <span className="ml-band__meta">
            {shots.length} {shots.length === 1 ? 'SHOT' : 'SHOTS'}
          </span>
        </div>
        <div className="ml-band-shade">
          <div className="ml-kitchen__shotstrip">
            {shots.map((shot) => (
              <div key={shot.from} className="ml-kitchen__shot">
                {shot.preview && <img className="ml-kitchen__shotimg" src={shot.preview} alt="" />}
                {/* Labelled by the lines it covered, so a gap in a long order is findable. */}
                <span className="ml-kitchen__shotrange">LINES {shot.from}–{shot.to}</span>
              </div>
            ))}
            <button
              type="button"
              className="ml-kitchen__shotadd"
              disabled={reading}
              onClick={() => picker.current?.click()}
            >
              {reading ? 'READING…' : '＋ ANOTHER SHOT'}
            </button>
          </div>
          {trouble && <div className="ml-kitchen__askwhy">{trouble}</div>}
        </div>
        <input
          ref={picker}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void addShot(file)
            e.target.value = ''
          }}
        />

        {imported && (
          <>
            <div className="ml-band">
              <span className="ml-band__label">MATCHED TO THE LIST</span>
              <span className="ml-band__meta">{matched.length}</span>
            </div>
            {/* A delivery is twenty-odd lines. The group bisects so the panel stays one screen and
                the questions below it are still reachable without a long scroll. */}
            <CutGroup rows={4} rowHeight={48} className="ml-band-shade">
              {matched.map((line) => (
                <div key={line.id} className="ml-row ml-kitchen__matchedrow">
                  <span className="ml-kitchen__shelfname">{line.proposedName ?? line.rawText}</span>
                  {/* Under the household's own name, the text it was actually read as. This is the
                      only evidence of what arrived, and what makes a wrong match arguable later. */}
                  <span className="ml-kitchen__readas">{line.rawText}</span>
                </div>
              ))}
            </CutGroup>

            {questions.length > 0 && (
              <>
                <div className="ml-band ml-band--amber">
                  <span className="ml-band__label">THESE NEED YOU</span>
                  <span className="ml-band__meta">{open.length}</span>
                </div>
                <div className="ml-band-shade">
                  {questions.map((line) => (
                    <ImportQuestion
                      key={line.id}
                      line={line}
                      chosen={answers.get(line.id)}
                      onChoose={(how) => setAnswers((prev) => new Map(prev).set(line.id, how))}
                    />
                  ))}
                </div>
              </>
            )}

            {/*
              Collapsed to one line, and added regardless. Improvised buys are most of what makes a
              real pantry differ from a planned one.
            */}
            {unasked.length > 0 && (
              <>
                <div className="ml-band ml-band--quiet">
                  <span className="ml-band__label">NOT ON THE LIST</span>
                  <span className="ml-band__meta">{unasked.length}</span>
                </div>
                <div className="ml-band-shade">
                  <div className="ml-kitchen__askwhy">
                    {unasked.length} {unasked.length === 1 ? 'thing' : 'things'} nobody put on the
                    list — still added.
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </ScrollArea>

      <div className="ml-kitchen__errandactions">
        {imported ? (
          <button
            type="button"
            className="ml-kitchen__shop"
            disabled={busy || going === 0}
            onClick={commit}
          >
            PUT {going} AWAY
            {open.length > 0 && ` · ${open.length} STILL OPEN`}
          </button>
        ) : (
          <button
            type="button"
            className="ml-kitchen__shop"
            disabled={busy || shots.length === 0}
            onClick={parse}
          >
            READ THESE IN
          </button>
        )}
      </div>
    </ScreenShell>
  )
}

/**
 * The two failure modes, as the shared card.
 *
 * A garbled line shows its characters verbatim rather than a tidied guess — `1L 0AT DR1NK BAR1STA`
 * is the fact, and cleaning it up would hide the one thing that tells somebody what went wrong.
 */
function ImportQuestion({
  line, chosen, onChoose,
}: {
  line: OrderImportLineDto
  chosen: Settlement | undefined
  onChoose: (how: Settlement) => void
}) {
  const garbled = line.confidence === 'Unreadable'
  const navigate = useNavigate()

  return (
    <DecisionCard
      item={garbled ? 'A line that came out wrong' : (line.proposedName ?? line.rawText)}
      kind={garbled ? "COULDN'T READ IT" : 'NOT WHAT WAS ASKED FOR'}
      leftLabel="YOU ORDERED"
      leftValue={line.proposedName ?? '—'}
      rightLabel={garbled ? 'IT CAME OUT AS' : 'THEY SENT'}
      rightValue={line.rawText}
      choices={garbled ? [
        { label: 'SKIP THEM', primary: chosen !== 'typed', onChoose: () => onChoose('skip') },
        {
          label: 'TYPE THEM IN',
          primary: chosen === 'typed',
          onChoose: () => { onChoose('typed'); navigate('/kitchen/pantry/add') },
        },
      ] : [
        // `SAME THING` writes an alias, which is what makes the next delivery match better rather
        // than asking the same question again.
        { label: 'SAME THING', primary: chosen !== 'separate', onChoose: () => onChoose('same') },
        { label: 'KEEP SEPARATE', primary: chosen === 'separate', onChoose: () => onChoose('separate') },
      ]}
    />
  )
}
