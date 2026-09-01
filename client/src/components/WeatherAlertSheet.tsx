import { useEffect, useRef } from 'react'
import { Icon } from '../icons/Icon'
import { readProduct } from '../app/weatherAlert'
import { clockLabel } from '../app/dates'
import type { ActiveAlertDto } from '../api/types'

interface WeatherAlertSheetProps {
  alert: ActiveAlertDto
  /** When the snapshot behind the screen was fetched — the last field of the provenance footer. */
  fetchedAtUtc?: string | null
  onClose: () => void
  /** Closes the sheet and switches the Weather segment to RADAR. Omitted where there is no radar to switch to. */
  onRadar?: () => void
}

/**
 * The NWS statement sheet (`design_handoff_weather_alert/ALERT_SHEET.md` §2).
 *
 * A bottom sheet over a scrim, in three bands: a fixed head naming the product, a scrolling body
 * holding the whole of what NWS said, and fixed actions. The 8px hazard stripe from the banner
 * repeats along its top edge so the amber reads as the same object the banner belongs to.
 *
 * Everything below the meta ledger is conditional. A Special Weather Statement has no tagged rows
 * and usually no precautions; a severe warning has both. Sections are omitted whole rather than
 * rendered empty — a labelled band with nothing under it reads as a failure to load.
 *
 * @category Status
 */
export function WeatherAlertSheet({ alert, fetchedAtUtc, onClose, onRadar }: WeatherAlertSheetProps) {
  const closeRef = useRef<HTMLButtonElement>(null)
  const product = readProduct(alert)
  const severe = alert.severity === 'Severe'

  // Escape closes, as the scrim and both buttons do. Bound to the document because the sheet can be
  // opened by a navigation rather than a tap, in which case nothing inside it has focus yet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // Move focus into the sheet on open. Without this a panel arriving here from the Dashboard banner
  // leaves focus on a button that is no longer on screen, and the first Escape goes nowhere.
  useEffect(() => {
    closeRef.current?.focus()
  }, [])

  const fetched = fetchedAtUtc ? new Date(fetchedAtUtc) : null
  const footer = [
    product.provenance,
    fetched && !Number.isNaN(fetched.getTime()) ? `fetched ${clockLabel(fetched)}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="ml-wxalert" role="dialog" aria-modal="true" aria-labelledby="ml-wxalert-title">
      <div className="ml-wxalert__scrim" onClick={onClose} aria-hidden="true" />
      <div className="ml-wxalert__sheet">
        <div className="ml-wxalert__stripe" aria-hidden="true" />

        <div className="ml-wxalert__head">
          <span className="ml-wxalert__glyph" aria-hidden="true">
            <Icon id="ico-alert" size="1.375rem" />
          </span>
          <div className="ml-wxalert__heading">
            <h2 className="ml-wxalert__title" id="ml-wxalert-title">
              {product.title}
            </h2>
            {product.issued && <p className="ml-wxalert__issued">{product.issued}</p>}
          </div>
          <button
            type="button"
            className="ml-wxalert__close"
            onClick={onClose}
            aria-label="Close alert"
            ref={closeRef}
          >
            ×
          </button>
        </div>

        <div className="ml-wxalert__body">
          <div className="ml-wxalert__meta">
            {product.inEffect && (
              <div className="ml-wxalert__metarow">
                <span className="ml-wxalert__metalabel">In effect</span>
                <span className="ml-wxalert__window serif">{product.inEffect}</span>
              </div>
            )}
            {product.severityLine && (
              <div className="ml-wxalert__metarow">
                <span className="ml-wxalert__metalabel">Severity</span>
                <span className={'ml-wxalert__severity' + (severe ? ' ml-wxalert__severity--severe' : '')}>
                  {product.severityLine}
                </span>
              </div>
            )}
            {product.counties && (
              <div className="ml-wxalert__metarow">
                <span className="ml-wxalert__metalabel">Counties</span>
                <span className="ml-wxalert__counties">{product.counties}</span>
              </div>
            )}
          </div>

          {product.tags.length > 0 && (
            <section className="ml-wxalert__section">
              <h3 className="ml-wxalert__seclabel ml-wxalert__seclabel--brass">The warning</h3>
              <div className="ml-wxalert__tags">
                {product.tags.map((tag) => (
                  <div key={tag.label} className="ml-wxalert__tag">
                    <span className="ml-wxalert__taglabel">{tag.label}</span>
                    <span className="ml-wxalert__tagtext">{tag.text}</span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {product.paragraphs.length > 0 && (
            <section className="ml-wxalert__section">
              <h3 className="ml-wxalert__seclabel ml-wxalert__seclabel--brass">What NWS says</h3>
              <div className="ml-wxalert__prose">
                {product.paragraphs.map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </div>
            </section>
          )}

          {product.precautions && (
            <section className="ml-wxalert__section">
              <h3 className="ml-wxalert__seclabel ml-wxalert__seclabel--amber">Precautions</h3>
              <div className="ml-wxalert__precautions">{product.precautions}</div>
            </section>
          )}

          {footer && (
            <p className="ml-wxalert__prov">
              <span className="ml-wxalert__provtick" aria-hidden="true" />
              {footer}
            </p>
          )}
        </div>

        <div className="ml-wxalert__actions">
          <button type="button" className="ml-wxalert__btn" onClick={onClose}>
            Close
          </button>
          {onRadar && (
            <button type="button" className="ml-wxalert__btn ml-wxalert__btn--brass" onClick={onRadar}>
              See radar
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
