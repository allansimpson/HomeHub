import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { DrillInHeader, EmptyState, ScreenShell, ScrollArea, SectionLabel } from '../components'
import { useNotifications, ALL_SOURCES, SOURCE_LABELS } from '../app/NotificationsProvider'
import type { AppNotification } from '../app/NotificationsProvider'

type Tab = 'all' | 'wants-you' | 'today'

const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'wants-you', label: 'Wants you' },
  { key: 'today', label: 'Today' },
]

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString()
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  if (isToday(iso)) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })
}

/**
 * The inbox — the seven-day record, reached from Account.
 *
 * The same queue as the live cards and the drawer; only the grouping differs. Cards ask "is
 * something arriving", the drawer asks "is anything waiting", and this asks "what have we been
 * told" — so it groups by day rather than by severity.
 */
export function NotificationsScreen() {
  const navigate = useNavigate()
  const { all, sources, loading, markRead, clearAll, setSource } = useNotifications()
  const [tab, setTab] = useState<Tab>('all')

  const rows = useMemo(() => {
    if (tab === 'wants-you') return all.filter((n) => n.severity === 'wants-you')
    if (tab === 'today') return all.filter((n) => isToday(n.atUtc))
    return all
  }, [all, tab])

  // Grouped by day, newest first.
  const groups = useMemo(() => {
    const byDay = new Map<string, AppNotification[]>()
    for (const n of rows) {
      const key = dayLabel(n.atUtc)
      const list = byDay.get(key)
      if (list) list.push(n)
      else byDay.set(key, [n])
    }
    return [...byDay.entries()]
  }, [rows])

  const header = (
    <DrillInHeader title="Notifications" onBack={() => navigate('/settings')} />
  )

  return (
    <ScreenShell header={header}>
      <ScrollArea>
        <div className="ml-tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={'ml-tabs__tab' + (t.key === tab ? ' ml-tabs__tab--active' : '')}
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {!loading && rows.length === 0 && (
          <EmptyState
            label="Nothing here"
            hint={tab === 'all' ? 'Nothing has been recorded in the last seven days.' : 'Nothing in this view.'}
          />
        )}

        {groups.map(([day, items]) => (
          <div key={day}>
            {/* The first group is unlabelled when it is today's — the tab already says so. */}
            {day !== 'Today' && <SectionLabel label={day} status={`${items.length}`} />}
            {items.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`ml-notirow ml-notirow--${n.accent}`}
                onClick={() => {
                  void markRead(n.id)
                  if (n.route) navigate(n.route)
                }}
              >
                <span className="ml-notirow__rail" aria-hidden="true" />
                <span className="ml-notirow__body">
                  <span className="ml-notirow__head">
                    <span className="ml-notirow__source">{n.label}</span>
                    <span className="ml-notirow__time">{clock(n.atUtc)}</span>
                  </span>
                  <span className="ml-notirow__headline">{n.headline}</span>
                  {n.meta && <span className="ml-notirow__meta">{n.meta}</span>}
                </span>
              </button>
            ))}
          </div>
        ))}

        {/* This *is* the settings surface — there is no screen behind it, and so no "WHAT NOTIFIES ▸"
            link either: a link pointing at content a few hundred pixels above itself is a dead
            affordance. */}
        <SectionLabel label="What notifies" status={`${ALL_SOURCES.length} sources`} />
        <div className="ml-sourcechips">
          {ALL_SOURCES.map((s) => {
            const on = sources[s] ?? false
            return (
              <button
                key={s}
                type="button"
                className={'ml-sourcechip' + (on ? ' ml-sourcechip--on' : '')}
                onClick={() => void setSource(s, !on)}
                aria-pressed={on}
              >
                <span className="ml-sourcechip__dot" aria-hidden="true" />
                {SOURCE_LABELS[s]}
              </button>
            )
          })}
        </div>

        {/* Deliberately not labelled with a count: the count depends on the active tab, and a
            hardcoded number contradicts what is on screen. */}
        <div className="ml-clearbar">
          <button type="button" className="ml-clearbar__btn" onClick={() => void clearAll()}>
            Clear the list
          </button>
        </div>

        <div className="ml-litter__footer">
          <span className="ml-litter__footnote">
            Nothing is kept past seven days · clearing a notification is not undoing what it reported
          </span>
        </div>
      </ScrollArea>
    </ScreenShell>
  )
}
