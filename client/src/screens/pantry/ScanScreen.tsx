import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { api } from '../../api/client'
import { HoldButton, UnitField } from '../../components'
import { usePantry } from '../../app/PantryProvider'
import { LOCATIONS, trimNumber } from '../../app/pantryDomain'
import { refreshUnits } from '../../app/units'
import type {
  PantryLocationName, ProductSuggestionDto, ScanResultDto, TrackingClassName,
} from '../../api/types'
import { AmountField, PantryLabel, PantryModal, PrimaryButton, SecondaryButton } from './parts'

/**
 * Scan into the pantry (PANTRY_SCREEN §3, id 9c) — a **phone** surface, not the panel's.
 *
 * 9a deliberately has no scan button: the panel is on a wall and the barcodes are in your hand.
 * This screen is reached by opening the panel's address on a phone, which is also why it has no
 * bottom nav.
 *
 * **Every scan writes immediately**; `DONE` only closes. The run list is the undo, which keeps the
 * loop at one tap per pack — the only speed that survives unpacking six bags (DECISIONS PG3).
 */
export function ScanScreen() {
  const navigate = useNavigate()
  const { scan } = usePantry()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [runId] = useState(() => crypto.randomUUID())
  const sequence = useRef(0)

  /**
   * Why the viewfinder is empty, when it is.
   *
   * Three failures, not one, because they need different sentences. `no-decoder` is the common case
   * on a desktop browser and on every iPhone: the camera is right there and works, but
   * `BarcodeDetector` is Chromium-only, so telling someone "no camera here" while their webcam light
   * is on would send them hunting for a hardware fault that doesn't exist. `insecure` is the case
   * that HTTPS fixes, and naming it is what makes the fix discoverable.
   */
  const [camera, setCamera] = useState<'idle' | 'live' | 'no-camera' | 'no-decoder' | 'insecure'>('idle')
  const [run, setRun] = useState<ScanRow[]>([])
  const [unmatched, setUnmatched] = useState<string | null>(null)
  const [suggestion, setSuggestion] = useState<ProductSuggestionDto | null>(null)
  const [naming, setNaming] = useState('')
  const [unit, setUnit] = useState('')
  const [packSize, setPackSize] = useState(1)
  const [location, setLocation] = useState<PantryLocationName>('Cupboard')
  const [tracking, setTracking] = useState<TrackingClassName>('Counted')

  /**
   * True while an unknown pack is waiting to be named.
   *
   * A ref rather than state because the detection loop closes over it: the camera decodes the same
   * barcode many times a second, and without this the naming card would be torn down and rebuilt
   * under the fingers of whoever is typing into it — and every one of those repeats would be
   * another request to Open Food Facts for a barcode it has already said it doesn't know.
   */
  const awaitingName = useRef(false)

  const record = useCallback(async (barcode: string, format: string | null) => {
    const seq = sequence.current++
    const result = await scan({ barcode, format, delta: 1, location, scanRunId: runId, sequence: seq })
    if (!result.matched) {
      // Not an error — a first-class row. Nothing was written, and naming it once teaches the
      // household catalogue so the next identical pack resolves (DECISIONS PG4).
      awaitingName.current = true
      setUnmatched(result.barcode)
      // A suggestion pre-fills the field; it decides nothing. Whatever is in the box when SAVE is
      // pressed is what the household gets, which is the point — the shelf says "Coke Zero" where
      // the database says "Coca-Cola Zero Sugar 355 ml".
      setSuggestion(result.suggestion)
      setNaming(result.suggestion?.name ?? '')
      setUnit(result.suggestion?.unit ?? '')
      // A pack with no stated size is one of whatever it is — one tin, one bag.
      setPackSize(result.suggestion?.packSize ?? 1)
      return
    }
    setUnmatched(null)
    setSuggestion(null)
    setRun((prev) => [{ ...toRow(result), sequence: seq }, ...prev])
  }, [scan, location, runId])

  // The Barcode Detection API is Chromium-only and needs a secure context. Where it is missing the
  // screen still works entirely through `TYPE ONE` — the camera is a shortcut, not the feature.
  useEffect(() => {
    const detectorCtor = (window as unknown as {
      BarcodeDetector?: new (opts: { formats: string[] }) => {
        detect: (source: CanvasImageSource) => Promise<{ rawValue: string; format: string }[]>
      }
    }).BarcodeDetector
    // Distinguished in this order because it is the order in which they can be fixed: an insecure
    // origin is a deployment problem with a known answer, a missing decoder is a browser choice
    // nobody here can change, and an absent camera is a device fact.
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCamera(window.isSecureContext ? 'no-camera' : 'insecure')
      return
    }
    if (!detectorCtor) {
      setCamera('no-decoder')
      return
    }

    let stream: MediaStream | null = null
    let raf = 0
    let stopped = false
    let lastCode = ''
    let lastAt = 0

    const detector = new detectorCtor({ formats: ['upc_a', 'upc_e', 'ean_8', 'ean_13'] })

    const loop = async () => {
      if (stopped || !videoRef.current) return
      // Hold everything while a pack is being named. The frames keep arriving; we simply stop
      // reading them until the question on screen has been answered.
      if (awaitingName.current) {
        raf = requestAnimationFrame(() => void loop())
        return
      }
      try {
        const hits = await detector.detect(videoRef.current)
        const hit = hits[0]
        // A barcode held in front of the lens decodes on every frame. Debounce on the value so one
        // pack counts once, but allow the same pack again after two seconds — scanning six
        // identical tins is exactly what unpacking looks like.
        if (hit && (hit.rawValue !== lastCode || Date.now() - lastAt > 2000)) {
          lastCode = hit.rawValue
          lastAt = Date.now()
          await record(hit.rawValue, hit.format)
        }
      } catch {
        // A frame that could not be read is normal; keep going.
      }
      if (!stopped) raf = requestAnimationFrame(() => void loop())
    }

    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) { s.getTracks().forEach((t) => t.stop()); return }
        stream = s
        if (videoRef.current) {
          videoRef.current.srcObject = s
          void videoRef.current.play()
        }
        setCamera('live')
        raf = requestAnimationFrame(() => void loop())
      })
      // Reached when the API exists but the stream doesn't: permission denied, or no camera on the
      // device. Either way there is nothing here to point at a barcode.
      .catch(() => setCamera('no-camera'))

    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [record])

  const nameIt = async () => {
    if (!unmatched || !naming.trim()) return
    // Whatever is in the box — typed, or a suggestion left as it came. Either way this is the
    // household's word for it from now on, and it is what the household catalogue records.
    await api.namePantryBarcode({
      barcode: unmatched,
      name: naming.trim(),
      unit: unit.trim() || null,
      location,
      tracking,
      // What the household settled on, not what the database said — they may well have corrected it.
      packSize: packSize > 0 ? packSize : null,
    })
    // The catalogue may have learned a unit as well as a name — offer it to the next pack.
    refreshUnits()
    const code = unmatched
    setUnmatched(null)
    setSuggestion(null)
    setNaming('')
    setUnit('')
    setPackSize(1)
    awaitingName.current = false
    // Re-scan it now that the catalogue knows: the pack in your hand should land on the run list
    // without you having to point the camera at it a second time.
    await record(code, null)
  }

  /** Give up on this pack and carry on scanning the rest of the bag. */
  const skipIt = () => {
    setUnmatched(null)
    setSuggestion(null)
    setNaming('')
    setUnit('')
    setPackSize(1)
    awaitingName.current = false
  }

  const undo = async (row: ScanRow) => {
    if (row.eventId == null) return
    await api.undoPantryEvent(row.eventId)
    setRun((prev) => prev.filter((r) => r.sequence !== row.sequence))
  }

  return (
    <PantryModal
      back={() => navigate('/meals/pantry')}
      backLabel="CLOSE"
      title="SCAN IN"
      meta="PHONE"
      footer={
        <div className="pt-modal__foot">
          <div className="pt-footer__row">
            <PrimaryButton grow={2.2} onClick={() => navigate('/meals/pantry')}>DONE</PrimaryButton>
            <SecondaryButton onClick={() => navigate('/meals/pantry?add=1')}>TYPE ONE</SecondaryButton>
          </div>
        </div>
      }
    >
      <div className="pt-viewfinder">
        <video ref={videoRef} className="pt-viewfinder__video" muted playsInline />
        {camera !== 'live' && (
          <span className="pt-viewfinder__idle">
            {camera === 'idle' && <>CAMERA<br />POINT AT THE BARCODE ON THE PACK</>}
            {camera === 'no-camera' && <>NO CAMERA HERE<br />USE TYPE ONE BELOW</>}
            {camera === 'no-decoder' && <>THIS BROWSER CAN&rsquo;T READ BARCODES<br />USE TYPE ONE BELOW</>}
            {/* Named precisely, because the fix is a real and findable one. */}
            {camera === 'insecure' && <>NEEDS HTTPS FOR THE CAMERA<br />USE TYPE ONE BELOW</>}
          </span>
        )}
        <span className="pt-viewfinder__tick pt-viewfinder__tick--tl" aria-hidden="true" />
        <span className="pt-viewfinder__tick pt-viewfinder__tick--tr" aria-hidden="true" />
        <span className="pt-viewfinder__tick pt-viewfinder__tick--bl" aria-hidden="true" />
        <span className="pt-viewfinder__tick pt-viewfinder__tick--br" aria-hidden="true" />
      </div>

      <div className="pt-chips pt-chips--scan">
        {LOCATIONS.map((loc) => (
          <button
            type="button"
            key={loc}
            className={'pt-chip' + (location === loc ? ' pt-chip--on' : '')}
            onClick={() => setLocation(loc)}
          >
            {loc.toUpperCase()}
          </button>
        ))}
      </div>

      {unmatched && (
        <div className="pt-unmatched">
          <span className="pt-unmatched__code">{unmatched}</span>
          <span className="pt-unmatched__what">
            {suggestion ? 'Not on your shelves yet' : 'Not in the catalogue'}
          </span>
          <input
            className="pt-field__input"
            value={naming}
            placeholder="What is it?"
            autoFocus
            onChange={(e) => setNaming(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void nameIt() }}
          />
          {/* Attribution, not decoration. The box is pre-filled with somebody else's words and the
              household is about to adopt them as its own — it should be able to see that, and the
              brand is often the bit worth keeping when the rest gets shortened. */}
          {suggestion && (
            <span className="pt-unmatched__from">
              {`Suggested by ${suggestion.source}`}
              {/* The brand is named only when the box does not already say it. The server now leads
                  the suggested name with the brand where it adds something, so repeating it here
                  would read as two different claims about the same pack. */}
              {suggestion.brand && !naming.toLowerCase().includes(suggestion.brand.toLowerCase())
                ? ` · ${suggestion.brand}`
                : ''}
              {' · edit it to whatever you call it'}
            </span>
          )}
          {/* How much one pack is. Pre-filled from the lookup — a 500 g bag of walnuts arrives as
              500 g — and settled here, once, rather than corrected afterwards a tap at a time.
              Every later scan of this barcode adds this much. */}
          <span className="pt-unmatched__label">ONE PACK IS</span>
          <div className="pt-amount">
            <AmountField value={packSize} onChange={setPackSize} label="One pack is" />
            <UnitField
              className="pt-amount__unit"
              value={unit}
              placeholder="tins"
              label="One pack is, unit"
              onChange={setUnit}
            />
          </div>
          <div className="pt-chips">
            {(['Counted', 'Estimated', 'NotCounted'] as TrackingClassName[]).map((t) => (
              <button
                type="button"
                key={t}
                className={'pt-chip' + (tracking === t ? ' pt-chip--on' : '')}
                onClick={() => setTracking(t)}
              >
                {t === 'NotCounted' ? 'STAPLE' : t.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="pt-unmatched__actions">
            {/* Skipping matters on a delivery: one pack nobody can name must not stop the other
                twenty-three from being put away. */}
            <button type="button" className="pt-unmatched__skip" onClick={skipIt}>SKIP IT</button>
            <button type="button" className="pt-nameit" onClick={() => void nameIt()} disabled={!naming.trim()}>
              NAME IT
            </button>
          </div>
        </div>
      )}

      {/* The meta names the gesture, not just the capability. "UNDO ANY" alone reads as an
          invitation to tap, which is exactly the mistake that made this a hold in the first place. */}
      <PantryLabel
        label="THIS RUN"
        meta={run.length === 0
          ? '0 THINGS'
          : `${run.length} THING${run.length === 1 ? '' : 'S'} · HOLD TO UNDO`}
      />
      {run.length === 0 ? (
        <p className="pt-group__empty">Scans land here</p>
      ) : (
        run.map((row) => (
          /*
            Hold, not tap — PANTRY_SCREEN §3.5 asks for swipe or long-press, and a tap was both a
            deviation and the wrong gesture. This list is a receipt of what went on the shelf, so
            everything in it is meant to be there; the one thing a stray touch must never do is
            quietly take a row back out while somebody is looking at the next pack.
          */
          <HoldButton
            key={row.sequence}
            className="pt-runrow"
            ms={700}
            label={`Hold to undo ${row.name}`}
            onHold={() => void undo(row)}
            progressTrack
          >
            <span className="pt-runrow__name">{row.name}</span>
            <span className="pt-runrow__count">{row.count}</span>
            <span className="pt-runrow__loc">{row.location}</span>
          </HoldButton>
        ))
      )}
    </PantryModal>
  )
}

interface ScanRow {
  sequence: number
  eventId: number | null
  name: string
  count: string
  location: string
}

function toRow(result: ScanResultDto): Omit<ScanRow, 'sequence'> {
  return {
    eventId: result.eventId,
    name: result.item?.name ?? result.barcode,
    count: result.item?.quantity != null ? trimNumber(result.item.quantity) : '—',
    location: (result.item?.location ?? '').toUpperCase(),
  }
}
