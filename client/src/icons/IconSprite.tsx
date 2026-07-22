/*
 * Inline SVG sprite — rendered once at the app root. All icons follow the deco line style:
 * 24×24 viewBox, stroke=currentColor, stroke-width 1.5, no fill. The five nav symbols come
 * from the design handoff's icons.svg; the remaining glyphs (back, add, steppers, check,
 * delete, alert, chevrons, stop) follow the same geometry per the design system.
 */
export function IconSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ display: 'none' }} aria-hidden="true">
      {/* ---- Nav icons (from handoff icons.svg) ---- */}
      <symbol id="ico-home" viewBox="0 0 24 24">
        <path d="M4 20h16M7 20v-7h10v7M10 13V9h4v4M12 9V5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-calendar" viewBox="0 0 24 24">
        <path d="M5 7h14v13H5zM5 11h14M9 4v4M15 4v4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-climate" viewBox="0 0 24 24">
        <path d="M4 9l4 3 4-3 4 3 4-3M4 15l4 3 4-3 4 3 4-3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-weather" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </symbol>
      <symbol id="ico-assist" viewBox="0 0 24 24">
        <path d="M9 4h6v8a3 3 0 01-6 0zM6 11a6 6 0 0012 0M12 17v4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      {/* TODO — checklist (two check-boxes + lines), distinct from the ✓ done mark (handoff icons.svg) */}
      <symbol id="ico-todo" viewBox="0 0 24 24">
        <path d="M4 6h4v4H4zM4 14h4v4H4zM11 8h9M11 16h9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>

      {/* Account glyphs (person + sign in/out doorframes) */}
      <symbol id="ico-person" viewBox="0 0 24 24">
        <circle cx="12" cy="8.5" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path d="M5.5 19a6.5 6.5 0 0113 0" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-signin" viewBox="0 0 24 24">
        <path d="M13 4h5v16h-5M4 12h9M9.5 8l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-signout" viewBox="0 0 24 24">
        <path d="M11 4H6v16h5M10 12h10M16 8l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>

      {/* ---- Deco glyphs (same geometric line style) ---- */}
      <symbol id="ico-back" viewBox="0 0 24 24">
        <path d="M14 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-add" viewBox="0 0 24 24">
        <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-minus" viewBox="0 0 24 24">
        <path d="M5 12h14" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-check" viewBox="0 0 24 24">
        <path d="M5 12l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-delete" viewBox="0 0 24 24">
        <path d="M9 5h11v14H9l-6-7zM12 9l5 6M17 9l-5 6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-alert" viewBox="0 0 24 24">
        <path d="M12 5v9M12 17.5v1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-chevron-right" viewBox="0 0 24 24">
        <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-chevron-down" viewBox="0 0 24 24">
        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="ico-stop" viewBox="0 0 24 24">
        <path d="M6 6h12v12H6z" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
    </svg>
  )
}
