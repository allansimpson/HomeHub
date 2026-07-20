/** Dashboard header status chip shown while reconnecting. Last-known data stays visible. */
export function OfflineChip() {
  return (
    <div className="ml-offline">
      <span className="ml-offline__dot" aria-hidden="true" />
      <span className="ml-offline__text">Reconnecting</span>
    </div>
  )
}
