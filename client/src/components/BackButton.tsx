import { Icon } from '../icons/Icon'

interface BackButtonProps {
  onClick: () => void
  label?: string
}

/** 44×44 ◂ back affordance, top-left of every drill-in screen. */
export function BackButton({ onClick, label = 'Back' }: BackButtonProps) {
  return (
    <button className="ml-backbtn" onClick={onClick} aria-label={label} type="button">
      <Icon id="ico-back" size="1.5rem" />
    </button>
  )
}
