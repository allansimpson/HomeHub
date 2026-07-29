# HomeHub — CALENDAR · New / Edit Event (exact spec)

The event creation/editing screen (`data-screen-label="Calendar New Event"`), a full-screen modal
reached from the Calendar header **`+`** (new) or by tapping an existing event (edit). Touch-first:
large steppers and chips, **no dropdowns**. Meridian Ledger dark deco.

All px on the **540×960 reference canvas** — divide by 16 for the 4K rem build (BE157BU 2160×3840,
`TARGET_HARDWARE.md`); keep 1px/2px rules in device px. Tokens: §7.

![New Event](screens/calendar-new-event.png)
> `screens/calendar-new-event.png`

---

## 1. Structure (top → bottom)
Modal container: `width:540; height:960; background:#15171a; color:#e8e4dc; font-family:'Josefin Sans'; display:flex; flex-direction:column; overflow:hidden;`
1. Action header: `CANCEL` — `NEW ENGAGEMENT` — `SAVE`
2. Double rule
3. Field list (`flex:1; padding:12px 34px; min-height:0`), each field a ledger row with a bottom hairline:
   TITLE · DATE · BEGINS · ENDS · WHO · WHERE · NOTE
4. Bottom nav (**CALENDAR active**)

This is a modal over Calendar, but it still shows the standard bottom nav with CALENDAR lit. It has
**no ◂ back button** — Cancel/Save are the exits.

## 2. Action header
```html
<div style="display:flex; justify-content:space-between; align-items:center; padding:26px 34px 0;">
  <div style="border:1px solid #3a3d41; padding:13px 22px; font-size:11px; letter-spacing:0.24em; color:#7d7668;">CANCEL</div>
  <div style="font-family:Marcellus, serif; font-size:24px; letter-spacing:0.06em; white-space:nowrap;">NEW ENGAGEMENT</div>
  <div style="border:1px solid #b08d57; background:#221d13; padding:13px 26px; font-size:11px; letter-spacing:0.24em; color:#c8a877;">SAVE</div>
</div>
<div style="margin:16px 34px 0; border-top:2px solid #b08d57; border-bottom:1px solid #2a2d31; height:3px;"></div>
```
- **CANCEL**: dim bordered button (1px `#3A3D41`, `#7D7668`). Discards, returns to Calendar.
- **Title**: Marcellus 24px, centered, `NEW ENGAGEMENT` (new) / `EDIT ENGAGEMENT` (edit mode).
- **SAVE**: brass button (1px `#B08D57`, bg `#221D13`, `#C8A877`). Writes the event, returns to Calendar with it visible.

## 3. Field rows
Every field label is the same: `font-size:10px; letter-spacing:0.34em; color:#b08d57;` (uppercase brass), and every row closes with `border-bottom:1px solid #24272b;`. Two row shapes: **label-left / control-right** (Date, Begins, Ends, Where) and **stacked** (Title, Who, Note).

### TITLE (stacked)
```html
<div style="display:flex; flex-direction:column; gap:6px; padding:14px 0; border-bottom:1px solid #24272b;">
  <div style="font-size:10px; letter-spacing:0.34em; color:#b08d57;">TITLE</div>
  <div style="display:flex; align-items:center; gap:3px;">
    <div style="font-family:Marcellus, serif; font-size:24px;">Dinner with the Marlowes</div>
    <div style="width:2px; height:24px; background:#c8a877;"></div>
  </div>
</div>
```
Marcellus 24px value + 2px×24px brass caret. Tapping summons the kiosk keyboard.

### DATE (label-left, stepper-right)
```html
<div style="display:flex; align-items:center; justify-content:space-between; padding:16px 0; border-bottom:1px solid #24272b;">
  <div style="font-size:10px; letter-spacing:0.34em; color:#b08d57;">DATE</div>
  <div style="display:flex; align-items:center; gap:16px;">
    <div style="width:40px; height:40px; border:1px solid #5c5342; display:flex; align-items:center; justify-content:center; font-size:15px; color:#c8a877;">◂</div>
    <div style="font-family:Marcellus, serif; font-size:22px; min-width:150px; text-align:center;">Thu · 16 Jul</div>
    <div style="width:40px; height:40px; border:1px solid #5c5342; display:flex; align-items:center; justify-content:center; font-size:15px; color:#c8a877;">▸</div>
  </div>
</div>
```
◂ / ▸ day steppers (40×40, 1px `#5C5342`, glyph 15px `#C8A877`) flanking the value (Marcellus 22px, **min-width 150px**, centered). Hold to fast-scrub; tapping the value opens the month grid.

