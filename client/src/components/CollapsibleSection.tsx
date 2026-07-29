import { useEffect, useState, type ReactNode } from 'react'
import { Icon } from '../icons/Icon'

const key = (id: string) => `homehub.section.${id}`

interface CollapsibleSectionProps {
  /** Stable id — the open/closed state persists per id in localStorage. */
  id: string
  label: string
  status?: ReactNode
  statusLive?: boolean
  children: ReactNode
}

/**
 * A SectionLabel that toggles its content open/closed, remembering the state per id. Used to keep
 * long screens (Settings / Account) organized. Header markup matches {@link SectionLabel}.
 */
export function CollapsibleSection({ id, label, status, statusLive, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(() => localStorage.getItem(key(id)) !== 'false')
  useEffect(() => localStorage.setItem(key(id), String(open)), [id, open])

  return (
    <>
      <button
        type="button"
        className={'ml-section ml-section--toggle' + (open ? ' ml-section--open' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="ml-section__tick" aria-hidden="true" />
        <span className="ml-section__label">{label}</span>
        {status !== undefined && (
          <span className={`ml-section__status${statusLive ? ' ml-section__status--live' : ''}`}>{status}</span>
        )}
        <span className="ml-section__chevron" aria-hidden="true">
          <Icon id="ico-chevron-down" size="1rem" />
        </span>
      </button>
      {open && children}
    </>
  )
}
