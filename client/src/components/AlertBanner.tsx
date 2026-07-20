import { Icon } from '../icons/Icon'

interface AlertBannerProps {
  title: string
  detail?: string
  /** Severe adds the hazard-stripe treatment beneath the banner. */
  severe?: boolean
  /** Tapping navigates to the relevant screen. */
  onClick?: () => void
}

/**
 * Full-width amber alert banner with outlined "!" glyph. Severe alerts add an 8px hazard
 * stripe. Built once here and reused by sensor thresholds (Stage 2) and weather (Stage 3).
 */
export function AlertBanner({ title, detail, severe, onClick }: AlertBannerProps) {
  return (
    <div>
      <div
        className="ml-alert"
        onClick={onClick}
        role={onClick ? 'button' : undefined}
        tabIndex={onClick ? 0 : undefined}
      >
        <span className="ml-alert__glyph" aria-hidden="true">
          <Icon id="ico-alert" size="1.25rem" />
        </span>
        <div>
          <div className="ml-alert__title">{title}</div>
          {detail && <div className="ml-alert__detail">{detail}</div>}
        </div>
      </div>
      {severe && <div className="ml-alert__stripe" aria-hidden="true" />}
    </div>
  )
}
