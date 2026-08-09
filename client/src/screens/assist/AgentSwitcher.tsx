import { useEffect, useRef } from 'react'
import { Icon } from '../../icons/Icon'
import type { Agent } from '../../api/types'

interface Props {
  agents: Agent[]
  activeKey: string | null
  onSelect: (key: string) => void
  onDismiss: () => void
}

/**
 * The agent dropdown (ASSIST.md · `1d`).
 *
 * Anchored under the header rule rather than centred, because it belongs to the name it drops from —
 * a centred sheet would read as a modal about the whole screen, and this changes one thing.
 *
 * Inactive rows keep their unread badge. That is the reason the badge also rides the header chevron:
 * an unread count you can only see *after* switching is a count that told you nothing.
 *
 * Rendered only at two or more agents. With one, the header is the name alone — no chevron, no
 * badge, no tap target — so this component never mounts and there is nothing to disable.
 *
 * @category Structure
 */
export function AgentSwitcher({ agents, activeKey, onSelect, onDismiss }: Props) {
  const panelRef = useRef<HTMLDivElement>(null)

  // Escape closes. A wall panel has no keyboard most of the time, but the same screen is opened from
  // a phone and a laptop, and a dropdown that traps focus with no way out is a bug on both.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDismiss])

  useEffect(() => { panelRef.current?.focus() }, [])

  return (
    <div className="ml-agentmenu">
      <button type="button" className="ml-agentmenu__scrim" aria-label="Dismiss" onClick={onDismiss} />
      <div className="ml-agentmenu__panel" ref={panelRef} tabIndex={-1} role="menu" aria-label="Your agents">
        <div className="ml-agentmenu__label">Your agents</div>

        {agents.map((a) => {
          const active = a.key === activeKey
          return (
            <button
              key={a.key}
              type="button"
              role="menuitemradio"
              aria-checked={active}
              className={'ml-agentmenu__row' + (active ? ' ml-agentmenu__row--active' : '')}
              onClick={() => { if (!active) onSelect(a.key); onDismiss() }}
            >
              <span className="ml-agentmenu__main">
                <span className="serif ml-agentmenu__name">{a.name}</span>
                <span className="ml-agentmenu__tagline">
                  {a.tagline ?? (a.configured ? '' : 'Not configured on this panel')}
                </span>
              </span>
              {active ? (
                <Icon id="ico-check" size="1.125rem" />
              ) : a.unread > 0 ? (
                <span className="ml-agentmenu__badge">
                  {a.unread}
                  <span className="ml-visually-hidden"> unread</span>
                </span>
              ) : null}
            </button>
          )
        })}

        {/* Says what switching actually does. Without it the switch reads as a filter, and somebody
            eventually asks the wrong agent to remember what they told the other one. */}
        <div className="ml-agentmenu__note">
          Each agent keeps its own chats, memory and skills. Assignment is per member, in Config.
        </div>
      </div>
    </div>
  )
}
