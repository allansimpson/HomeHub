# HomeHub — TODO screen (exact spec)

The **TODO** bottom-nav tab (checklist icon). Shows the signed-in profile's Microsoft To Do lists;
no owner axis (tasks are the profile's own), organized by **list**. This spec details the screen and
the **Completed group with its Clear affordance**. Companion docs: `ACCOUNT_TODO_LISTS.md` (which
lists sync, Smart Views), `BOTTOM_NAV.md`, `TARGET_HARDWARE.md`.

All px on the **540×960 reference canvas** — ÷16 for the 4K rem build; keep 1px/2px rules in device px.

![TODO](screens/todo.png)
> `screens/todo.png` · `data-screen-label="To-Do"`

---

## 1. Structure (top → bottom)
Container: `width:540; height:960; background:#15171a; color:#e8e4dc; font-family:'Josefin Sans'; display:flex; flex-direction:column; overflow:hidden; position:relative;`
1. Global account avatar (top-right, `position:absolute; top:20; right:20; z-index:5`, 48px verdigris-ring circle, Marcellus 19px initial).
2. Header — `TODO` (Marcellus 30px), **no back button** (main tab), right side empty. `padding:28px 88px 0 34px` (88px clears the avatar).
3. Double rule (`margin:14px 34px 0; border-top:2px solid #b08d57; border-bottom:1px solid #2a2d31; height:3px`).
4. List tabs (underline) — `Today?` · All · each synced list. Active `#c8a877` + 2px underline; inactive `#7d7668`. `Today` is conditional (only when a synced list has a due-dated item). Divider hairline under the row.
5. Task groups (`flex:1; padding:6px 34px 18px; min-height:0`): per-list header + task rows.
6. **Completed group** (collapsible) — see §3.
7. Add-a-task bar.
8. Bottom nav — **TODO active** (`BOTTOM_NAV.md`).

## 2. Open task rows
Per list, a group header (no tick): `LISTNAME` (11px tracking 0.32em `#b08d57`) + count (11px `#7d7668`), `padding:16px 0 4px`. Each task row (`padding:12px 0; border-bottom:1px solid #24272b; gap:16px`):
- 28×28 empty check square, `border:1px solid #5c5342`, `flex-shrink:0`.
- Middle (`flex:1; min-width:0`): title 15px weight-300 `#e8e4dc` clamped 1 line; optional due line 11px in urgency color when present.
- Right: ★ importance glyph 19px — important `#c8a877`, not `#5f584b`.

## 3. Completed group + CLEAR (this change)
Collapsible header row, label-left / action-right:
```html
<div style="display:flex; align-items:center; justify-content:space-between; padding:18px 0 4px;">
  <div style="display:flex; align-items:center; gap:10px;">
    <div style="font-size:13px; color:#7d7668;">▾</div>
    <div style="font-size:11px; letter-spacing:0.3em; color:#b08d57;">COMPLETED</div>
    <div style="font-size:11px; letter-spacing:0.14em; color:#7d7668;">2</div>
  </div>
  <div style="display:flex; align-items:center; gap:8px;">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7d7668" stroke-width="1.4"><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"></path></svg>
    <div style="font-size:10px; letter-spacing:0.2em; color:#7d7668;">CLEAR</div>
  </div>
</div>
```
- Left: `▾` collapse chevron (13px `#7d7668`) + `COMPLETED` (11px tracking 0.3em `#b08d57`) + done count (11px `#7d7668`).
- **Right — CLEAR affordance:** a small trash glyph (15px, stroke `#7d7668`, sw 1.4, path `M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14`) + `CLEAR` label (10px tracking 0.2em `#7d7668`). Muted (not terracotta) — clearing completed items is routine, not destructive of active data.
- Completed rows below: filled-brass check (`background:#b08d57`, dark ✓), title strikethrough, row at 45% opacity.

### Scope & behavior
- **CLEAR clears only the completed items in the currently selected list/tab** (not other lists, never active tasks). On the **All** tab it clears completed across all shown lists.
- **Confirmation:** because this is reversible-ish and low-risk, a single tap clears with a brief **undo** affordance (a 3–4s toast/snackbar "Cleared 2 completed · UNDO") rather than a blocking modal. If you prefer a hard confirm, reuse the inset-confirm pattern from the Attendant manage spec (terracotta) — but default is the light undo.
- Completed items removed here also disappear from Microsoft To Do on next sync (they are marked done there; "clear" hides them from the panel and, if the account setting allows, removes them). At minimum, clearing removes them from the panel's completed view.
- If the Completed group is empty, hide the whole header (no `COMPLETED 0`, no CLEAR).
- Collapse chevron `▾`/`▸` toggles the completed list's visibility; CLEAR stays visible in the header either way.

## 4. Add-a-task bar (pinned above nav)
`display:flex; align-items:center; gap:14px; border:1px solid #3a3d41; padding:16px 18px` (in a `padding:…34px` row): 24×24 `＋` square (`border:1px solid #5c5342`, `#c8a877`, 18px) + `Add a task` placeholder (`#5f584b`) + right target chip `TO <LIST> ▾` (10px tracking 0.18em `#7d7668`) naming the list the new task lands in.

## 5. State
`activeList` (persisted; fallback All), `smartViews{today, all}`, `lists[]`, `tasks[]: { id, title, list, due, important, done }`. Derived: `completedInView = tasks.filter(done && inActiveList)`; `COMPLETED` count = its length; **CLEAR** sets those to cleared/removed (with undo buffer). Sync back to Microsoft To Do.

## 6. Tokens (sRGB)
Bg `#15171A`; brass structural `#B08D57` / bright `#C8A877` / dim border `#5C5342` / fill `#221D13`; text primary `#E8E4DC` / secondary `#CFC9BD` / muted `#7D7668` / disabled `#5F584B`; hairline minor `#24272B` / major `#2A2D31` / inactive `#3A3D41`; verdigris (synced status) `#8FBFA9`. Marcellus for `TODO` + numerals; Josefin Sans 300 body / 400 labels. No border radius. Bottom nav: `BOTTOM_NAV.md` (TODO active).
