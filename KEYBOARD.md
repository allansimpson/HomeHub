# HomeHub — Custom On-Screen Keyboard (exact spec)

A custom, on-theme touch keyboard for the wall panel (kiosk has no hardware keyboard). Compact,
tablet-sized, docked at the bottom of any text-entry screen (task entry, event title, Attendant
input, PIN is separate). Two layouts: **letters** (`data-screen-label="Keyboard"`) and
**numbers/symbols** (`data-screen-label="Keyboard Numbers"`). Meridian Ledger dark deco.

All px on the **540×960 reference canvas** — ÷16 for the 4K rem build (BE157BU 2160×3840,
`TARGET_HARDWARE.md`); keep 1px borders in device px. Tokens: §6.

![Letters](screens/keyboard.png)
![Numbers](screens/keyboard-numbers.png)
> `screens/keyboard.png` · `screens/keyboard-numbers.png`

---

## 1. Model
The keyboard is a **docked panel**, not a full screen — it slides up over whichever entry context
is active and pushes nothing. Above it sits the host entry context (title field + caret +
optional suggestions). Below the panel: nothing (it sits on the panel's bottom edge; no bottom nav
while the keyboard is up). Tapping a key inserts into the focused field; `return`/SAVE commits;
`CANCEL` dismisses.

Two layouts toggle in place (same panel footprint):
- **Letters** — QWERTY, `123` key switches to Numbers.
- **Numbers/symbols** — digits + punctuation, `ABC` key switches back to Letters, `#+=` would swap to a secondary symbol set (optional, not drawn).

## 2. Entry context (above the keyboard)
- Action header: `CANCEL` (1px `#3a3d41`, `#7d7668`, `padding:12px 20px`) — screen title Marcellus 22px — `SAVE` (1px `#b08d57`, bg `#221d13`, `#c8a877`, `padding:12px 24px`). `padding:26px 34px 0`.
- Double rule (`margin:16px 34px 0; border-top:2px solid #b08d57; border-bottom:1px solid #2a2d31; height:3px`).
- Field block (`padding:24px 34px`): brass field label (10px tracking 0.34em `#b08d57`, e.g. `TASK`), then the live value in **Marcellus 26px `#e8e4dc`** followed by a **2px×26px brass caret** `#c8a877`, closed by a bottom hairline `#2a2d31`.
- Optional **suggestions** row under the field (Letters view): bordered chips (`border:1px solid #5c5342; padding:8px 14px; font-size:11px; letter-spacing:0.16em; color:#7d7668`) + a `SUGGESTIONS` micro-label (10px `#5f584b`). Numbers view shows a `NUMBERS & SYMBOLS · TAP ABC TO RETURN` hint instead.

## 3. Keyboard panel (shared shell)
```html
<div style="display:flex; flex-direction:column; gap:7px; background:#101215; border-top:2px solid #b08d57; padding:16px 12px 20px;">
  <!-- rows -->
</div>
```
- Panel background `#101215` (same plane as the bottom nav), **2px brass top border** `#b08d57`, `padding:16px 12px 20px`, **7px** gap between rows.
- Rows are `display:flex; gap:7px;`. Middle letter row is inset with `padding:0 22px` to stagger like a real QWERTY.

### Key (base)
```html
<div style="flex:1; height:56px; border:1px solid #3a3d41; background:#1a1c1f; display:flex; align-items:center; justify-content:center; font-size:19px; color:#e8e4dc;">q</div>
```
- Every key: **height 56px**, `border:1px solid #3a3d41`, `background:#1a1c1f`, centered, no radius (deco). Letters/digits 19px `#e8e4dc` in Josefin Sans.
- **Flex weights** size the special keys: standard key `flex:1`; Shift & Backspace `flex:1.5`; `123`/`ABC` `flex:1.6`; comma/period `flex:1`; **space `flex:5`**; **return `flex:1.8`**.
- **Accent keys:** Shift `⇧`, Backspace `⌫`, `123`/`ABC`, `#+=` use `color:#c8a877` (or `#7d7668` for the layout-switch labels at 13px). **return** is the only filled key: `background:#221d13; border:1px solid #b08d57; color:#c8a877; font-size:12px`. `space` label 12px `#7d7668`.
- Pressed state (impl): briefly invert to `background:#221d13; border-color:#b08d57; color:#c8a877`.

## 4. Letters layout (`screens/keyboard.png`)
Four rows:
1. `q w e r t y u i o p` — 10 keys, all `flex:1`.
2. `a s d f g h j k l` — 9 keys, all `flex:1`, row inset `padding:0 22px`.
3. `⇧`(flex 1.5, brass) · `z x c v b n m` · `⌫`(flex 1.5, brass).
4. `123`(flex 1.6, 13px `#7d7668`) · `,`(flex 1) · `space`(flex 5, 12px `#7d7668`) · `.`(flex 1) · `return`(flex 1.8, filled brass).

Shift toggles caps (visual: brass fill when active); `123` → Numbers layout.

## 5. Numbers/symbols layout (`screens/keyboard-numbers.png`)
Four rows:
1. `1 2 3 4 5 6 7 8 9 0` — 10 keys `flex:1`, 19px.
2. `- / : ; ( ) $ & @ "` — 10 keys `flex:1`, 17px.
3. `#+=`(flex 1.5, brass, 13px) · `. , ? ! '`(17px) · `⌫`(flex 1.5, brass).
4. `ABC`(flex 1.6, 13px `#7d7668`) · `space`(flex 5) · `return`(flex 1.8, filled brass).

`ABC` → Letters layout. `#+=` → optional secondary symbol page (design mirrors row 2/3 with `{ } # % ^ * + = _ \ | ~ < > € £ ¥ •` etc. — build to match, not drawn here).

## 6. Behavior & state
- `kbLayout: 'letters' | 'numbers' | 'symbols'`; `shift: boolean` (caps). Key tap → insert char at caret; `⌫` deletes back; `space`/`.`/`,` literal; `return` commits the field (same as SAVE for single-line, newline for multi-line note fields).
- Auto-shift the first letter of a field/sentence; auto-lower after. Long-press a letter → accented variants (optional).
- Suggestions (Letters) update from the field text; tapping a chip inserts the word + trailing space.
- The keyboard mounts on focus of any text field (task title, event title/where/note, Attendant "Ask anything…") and dismisses on CANCEL/SAVE/return or focus loss. **PIN entry uses its own numeric pad (Lock screen), not this keyboard.**
- Touch targets: 56px canvas height ≈ 224 device px at 4K — comfortably finger-sized; keep the 7px inter-key gaps so adjacent keys don't mis-hit.

## 7. Tokens (sRGB)
- Panel bg `#101215`; key bg `#1A1C1F`; key border `#3A3D41`.
- Brass: structural `#B08D57`, bright `#C8A877`, fill `#221D13`.
- Text: key glyph `#E8E4DC`; muted labels `#7D7668`; hint `#5F584B`. Field value Marcellus `#E8E4DC` + brass caret `#C8A877`.
- Hairlines: `#2A2D31` (field/double rule), `#5C5342` (suggestion chips).
- Type: **Josefin Sans** for all keys (300/400); **Marcellus** only for the entry field value + header title. No border radius. Row gap 7px; key height 56px; panel 2px brass top border.

## 8. Files
`screens/keyboard.png`, `screens/keyboard-numbers.png`; live in `HomeHub - Ledger.dc.html`
(`data-screen-label="Keyboard"` / `"Keyboard Numbers"`).
