# Meridian Ledger — how to build with it

A wall-mounted household panel, portrait, **dark only — there is no light mode**. Machine-age deco:
hairline rules, **no border-radius, no shadows, ever**. Restraint is the brand; a rounded corner or a
drop shadow is off-brand here in a way no colour choice could be.

## Wrap everything in `PreviewRoot`

Most components read React context — `BottomNav` reaches Baby and Litter state through
`useCareSubjects`, `AccountAvatar` reads Session and Notifications, `AttendantOverlay` and
`NotificationDrawer` render `null` until their provider opens them. Outside the wrapper those
components **throw or render nothing**.

```jsx
const { PreviewRoot, ScreenShell, DrillInHeader, LedgerRow, SectionLabel } = window.HomeHub

<PreviewRoot>
  <ScreenShell header={<DrillInHeader title="Climate" status="3 OF 5 RUNNING" statusLive />}>
    <SectionLabel label="THE HOUSE" />
    <LedgerRow title="Living Room" sub="Holding 71°" right={<span className="serif">71°</span>} />
  </ScreenShell>
</PreviewRoot>
```

`PreviewRoot` supplies the router, the full provider chain and the inline SVG icon sprite. **Without
the sprite every icon renders as an empty box**, so it is required even for components that take no
props. It also pins the root font-size to 16px; see Scaling below.

Two overlays are opened through hooks rather than props — `useAttendant().openAttendant()` and
`useNotifications().openDrawer()`, both exported from the bundle.

## Styling: tokens and a fixed class vocabulary — never new CSS

**Never hardcode a hex value.** Every colour is a CSS custom property, and the daylight-boost theme
(`:root[data-ambient=bright]`) re-declares them — a literal hex silently ignores it.

| Token | Use |
|---|---|
| `--bg-screen` / `--bg-nav` / `--bg-active` | screen, nav bar, brass-tinted selected fill |
| `--text-primary` / `--text-secondary` / `--text-muted` | body, supporting, de-emphasised |
| `--brass` / `--brass-dim` | the accent, and its quiet form |
| `--live-text` | verdigris — "live / OK / this leaves nothing" |
| `--font-serif` / `--font-sans` | Marcellus, Josefin Sans |
| `--body-weight` | body weight (theme-dependent — do not hardcode 300) |
| `--hairline-px` | rule width in **device px**, so it never scales into a fat line |

**274 `ml-`-prefixed component classes already exist** (`ml-row`, `ml-chip`, `ml-hold`, `ml-stale`, …).
They belong to the components and are applied for you. For your own layout glue use flex/grid with
`var(--*)` values inline. Two global utilities are yours to apply:

- `.serif` — Marcellus. **Every numeral**: clocks, temperatures, times, month names, screen titles.
- `.label` — letterspaced uppercase, for caps labels and statuses.

There is no utility-class system beyond those two. Do not invent `ml-` names — a class that isn't in
the stylesheet does nothing, silently.

## Scaling: rem tracks the viewport

The design was composed on a **540×960 reference canvas: 1rem = 16 mock-px**, so divide every mock px
by 16. In the real app `html { font-size: min(100vw/33.75, 100vh/60) }` makes 1rem track the panel, so
the layout fills a 4K portrait screen. Size in `rem`, never `px` — except hairlines, which use
`--hairline-px`.

## Where the truth is

- `_ds/<folder>/styles.css` → `_ds_bundle.css` — every token definition and all 274 component classes.
  Read it before styling anything; it is the authority, not this file.
- `components/<group>/<Name>/<Name>.d.ts` — the real prop contract, with the original JSDoc.
- `components/<group>/<Name>/<Name>.prompt.md` — per-component usage.

Groups: **shell** (scaffold, nav, headers), **structure** (rules, labels, rows, scroll, empty),
**controls** (steppers, toggles, chips, PIN, marks), **status** (alerts, offline, mic, notifications).

## Composition habits worth copying

- Screens are **ruled rows, not cards** — `LedgerRow` stacked, hairline-separated. `SectionLabel`
  defaults to no tick so headings align with the content beneath them.
- `ScreenShell` is the scaffold every screen uses: `[banner] → header → double-rule → content → nav`.
- Destructive actions are `HoldButton`, never a plain button — the panel gets bumped.
- Offline never blanks a screen: keep last-known values and mark them (`OfflineChip`, `ml-stale`).
