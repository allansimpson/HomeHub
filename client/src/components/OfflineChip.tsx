/**
 * Dashboard header status chip. Last-known data stays visible behind it either way.
 *
 * <b>Two words, because they mean two different things.</b> `Reconnecting` promises something is in
 * progress and about to resolve — right for a deploy restart or a dropped packet. `Offline` is the
 * settled state a phone reaches when it has left the house, where nothing is in progress and
 * nothing is wrong. The dashboard is the one screen with no banner above it (it carries this chip
 * instead), so if the two disagreed, the home screen would be the only place still claiming to be
 * reconnecting while every other tab had admitted otherwise.
 *
 * `ConnectionProvider.offline` decides which, on the same timer the banner uses.
 *
 * @category Status
 */
export function OfflineChip({ offline = false }: { offline?: boolean }) {
  return (
    <div className={'ml-offline' + (offline ? ' ml-offline--settled' : '')}>
      <span className="ml-offline__dot" aria-hidden="true" />
      <span className="ml-offline__text">{offline ? 'Offline' : 'Reconnecting'}</span>
    </div>
  )
}
