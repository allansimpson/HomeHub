import { Icon } from '../icons/Icon'

interface AlertBannerProps {
  title: string
  detail?: string
  /** Severe adds the hazard-stripe treatment beneath the banner. */
  severe?: boolean
  /** Tapping navigates to the relevant screen, or opens the statement sheet. */
  onClick?: () => void
}

/**
 * Full-width amber alert banner with outlined "!" glyph. Severe alerts add an 8px hazard
 * stripe. Built once here and reused by sensor thresholds (Stage 2) and weather (Stage 3).
 *
 * @category Status
 */
export function AlertBanner({ title, detail, severe, onClick }: AlertBannerProps) {
  return (
    <div>
      <div
        className={'ml-alert' + (onClick ? ' ml-alert--tap' : '')}
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
        // A div with role=button gets no key handling for free, and the banner is the whole hit
        // target, so the keyboard needs both keys the platform would have given a real button.
        onKeyDown={
          onClick
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onClick()
                }
              }
            : undefined
        }
      >
        <span className="ml-alert__glyph" aria-hidden="true">
          <Icon id="ico-alert" size="1.25rem" />
        </span>
        <div className="ml-alert__text">
          <div className="ml-alert__title">{title}</div>
          {detail && <div className="ml-alert__detail">{detail}</div>}
        </div>
      </div>
      {severe && <div className="ml-alert__stripe" aria-hidden="true" />}
    </div>
  )
}
