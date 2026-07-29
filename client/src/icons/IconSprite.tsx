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
      {/* Sign out — exact path from CONFIG_SCREEN.md §1 identity row */}
      <symbol id="ico-signout" viewBox="0 0 24 24">
        <path d="M16 17l5-5-5-5M21 12H9M12 3H5v18h7" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      {/*
        CONFIG — cog. BOTTOM_NAV.md §5 gives a `d` whose right-side vertices sit ~1u higher than
        their left-side mirrors, so it renders visibly lopsided. This is a 6-tooth cog drawn
        symmetrically about x=12 (outer r 9.1, root r 6.6, hub r 3.2).
      */}
      <symbol id="ico-gear" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          d="M9.29 3.31L14.71 3.31L14.68 5.97L15.88 6.66L18.17 5.31L20.88 10L18.56 11.31L18.56 12.69L20.88 14L18.17 18.69L15.88 17.34L14.68 18.03L14.71 20.69L9.29 20.69L9.32 18.03L8.12 17.34L5.83 18.69L3.12 14L5.44 12.69L5.44 11.31L3.12 10L5.83 5.31L8.12 6.66L9.32 5.97Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
      </symbol>

      {/* ---- CONFIG category glyphs — exact paths from CONFIG_SCREEN.md §1, stroke 1.4 ---- */}
      <symbol id="ico-list" viewBox="0 0 24 24">
        <rect x="4" y="5" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <rect x="4" y="15" width="4" height="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M11 7h9M11 17h9" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      <symbol id="ico-lock" viewBox="0 0 24 24">
        <rect x="5" y="11" width="14" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M8 11V7a4 4 0 018 0v4" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      <symbol id="ico-warning" viewBox="0 0 24 24">
        <path d="M12 3l9 16H3z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
        <path d="M12 10v4M12 17v.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      <symbol id="ico-display" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path
          d="M12 4v2M12 18v2M4 12h2M18 12h2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M6 18l1.5-1.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
        />
      </symbol>
      <symbol id="ico-group" viewBox="0 0 24 24">
        <circle cx="9" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3 20a6 6 0 0112 0M16 6a3 3 0 010 6M21 20a6 6 0 00-6-6" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      {/* Trash — delete a conversation (THE_ATTENDANT.md §5b), stroke 1.4 */}
      <symbol id="ico-trash" viewBox="0 0 24 24">
        <path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14" fill="none" stroke="currentColor" strokeWidth="1.4" />
      </symbol>
      {/* Search — magnifier (ACCOUNT_TODO_LISTS.md §5 search field) */}
      <symbol id="ico-search" viewBox="0 0 24 24">
        <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M20 20l-3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
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
