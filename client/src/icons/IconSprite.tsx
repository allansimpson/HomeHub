/*
 * Inline SVG sprite — rendered once at the app root. All icons follow the deco line style:
 * 24×24 viewBox, stroke=currentColor, stroke-width 1.5, no fill.
 *
 * The nine section glyphs below are **Icons v2** (ICONS.md), drawn for the seven-tab bar: stroke
 * 1.5 with round caps and joins throughout, read at 25px from across a room. They replaced the
 * earlier set wholesale when the bar went from ten tabs to seven; `ico-baby`, `ico-litter` and
 * `ico-pantry` went with the tabs they named. The remaining glyphs (back, add, steppers, check,
 * delete, alert, chevrons, stop) and the `ico-mark-*` calendar set are a different vocabulary with
 * their own stroke-width convention — leave them alone. `ico-copy` joined that second group when the
 * transcript's copy control stopped being the word COPY.
 */
export function IconSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ display: 'none' }} aria-hidden="true">
      {/* ---- Section glyphs (Icons v2 — ICONS.md / icons/*.svg) ---- */}
      {/* HOME — gabled roofline over two free-standing wall posts. */}
      <symbol id="ico-home" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.2 12.6 12 5.4l8.8 7.2M6.2 10.1v9.5M17.8 10.1v9.5" />
      </symbol>
      {/* CALENDAR — rounded rectangle, header rule, two binding posts above. */}
      <symbol id="ico-calendar" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4.4" y="6.4" width="15.2" height="13.2" rx="1.4" />
        <path d="M4.4 10.6h15.2M8.6 4.4v4M15.4 4.4v4" />
      </symbol>
      {/* MEALS — pie: shallow crust, fluted rim, tapered dish, three steam curls. */}
      <symbol id="ico-meals" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 15.5c1.4-3.5 4.8-5.3 9-5.3s7.6 1.8 9 5.3" />
        <path d="M3.4 15.6c.36-.6 1.07-.6 1.43 0s1.07.6 1.43 0 1.07-.6 1.43 0 1.07.6 1.43 0 1.07-.6 1.43 0 1.07.6 1.43 0 1.07-.6 1.43 0 1.07.6 1.43 0 1.07-.6 1.43 0 1.07.6 1.43 0 1.07-.6 1.43 0 1.07.6 1.43 0" />
        <path d="M3.9 16.2l1.4 3.3a1.3 1.3 0 001.2.8h11a1.3 1.3 0 001.2-.8l1.4-3.3" />
        <path d="M9.4 4c.55.65.55 1.25 0 1.9s-.55 1.25 0 1.9M12.2 2.6c.6.65.6 1.25 0 1.85s-.6 1.2 0 1.85.6 1.2 0 1.85M15 4c.55.65.55 1.25 0 1.9s-.55 1.25 0 1.9" />
      </symbol>
      {/* CARE — open hand: three free-standing fingers, thumb hooked at the wrist, palm sweeping
          into the pinky. One glyph for both subjects: the section is the caring, not the species. */}
      <symbol id="ico-care" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.4 14.6 6.15 11.3A1.15 1.15 0 005.25 13L7.5 18.2C7.9 19.9 9.4 21.3 11.2 21.3H15.2C17.2 21.3 18.7 19.7 18.7 17.7V7.3" />
        <path d="M10.3 4.4v6.6M13.1 2.6v7.8M15.9 4.4v7.1" />
      </symbol>
      {/* CLIMATE — three full-width waves of moving air. */}
      <symbol id="ico-climate" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.4 8.4c2.9-2 5.8 2 8.7 0s5.8 2 8.7 0M3.4 12.6c2.9-2 5.8 2 8.7 0s5.8 2 8.7 0M3.4 16.8c2.9-2 5.8 2 8.7 0s5.8 2 8.7 0" />
      </symbol>
      {/* WEATHER — sun: circle with eight detached rays. */}
      <symbol id="ico-weather" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
      </symbol>
      {/* TODO — a bare checkmark. The old two-box checklist smeared at nav size. */}
      <symbol id="ico-todo" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 13.2 9.6 18.4 19.5 6.2" />
      </symbol>
      {/* ASSIST — capsule microphone in a cradling arc, stem and base. Off the bar: the Dashboard
          block and the overlay header. */}
      <symbol id="ico-assist" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9.4" y="3" width="5.2" height="10.4" rx="2.6" />
        <path d="M6 11.6a6 6 0 0012 0M12 17.6v3.2M8.6 20.8h6.8" />
      </symbol>

      {/* ---- Care log-tile glyphs ----
          Not part of the Icons v2 sheet. CARE.md specifies a 26px glyph at stroke 1.4 on every log
          tile but ships no artwork for them, so these are drawn to the same deco geometry as the
          section set: 24×24, no fill, round caps and joins. The bottle is the old `ico-baby` path,
          which outlived the tab it was named for. */}
      <symbol id="ico-bottle" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 2.5h4M9.6 5h4.8l.6 2H9zM8 7h8v12.5a2 2 0 01-2 2h-4a2 2 0 01-2-2zM8 11.5h3M8 15h3" />
      </symbol>
      {/* DIAPER — the folded nappy: waistband, the two tapering wings, and the leg curve. */}
      <symbol id="ico-diaper" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.6 6.4h16.8v3.2c0 5.6-3.6 10-8.4 10s-8.4-4.4-8.4-10z" />
        <path d="M8.6 9.6c1.2 1.6 5.6 1.6 6.8 0" />
      </symbol>
      {/*
        BREAST — the one icon in the Care package that is final artwork, not a placeholder.

        Copied verbatim from `design_handoff_care_logging/assets/icon-breast.svg`: drawn from a
        reference the household supplied and approved over five alternatives, with the handoff
        saying in as many words to use that path rather than substitute from an icon set. It
        replaced a clock dial, which was the honest stand-in while the tile had no artwork.

        Three things the handoff asks be preserved, all of them load-bearing at 24px:
        the crease is an **open** path and must not close into a circle; the areola and nipple are
        concentric on 11.6 / 12.4 rather than centred in the viewBox; and their 0.95 stroke against
        the crease's 1.4 is what keeps the centre from filling in. Hence the stroke widths here
        differ from the 1.5 the drawn-to-match icons around it use — do not normalise them.
      */}
      <symbol id="ico-breast" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16.8 3.2c3.4 4 4.2 8.8 2.2 12.4-2.2 4-7 6-11.4 4.4-2.6-1-3.8-3.6-3.6-7" />
        <circle strokeWidth="0.95" cx="11.6" cy="12.4" r="2.1" />
        <circle strokeWidth="0.95" cx="11.6" cy="12.4" r="0.8" />
      </symbol>

      {/*
        The other seven log tiles.

        The handoff calls its own tile icons "placeholders drawn to the right weight, not final
        artwork" and says to substitute the panel's set where it has the concept. It had three of
        the ten, so these are drawn to the same geometry as the bottle and the nappy above — 24×24,
        1.5 stroke, round caps — rather than lifted from the design file at a different weight.
      */}
      {/* PUMP — the flange, which is the part of a pump anybody would recognise in outline. */}
      <symbol id="ico-pump" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.5 4h11l-4.2 6.1v8.4a1.3 1.3 0 01-2.6 0v-8.4z" />
        <path d="M9.8 21h4.4" />
      </symbol>
      {/* SOLIDS — a bowl with two wisps. Not a spoon: a spoon at 24px is a stick with a dot. */}
      <symbol id="ico-solids" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4.5 12.6h15c0 4.1-3.4 7.4-7.5 7.4s-7.5-3.3-7.5-7.4z" />
        <path d="M9.6 9.2c0-1.3 1.1-1.5 1.1-2.8M13.4 9.2c0-1.3 1.1-1.5 1.1-2.8" />
      </symbol>
      {/* SLEEP — the crescent. */}
      <symbol id="ico-sleep" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 14.6A8.6 8.6 0 019.4 4 8.6 8.6 0 1020 14.6z" />
      </symbol>
      {/* MEDICINE — a dose, drawn as the drop it is measured in. */}
      <symbol id="ico-medicine" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 3.2c0 0 5.4 5.9 5.4 9.4a5.4 5.4 0 11-10.8 0C6.6 9.1 12 3.2 12 3.2z" />
        <path d="M12 16.8a3.2 3.2 0 01-3.2-3.2" />
      </symbol>
      {/* BATH — the tub, tap and feet. */}
      <symbol id="ico-bath" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3.5 12.6h17v2.2a5 5 0 01-5 5h-7a5 5 0 01-5-5z" />
        <path d="M7.4 12.6V6.3a1.9 1.9 0 011.9-1.9h.7" />
        <path d="M7.2 19.8l-1 1.7M16.8 19.8l1 1.7" />
      </symbol>
      {/* TUMMY TIME — prone, propped, on the floor. The ground line is what makes it read as
          face-down rather than as a person standing beside a rule. */}
      <symbol id="ico-tummytime" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7.6" cy="10.6" r="2.4" />
        <path d="M10.2 12.9c2.8 1.6 5.9 2.6 9.3 2.8" />
        <path d="M9.2 13.8L7.4 18.6" />
        <path d="M4.5 18.6h15" />
      </symbol>
      {/* TEMPERATURE — bulb thermometer with two graduations. */}
      <symbol id="ico-temperature" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M13.9 14.2V5.4a1.9 1.9 0 10-3.8 0v8.8a3.7 3.7 0 103.8 0z" />
        <path d="M15.8 7.6h-1.9M15.8 10.4h-1.9" />
      </symbol>

      {/*
        The two bar glyphs from the CARE split (design_handoff_baby_devices/NAV.md).

        Copied verbatim from the handoff — 24 × 24, 1.5 stroke, round caps, square corners so they
        sit with the calendar and the cog rather than against them. The open hand that CARE used and
        the three waves CLIMATE used are kept below as **reserved**: out of the bar, still in the
        pack, because either may return.
      */}
      {/* BABY — upright bottle: domed teat, ringed collar, two measure ticks. */}
      <symbol id="ico-baby" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.8 6.1V4.5a2.2 2.2 0 014.4 0v1.6" />
        <rect x="8.3" y="6.1" width="7.4" height="2" />
        <rect x="7.6" y="8.1" width="8.8" height="13.3" rx="1.6" />
        <path d="M9.8 12.2h2.4M9.8 15.6h2.4" />
      </symbol>
      {/* DEVICES — two stacked units, each with a status lamp at its left edge. */}
      <symbol id="ico-devices" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3.6" y="4.4" width="16.8" height="6.6" />
        <rect x="3.6" y="13" width="16.8" height="6.6" />
        <circle cx="7.1" cy="7.7" r="0.9" />
        <circle cx="7.1" cy="16.3" r="0.9" />
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

      {/* ---- Attach sources (Assistant Explorations · Turn 4b) ----
          The three rows of the composer's attach menu, drawn to the geometry the design specifies
          rather than to the Icons v2 sheet: square corners, mitred joins, no round caps. They read as
          objects — a picture, a camera, a sheet of paper — where the section glyphs read as places. */}
      {/* A PHOTO — a framed picture with a horizon and two peaks. */}
      <symbol id="ico-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" />
        <path d="M3 16l5-5 4 4 3-3 6 6" />
      </symbol>
      {/* TAKE A PICTURE — a camera body with its viewfinder hump and a lens. */}
      <symbol id="ico-camera" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M3 7h4l2-2h6l2 2h4v13H3z" />
        <circle cx="12" cy="13" r="3.6" />
      </symbol>
      {/* A FILE — a sheet with its corner turned. */}
      <symbol id="ico-file" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <path d="M5 3h9l5 5v13H5z" />
        <path d="M14 3v5h5" />
      </symbol>
      {/* CONFIG — cog: square lugs around a hub, centre circle detached (Icons v2). Drawn
          symmetrically about x=12. Not a corner control: the account avatar is the one mark in that
          corner and it already opens `/settings`. This is the Config *category* glyph. */}
      <symbol id="ico-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M10.4 2.6h3.2l.5 2.1 1.6.7 1.8-1.2 2.3 2.3-1.2 1.8.7 1.6 2.1.5v3.2l-2.1.5-.7 1.6 1.2 1.8-2.3 2.3-1.8-1.2-1.6.7-.5 2.1h-3.2l-.5-2.1-1.6-.7-1.8 1.2-2.3-2.3 1.2-1.8-.7-1.6-2.1-.5v-3.2l2.1-.5.7-1.6-1.2-1.8 2.3-2.3 1.8 1.2 1.6-.7z" />
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
      {/* Archive — lidded box with the arrow going in (ASSIST.md · swipe left), stroke 1.4. Reads
          as filing rather than discarding, which is the whole distinction the gesture rests on. */}
      <symbol id="ico-archive" viewBox="0 0 24 24">
        <path
          d="M3.5 5h17v4h-17zM5.5 9v10h13V9M12 11.5v4.2M9.9 13.6L12 15.7l2.1-2.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      {/* Pin — pushpin, head bar over a tapered body (ASSIST.md · swipe right), stroke 1.4 */}
      <symbol id="ico-pin" viewBox="0 0 24 24">
        <path
          d="M9 3.5h6M10.2 3.5v5.6c0 1-.6 1.9-1.5 2.4l-.6.3h7.8l-.6-.3c-.9-.5-1.5-1.4-1.5-2.4V3.5M12 11.8v8.7"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
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
      {/* DOWNLOAD — a mark falling onto a line. The update plate's glyph, and drawn to that
          handoff's path: it is the one place in the app where something arrives from elsewhere and
          waits to be let in. */}
      <symbol id="ico-download" viewBox="0 0 24 24">
        <path
          d="M12 4v10M8 10.4l4 4 4-4M4.5 19.5h15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </symbol>
      {/* COPY — one sheet laid over another, the back one showing at its top-left corner. Drawn as
          two open paths rather than two closed rectangles so the overlap reads as depth instead of
          as a grid: the back sheet stops where the front one covers it. */}
      <symbol id="ico-copy" viewBox="0 0 24 24">
        <path d="M9 9h10v10H9zM15 9V5H5v10h4" fill="none" stroke="currentColor" strokeWidth="1.5" />
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
