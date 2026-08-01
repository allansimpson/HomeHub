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

      {/* BABY — feeding bottle (BABY_SECTION.md) */}
      <symbol id="ico-baby" viewBox="0 0 24 24">
        <path
          d="M10 2.5h4M9.6 5h4.8l.6 2H9zM8 7h8v12.5a2 2 0 01-2 2h-4a2 2 0 01-2-2zM8 11.5h3M8 15h3"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </symbol>
      {/* CAT — one continuous head outline: ear, brow, ear, jaw, plus two eye ticks.
          Whiskers, muzzle lines and separate ear triangles were tried and all smear at the nav's
          22px; a head outline with two eyes is the smallest thing that still reads as a cat.
          Do not add whiskers back (NAV_CAT_TAB.md). */}
      <symbol id="ico-litter" viewBox="0 0 24 24">
        <path
          d="M5 11V4l4.6 3.4a9 9 0 014.8 0L19 4v7a7 7 0 01-14 0zM9.6 11.6v.7M14.4 11.6v.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      {/* MEALS — "Diner Tin & Lip": a steaming pie, replacing the earlier butler cloche.
          Six segments in path order: the tin's full-width lip (the strongest "pie tin" signal, and
          deliberately wider than the tin body), a low elliptical crust dome (a taller one reads as
          a cloche again), the flared tin, then three steam curls with the centre one raised ~0.6 so
          they read as a group rather than a row.

          Coordinates are final and tuned to the sprite's 24×24 / stroke-1.5 deco geometry — do not
          re-centre, simplify, or run through an SVG optimiser that moves them. Default butt caps and
          mitre joins on purpose: the mitred corners are part of the deco language, which is why this
          carries no strokeLinecap (the cloche it replaces wrongly had round).

          22px in the nav, 26px in the COOK control, 17–22px in notices. Below ~18px the handoff says
          to drop the outer two curls and keep the centre one rather than scaling the whole glyph. */}
      <symbol id="ico-meals" viewBox="0 0 24 24">
        <path
          d="M4.5 13.5h15M6.5 13.5a5.5 3.6 0 0111 0M6 13.5l1.6 5h8.8l1.6-5M9 7.2c-.8-.85-.8-1.95 0-2.8M12 6.6c-.8-.85-.8-1.95 0-2.8M15 7.2c-.8-.85-.8-1.95 0-2.8"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </symbol>

      {/* PANTRY — a cupboard: outer case, two shelves, one divider (PANTRY_NAV.md). No fill, no
          curves, square corners — the same deco geometry as ico-meals and ico-list. */}
      <symbol id="ico-pantry" viewBox="0 0 24 24">
        <path d="M4 4h16v16H4zM4 10.5h16M4 15.5h16M12 4v6.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>

      {/* REFRESH — circular arrow; the clean-cycle control (LITTER_SECTION.md) */}
      <symbol id="ico-refresh" viewBox="0 0 24 24">
        <path
          d="M20 12a8 8 0 11-2.34-5.66M20 4v4h-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
      </symbol>

      {/* BELL — the notification badge in the dashboard header (NAV_CAT_TAB.md) */}
      <symbol id="ico-bell" viewBox="0 0 24 24">
        <path
          d="M6 9a6 6 0 1112 0v5l2 3H4l2-3zM10 20a2 2 0 004 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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

      {/* ---- Calendar marks (spec 14, exact paths) ----
          These carry no stroke-width: it is inherited from the <svg> the Icon renders, so the same
          symbol draws at 1.7 in the 13px month-grid cell and 1.4 in the agenda and the picker
          without a second copy of every path. Do not add stroke-width here — a presentation
          attribute on the path would win over the inherited value and pin all sizes to one weight. */}
      <symbol id="ico-mark-cake" viewBox="0 0 24 24">
        <path d="M4 21h16M5.5 21v-6.5h13V21M5.5 17.5h13M12 14.5v-3M12 11.5l1.4-1.6L12 8l-1.4 1.9z" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-medical" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" />
        <path d="M12 7.5v9M7.5 12h9" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-gift" viewBox="0 0 24 24">
        <path
          d="M3 9h18v4H3zM4.5 13v8h15v-8M12 9v12M12 9C10 9 7 8.6 7 6.5A2.5 2.5 0 0112 6a2.5 2.5 0 015 .5C17 8.6 14 9 12 9z"
          fill="none"
          stroke="currentColor"
        />
      </symbol>
      <symbol id="ico-mark-star" viewBox="0 0 24 24">
        <path d="M12 3.5l2.6 5.6 6 .8-4.4 4.2 1.1 6-5.3-3-5.3 3 1.1-6L3.4 9.9l6-.8z" fill="none" stroke="currentColor" strokeLinejoin="round" />
      </symbol>
      <symbol id="ico-mark-post" viewBox="0 0 24 24">
        <path d="M3 6h18v12H3zM3 6l9 7 9-7" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-school" viewBox="0 0 24 24">
        <path d="M2 9l10-4.5L22 9l-10 4.5zM6 11v5c0 1.6 2.7 3 6 3s6-1.4 6-3v-5" fill="none" stroke="currentColor" strokeLinejoin="round" />
      </symbol>
      <symbol id="ico-mark-work" viewBox="0 0 24 24">
        <path d="M3 8h18v11H3zM9 8V5h6v3M3 13h18" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-hours" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" />
        <path d="M12 7v5.3l3.4 2" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-house" viewBox="0 0 24 24">
        <path d="M4 20h16M7 20v-7h10v7M10 13V9h4v4M12 9V5" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-swim" viewBox="0 0 24 24">
        <circle cx="8" cy="7" r="2" fill="none" stroke="currentColor" />
        <path
          d="M3 14.5c2-1.6 3.6-1.6 5.6 0s3.6 1.6 5.6 0 3.6-1.6 5.6 0M3 19c2-1.6 3.6-1.6 5.6 0s3.6 1.6 5.6 0 3.6-1.6 5.6 0"
          fill="none"
          stroke="currentColor"
        />
      </symbol>
      <symbol id="ico-mark-sport" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" />
        <path d="M3.5 12h17M12 3.5c3 2.4 3 14.1 0 17M12 3.5c-3 2.4-3 14.1 0 17" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-music" viewBox="0 0 24 24">
        <path d="M9 18V5l10-2v13" fill="none" stroke="currentColor" />
        <circle cx="6.5" cy="18" r="2.5" fill="none" stroke="currentColor" />
        <circle cx="16.5" cy="16" r="2.5" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-dining" viewBox="0 0 24 24">
        <path d="M7 3v8a2 2 0 002 2v8M7 3v5M9.6 3v5M17 3c-1.5 1.2-2.2 3-2.2 5s.9 3 2.2 3v10" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-book" viewBox="0 0 24 24">
        <path d="M4 5.5A2.5 2.5 0 016.5 3H19v15H6.5A2.5 2.5 0 004 20.5zM6.5 18H19v3H6.5" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-errand" viewBox="0 0 24 24">
        <path d="M5 8h14l-1.2 12H6.2zM9 8V5.5a3 3 0 016 0V8" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-travel" viewBox="0 0 24 24">
        <path d="M3 16v-3l2.5-5h13l2.5 5v3zM3 16h18M6.5 16v2M17.5 16v2M6 12h12" fill="none" stroke="currentColor" />
      </symbol>
      <symbol id="ico-mark-pet" viewBox="0 0 24 24">
        <path
          d="M5 11V4l4.6 3.4a9 9 0 014.8 0L19 4v7a7 7 0 01-14 0zM9.6 11.6v.7M14.4 11.6v.7"
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      <symbol id="ico-mark-outdoors" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="4.5" fill="none" stroke="currentColor" />
        <path
          d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.2 5.2l2.1 2.1M16.7 16.7l2.1 2.1M18.8 5.2l-2.1 2.1M7.3 16.7l-2.1 2.1"
          fill="none"
          stroke="currentColor"
        />
      </symbol>
      <symbol id="ico-mark-deadline" viewBox="0 0 24 24">
        <path d="M6 21V4M6 4h12l-2.5 4L18 12H6" fill="none" stroke="currentColor" strokeLinejoin="round" />
      </symbol>
    </svg>
  )
}