### BEGINS / ENDS (label-left, −/+ stepper-right)
Identical to DATE but with `−` / `+` glyphs (font-size 18px) and time values:
- BEGINS `7:00` + ` PM` (the AM/PM is `font-size:13px; color:#7d7668;` inside the value).
- ENDS `9:00 PM`.
- Value box same **min-width 150px** — so the DATE ◂▸, BEGINS −/+, and ENDS −/+ buttons line up vertically down both edges. Steps are 15-minute increments.

### WHO (stacked, multi-select chips)
```html
<div style="display:flex; flex-direction:column; gap:10px; padding:16px 0; border-bottom:1px solid #24272b;">
  <div style="font-size:10px; letter-spacing:0.34em; color:#b08d57;">WHO</div>
  <div style="display:flex; gap:8px;">
    <!-- selected chip -->
    <div style="flex:1; border:1px solid #b08d57; background:#221d13; padding:11px 0; text-align:center; font-size:11px; letter-spacing:0.2em; color:#c8a877;">ALLAN</div>
    <!-- unselected chip -->
    <div style="flex:1; border:1px solid #3a3d41; padding:11px 0; text-align:center; font-size:11px; letter-spacing:0.2em; color:#5f584b;">THEO</div>
  </div>
</div>
```
Four equal chips `ALLAN · MARTA · THEO · ALL`. Selected = 1px `#B08D57` + bg `#221D13` + `#C8A877`; unselected = 1px `#3A3D41` + `#5F584B`. Multi-select (mock: Allan + Marta selected). `ALL` selects everyone.

### WHERE (label-left, value-right)
```html
<div style="display:flex; align-items:center; justify-content:space-between; padding:16px 0; border-bottom:1px solid #24272b;">
  <div style="font-size:10px; letter-spacing:0.34em; color:#b08d57;">WHERE</div>
  <div style="font-size:15px; font-weight:300; color:#cfc9bd;">Verdi's, 12 Grand Avenue</div>
</div>
```
Plain text value 15px weight-300 `#CFC9BD` (empty placeholder in `#5F584B`). Tap → keyboard.

### NOTE (stacked, open text block)
```html
<div style="display:flex; flex-direction:column; gap:10px; padding:16px 0 0;">
  <div style="font-size:10px; letter-spacing:0.34em; color:#b08d57;">NOTE</div>
  <div style="padding:2px 0 16px; min-height:110px; border-bottom:1px solid #24272b; font-size:15px; font-weight:300; color:#cfc9bd; line-height:1.6;">Bringing a bottle of the Barolo. They're two doors down from the Hartleys — park on the street.<span style="display:inline-block; width:2px; height:18px; background:#c8a877; vertical-align:middle; margin-left:2px;"></span></div>
</div>
```
Multi-line free text — **no containing box**, just a bottom hairline closing the block; `min-height:110px`, line-height 1.6, 2px brass caret inline. Empty placeholder "Add a note…" in `#5F584B`.

## 4. Edit mode
Reuses this screen. Title reads `EDIT ENGAGEMENT`; fields pre-filled from the event. Add a **DELETE** text action (terracotta `#C07A5A`) below NOTE (confirm before removing). Save updates in place.

## 5. Interactions
- All entry via steppers / chips / kiosk keyboard — no dropdowns, no tiny targets (buttons ≥40px canvas ≈ 160px device).
- SAVE validates (title + date + begins required; ends ≥ begins) then writes and returns to Calendar.
- Reached from Calendar header `+`; the modal covers Calendar; nav still shows CALENDAR active.

## 6. State
Draft `event { title, date, begins, ends, attendees[], where, note }`, `mode: 'new' | 'edit'`, `eventId?`. Steppers mutate date/time; chips toggle attendees; keyboard edits title/where/note.

## 7. Tokens (sRGB)
- Bg `#15171A`; brass fill `#221D13`. Brass: structural `#B08D57`, bright `#C8A877`, dim border `#5C5342`.
- Text: primary `#E8E4DC`, secondary `#CFC9BD`, muted `#7D7668`, disabled/placeholder `#5F584B`. Destructive `#C07A5A`.
- Hairline minor `#24272B`, major `#2A2D31`, inactive border `#3A3D41`.
- Type: **Marcellus** for the header title + all field values (title, date, times); **Josefin Sans** 300 for where/note text, 400 for the uppercase brass field labels + chips/buttons (tracking 0.2–0.34em). No border radius. Double-rule motif under header (2px `#B08D57` + 3px gap + 1px `#2A2D31`). Bottom nav: see `BOTTOM_NAV.md` (CALENDAR active).
