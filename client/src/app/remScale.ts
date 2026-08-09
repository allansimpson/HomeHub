/**
 * The rem scale — and why it is a module rather than the one line of CSS it used to be.
 *
 * Everything in the panel is drawn in rem against a 540×960 canvas, and `html { font-size }` is what
 * maps that canvas onto the device: `min(100vw / 33.75, 100vh / 60)`, so the whole app scales as one
 * piece (index.css states the rest of the reasoning).
 *
 * On a phone that rule has one bad interaction. `index.html` asks for
 * `interactive-widget=resizes-content`, which is what keeps the composer above the software keyboard:
 * the keyboard shortens the **layout** viewport, and the shell lays out inside what is left. But `vh`
 * measures that same shortened viewport, so opening the keyboard also shrinks `1rem` — the transcript
 * you are composing a reply to gets smaller and harder to read the instant you touch the field, and
 * springs back when you dismiss it. The wall panel never sees this, because it opens no keyboard and
 * types on HomeHub's own; a phone sees it on every single message.
 *
 * So the height the scale is measured from is **held** across a keyboard opening. The layout still
 * reflows into the shortened viewport — the composer still sits above the keyboard, the transcript
 * still gives up the room — but every glyph on screen stays exactly the size it was.
 *
 * The CSS rule stays in index.css as the value before this runs (and for the design-system entry,
 * which has no app around it); the inline `font-size` written here takes over from it.
 */

/** The mock canvas, in rem: 540×960 at 1rem = 16px. */
const CANVAS_REM_W = 33.75
const CANVAS_REM_H = 60

/**
 * How long after a text field gives up focus the keyboard is still assumed to be on its way out.
 *
 * The blur and the viewport growing back are separate events, in that order and some frames apart.
 * Without a grace period the resize that lands between them arrives with nothing focused and reads
 * as a genuinely shorter window, which is the one case the hold exists to catch.
 */
const KEYBOARD_SETTLE_MS = 700

export interface Viewport {
  width: number
  height: number
}

/** The rem size, in px, that fits `view` onto the canvas. */
export function remPx(view: Viewport): number {
  return Math.min(view.width / CANVAS_REM_W, view.height / CANVAS_REM_H)
}

/**
 * Which viewport the scale should be measured from, given the one held so far and the one just seen.
 *
 * A *shorter* viewport at an *unchanged* width, while something is being typed into, is the software
 * keyboard and nothing else — hold the height, take the width. Everything else is a real change in
 * how much room there is (a rotation, a foldable opening, a desktop window dragged, the keyboard
 * going away again) and is taken as measured.
 */
export function heldViewport(held: Viewport | null, seen: Viewport, typing: boolean): Viewport {
  if (!held) return seen
  const keyboard = typing && seen.width === held.width && seen.height < held.height
  return keyboard ? { width: seen.width, height: held.height } : seen
}

/** Input types that summon a keyboard. A date or colour picker opens a widget of its own. */
const TEXTUAL = new Set(['', 'text', 'search', 'url', 'tel', 'email', 'password', 'number'])

/** Whether focusing this element is what would bring the keyboard up. */
function editable(node: EventTarget | null): boolean {
  if (!(node instanceof HTMLElement)) return false
  if (node instanceof HTMLTextAreaElement) return !node.readOnly && !node.disabled
  if (node instanceof HTMLInputElement) return !node.readOnly && !node.disabled && TEXTUAL.has(node.type)
  return node.isContentEditable
}

/**
 * Start driving `html { font-size }`. Returns the teardown, which puts the CSS rule back in charge.
 */
export function installRemScale(): () => void {
  const root = document.documentElement
  let held: Viewport | null = null
  let blurredAt = -Infinity
  let frame = 0

  const typing = () =>
    editable(document.activeElement) || performance.now() - blurredAt < KEYBOARD_SETTLE_MS

  const apply = () => {
    frame = 0
    // The **layout** viewport, which is exactly what `100vh` measured before this took over — not
    // `window.innerHeight`, which is the *visual* one. The difference matters on a phone browser:
    // scrolling retracts the address bar and grows `innerHeight` without changing the layout at all,
    // so measuring that would rescale the whole app every time somebody scrolled a list. The
    // interactive-widget resize *does* move this figure, which is the one case here that should.
    const seen = { width: root.clientWidth, height: root.clientHeight }
    // A zero-sized viewport is a backgrounded tab mid-teardown, not something worth scaling to.
    if (!seen.width || !seen.height) return
    held = heldViewport(held, seen, typing())
    root.style.fontSize = `${remPx(held)}px`
  }

  // The keyboard animates in over several frames and fires a resize on most of them; one apply per
  // frame is all any of them can produce on screen.
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(apply)
  }

  const onFocusOut = (event: FocusEvent) => {
    if (editable(event.target)) blurredAt = performance.now()
  }

  apply()
  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', schedule)
  // Belt and braces: under `resizes-content` the layout viewport is what moves and `window` reports
  // it, but a browser that ignores the hint resizes only the visual one.
  window.visualViewport?.addEventListener('resize', schedule)
  document.addEventListener('focusin', schedule, true)
  document.addEventListener('focusout', onFocusOut, true)

  return () => {
    if (frame) cancelAnimationFrame(frame)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('orientationchange', schedule)
    window.visualViewport?.removeEventListener('resize', schedule)
    document.removeEventListener('focusin', schedule, true)
    document.removeEventListener('focusout', onFocusOut, true)
    root.style.removeProperty('font-size')
  }
}
