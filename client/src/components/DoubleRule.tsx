/** The double-rule motif under every screen header: brass bar + gap + hairline. */
export function DoubleRule() {
  return (
    <div className="ml-doublerule" aria-hidden="true">
      <div className="ml-doublerule__brass" />
      <div className="ml-doublerule__gap" />
      <div className="ml-doublerule__hair" />
    </div>
  )
}
