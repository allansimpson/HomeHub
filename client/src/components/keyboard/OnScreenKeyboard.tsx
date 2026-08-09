import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useNativeKeyboard } from './useNativeKeyboard'

/**
 * Global on-screen keyboard for the wall panel (KEYBOARD.md). The kiosk has no hardware keyboard,
 * so any time a text field is focused this docked panel slides up and types into that field. It is
 * mounted once at the app root and works with every input automatically — no per-screen wiring.
 *
 * Design: it never steals focus. The focused field keeps focus (keys `preventDefault` on
 * pointer-down), so we type straight into it via the native value setter + an `input` event, which
 * keeps React's controlled value in sync and lets each field's own Enter/blur/Escape handlers fire
 * exactly as they would from a hardware keyboard. Above the keys sits a compact entry context (the
 * live value + caret, CANCEL / SAVE) since the keyboard covers the lower part of the screen.
 *
 * **On a phone this stands down entirely** and the device's own keyboard takes over — see
 * {@link useNativeKeyboard} for why that is the right call and how the two are told apart.
 *
 * PIN entry uses its own numeric pad on the Lock screen (buttons, not an input), so it is untouched.
 *
 * ## What makes it feel fast
 *
 * Two things, and both are about the work done *per keystroke* rather than about the work done once:
 *
 * 1. **Keys act on `pointerdown`, not `click`.** A click is only dispatched after the finger lifts,
 *    so every character used to wait out the press. Typing is the one interaction where that delay
 *    is felt on every single input rather than once per screen.
 * 2. **The keys and the echo are memoised apart from each other.** A keystroke changes the field's
 *    value, which changes the echo — but not the 40-odd key buttons, whose appearance depends only
 *    on the layout and the shift state. Before this they re-rendered on every character, which is
 *    most of a repaint's work spent redrawing a keyboard that had not changed.
 */

type Field = HTMLInputElement | HTMLTextAreaElement
type Layout = 'letters' | 'numbers' | 'symbols'

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', 'number'])

/** Is this element a text field the keyboard should serve? (Not sliders, files, checkboxes, PIN.) */
function isEditable(el: EventTarget | null): el is Field {
  if (!(el instanceof HTMLElement)) return false
  if (el.hasAttribute('data-no-osk')) return false
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled
  if (el instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has((el.type || 'text').toLowerCase()) && !el.readOnly && !el.disabled
  }
  return false
}

/** Set a controlled input's value so React's onChange fires (native setter defeats React's tracker). */
function setNativeValue(el: Field, value: string, caret: number) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
  try { el.setSelectionRange(caret, caret) } catch { /* number inputs don't support selection */ }
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function dispatchKey(el: Field, key: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }))
}

interface KeyDef {
  /** Character to insert, or a command token. */
  k: string
  /** Display label (defaults to the key char, shifted for letters). */
  label?: string
  flex?: number
  /** Accent styling: 'brass' for shift/backspace/switch, 'return' for the filled commit key. */
  accent?: 'brass' | 'switch' | 'return' | 'space'
}

const LETTERS: KeyDef[][] = [
  [...'qwertyuiop'].map((k) => ({ k })),
  [...'asdfghjkl'].map((k) => ({ k })),
  [{ k: 'shift', label: '⇧', flex: 1.5, accent: 'brass' }, ...[...'zxcvbnm'].map((k) => ({ k })), { k: 'back', label: '⌫', flex: 1.5, accent: 'brass' }],
  [{ k: 'to-numbers', label: '123', flex: 1.6, accent: 'switch' }, { k: ',' }, { k: 'space', label: 'space', flex: 5, accent: 'space' }, { k: '.' }, { k: 'return', label: 'return', flex: 1.8, accent: 'return' }],
]

const NUMBERS: KeyDef[][] = [
  [...'1234567890'].map((k) => ({ k })),
  [...'-/:;()$&@"'].map((k) => ({ k })),
  [{ k: 'to-symbols', label: '#+=', flex: 1.5, accent: 'switch' }, ...[...'.,?!\''].map((k) => ({ k })), { k: 'back', label: '⌫', flex: 1.5, accent: 'brass' }],
  [{ k: 'to-letters', label: 'ABC', flex: 1.6, accent: 'switch' }, { k: 'space', label: 'space', flex: 5, accent: 'space' }, { k: 'return', label: 'return', flex: 1.8, accent: 'return' }],
]

const SYMBOLS: KeyDef[][] = [
  [...'[]{}#%^*+='].map((k) => ({ k })),
  [...'_\\|~<>€£¥•'].map((k) => ({ k })),
  [{ k: 'to-numbers', label: '123', flex: 1.5, accent: 'switch' }, ...[...'.,?!\''].map((k) => ({ k })), { k: 'back', label: '⌫', flex: 1.5, accent: 'brass' }],
  [{ k: 'to-letters', label: 'ABC', flex: 1.6, accent: 'switch' }, { k: 'space', label: 'space', flex: 5, accent: 'space' }, { k: 'return', label: 'return', flex: 1.8, accent: 'return' }],
]

const LAYOUTS: Record<Layout, KeyDef[][]> = { letters: LETTERS, numbers: NUMBERS, symbols: SYMBOLS }

export function OnScreenKeyboard() {
  const nativeKeyboard = useNativeKeyboard()
  const [field, setField] = useState<Field | null>(null)
  const [value, setValue] = useState('')
  const [caret, setCaret] = useState(0)
  const [layout, setLayout] = useState<Layout>('letters')
  const [shift, setShift] = useState(true)
  // The field's value when editing began — CANCEL restores it (true discard).
  const original = useRef('')
  const fieldRef = useRef<Field | null>(null)
  fieldRef.current = field
  // The echo's own box, used to hit-test a tap/drag back to a character index.
  const echoRef = useRef<HTMLDivElement | null>(null)
  const echoDragging = useRef(false)

  const multiline = field instanceof HTMLTextAreaElement
  const masked = field instanceof HTMLInputElement && field.type === 'password'
  const label = (field?.getAttribute('aria-label') || field?.getAttribute('placeholder') || 'Text').trim()

  // Mirror the live field value + caret into the entry-context echo.
  const sync = useCallback(() => {
    const el = fieldRef.current
    if (!el) return
    setValue(el.value)
    setCaret(el.selectionStart ?? el.value.length)
  }, [])

  const close = useCallback(() => {
    setField(null)
    setLayout('letters')
    setShift(true)
  }, [])

  // Open on focus of any text field; close when focus lands somewhere that isn't a field or our panel.
  useEffect(() => {
    if (nativeKeyboard) {
      // Stand down, and undo the suppression on the way out. `inputmode="none"` is what hides the
      // device's own keyboard, so a field that was focused on the panel side of the breakpoint —
      // or on a tablet before it was rotated — would otherwise be left unable to summon either one.
      const release = (e: FocusEvent) => {
        const t = e.target
        if (isEditable(t) && t.getAttribute('inputmode') === 'none') t.removeAttribute('inputmode')
      }
      document.addEventListener('focusin', release)
      // Fields that were already marked before the switch. The listener above only sees the ones
      // focused from here on, and a tablet rotated across the breakpoint has a screenful that were
      // marked under the old rule.
      for (const el of document.querySelectorAll('[inputmode="none"]')) el.removeAttribute('inputmode')
      close()
      return () => document.removeEventListener('focusin', release)
    }

    const onFocusIn = (e: FocusEvent) => {
      const t = e.target
      if (t instanceof HTMLElement && t.closest('[data-osk]')) return
      if (isEditable(t)) {
        // Suppress the OS virtual keyboard so only ours shows on the touch panel.
        t.setAttribute('inputmode', 'none')
        original.current = t.value
        setField(t)
        setLayout((t instanceof HTMLInputElement && t.type === 'number') ? 'numbers' : 'letters')
        setShift(t.value.length === 0)
        setValue(t.value)
        setCaret(t.selectionStart ?? t.value.length)
      }
    }
    const onFocusOut = () => {
      // Let focus settle, then close if it left the field and our panel (key taps preventDefault,
      // so typing never triggers this).
      window.setTimeout(() => {
        const a = document.activeElement
        if (!isEditable(a) && !(a instanceof HTMLElement && a.closest('[data-osk]'))) close()
      }, 0)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [close, nativeKeyboard])

  // Keep the echo in step with hardware typing / caret moves into the same field.
  useEffect(() => {
    const el = field
    if (!el) return
    el.addEventListener('input', sync)
    el.addEventListener('keyup', sync)
    el.addEventListener('click', sync)
    // Dragging the caret through existing text moves the selection without necessarily ending in a
    // `click` — a pointer that travels is a drag, not a tap. Without these the real caret lands
    // where you dropped it but the echo keeps showing the old position, so the next key appears to
    // insert in the wrong place. `selectionchange` is the event that actually covers caret motion;
    // `select` and `pointerup` are belt-and-braces for the drag-release itself.
    el.addEventListener('select', sync)
    el.addEventListener('pointerup', sync)
    document.addEventListener('selectionchange', sync)
    return () => {
      el.removeEventListener('input', sync)
      el.removeEventListener('keyup', sync)
      el.removeEventListener('click', sync)
      el.removeEventListener('select', sync)
      el.removeEventListener('pointerup', sync)
      document.removeEventListener('selectionchange', sync)
    }
  }, [field, sync])

  /**
   * Put the caret at `index` in the real field and mirror it into the echo.
   *
   * The field itself is usually scrolled behind this panel while the keyboard is up, so the echo
   * is the only text the user can actually see and aim at. That makes the echo — not the input —
   * the surface that has to accept caret placement.
   */
  const moveCaret = useCallback((index: number) => {
    const el = fieldRef.current
    if (!el) return
    const i = Math.max(0, Math.min(index, el.value.length))
    try { el.setSelectionRange(i, i) } catch { /* number inputs don't support selection */ }
    setCaret(i)
  }, [])

  /**
   * Nearest character boundary to a screen point. Each rendered character carries its index, so
   * this compares the pointer against both edges of each glyph and takes the closest — which makes
   * "tap in the gap between two letters" land where you meant rather than always rounding one way.
   * Wrapped textarea text is filtered to the line under the pointer first, so a tap on line 2
   * can't snap to a nearer-looking glyph on line 1.
   */
  const caretIndexFromPoint = useCallback((x: number, y: number) => {
    const root = echoRef.current
    if (!root) return null
    const chars = Array.from(root.querySelectorAll<HTMLElement>('[data-ci]'))
    if (chars.length === 0) return 0

    const online = chars.filter((c) => {
      const r = c.getBoundingClientRect()
      return y >= r.top && y <= r.bottom
    })
    const pool = online.length > 0 ? online : chars

    let best = 0
    let bestDistance = Infinity
    for (const c of pool) {
      const r = c.getBoundingClientRect()
      const i = Number(c.dataset.ci)
      if (Math.abs(x - r.left) < bestDistance) { bestDistance = Math.abs(x - r.left); best = i }
      if (Math.abs(x - r.right) < bestDistance) { bestDistance = Math.abs(x - r.right); best = i + 1 }
    }
    return best
  }, [])

  const onEchoDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const i = caretIndexFromPoint(e.clientX, e.clientY)
    if (i === null) return
    echoDragging.current = true
    // Capture so a drag that leaves the echo box keeps steering the caret instead of dying.
    e.currentTarget.setPointerCapture(e.pointerId)
    moveCaret(i)
  }, [caretIndexFromPoint, moveCaret])

  const onEchoMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!echoDragging.current) return
    const i = caretIndexFromPoint(e.clientX, e.clientY)
    if (i !== null) moveCaret(i)
  }, [caretIndexFromPoint, moveCaret])

  const endEchoDrag = useCallback(() => { echoDragging.current = false }, [])

  const insert = useCallback((text: string) => {
    const el = fieldRef.current
    if (!el) return
    const s = el.selectionStart ?? el.value.length
    const e = el.selectionEnd ?? el.value.length
    const next = el.value.slice(0, s) + text + el.value.slice(e)
    setNativeValue(el, next, s + text.length)
    sync()
  }, [sync])

  const backspace = useCallback(() => {
    const el = fieldRef.current
    if (!el) return
    let s = el.selectionStart ?? el.value.length
    const e = el.selectionEnd ?? el.value.length
    if (s === e) {
      if (s === 0) return
      s -= 1
    }
    const next = el.value.slice(0, s) + el.value.slice(e)
    setNativeValue(el, next, s)
    sync()
  }, [sync])

  const commit = useCallback(() => {
    const el = fieldRef.current
    if (el) { dispatchKey(el, 'Enter'); el.blur() }
    close()
  }, [close])

  const cancel = useCallback(() => {
    const el = fieldRef.current
    if (el) {
      setNativeValue(el, original.current, original.current.length)
      dispatchKey(el, 'Escape')
      el.blur()
    }
    close()
  }, [close])

  const onKey = useCallback((k: string) => {
    switch (k) {
      case 'shift': setShift((s) => !s); return
      case 'back': backspace(); return
      case 'space': insert(' '); return
      case 'to-letters': setLayout('letters'); return
      case 'to-numbers': setLayout('numbers'); return
      case 'to-symbols': setLayout('symbols'); return
      case 'return':
        if (multiline) insert('\n')
        else commit()
        return
      default: {
        // A literal character. Apply shift for letters, then drop shift (auto-lowercase).
        const ch = shift && layout === 'letters' ? k.toUpperCase() : k
        insert(ch)
        if (shift && layout === 'letters') setShift(false)
      }
    }
  }, [backspace, insert, commit, multiline, shift, layout])

  // Physical keyboard is still welcome — it types into the focused field natively; we only mirror.
  if (nativeKeyboard || !field) return null

  const display = masked ? '•'.repeat(value.length) : value

  return (
    // preventDefault on pointer-down keeps focus on the field so tapping keys never blurs it.
    <div className="ml-kb" data-osk onPointerDown={(e) => e.preventDefault()}>
      <div className="ml-kb__context">
        <div className="ml-kb__actions">
          <button type="button" className="ml-kb__cancel" onClick={cancel}>Cancel</button>
          <span className="ml-kb__label">{label}</span>
          <button type="button" className="ml-kb__save" onClick={commit}>Save</button>
        </div>
        <div className="ml-kb__field">
          <Echo
            display={display}
            caret={caret}
            echoRef={echoRef}
            onPointerDown={onEchoDown}
            onPointerMove={onEchoMove}
            onPointerUp={endEchoDrag}
            onPointerCancel={endEchoDrag}
          />
          {/* Precise placement is hard with a fingertip on a wall panel, so the caret can always
              be walked a character at a time. This is the path that cannot fail a hit-test. */}
          <div className="ml-kb__nudge">
            <button type="button" aria-label="Move caret left" onClick={() => moveCaret(caret - 1)}>◀</button>
            <button type="button" aria-label="Move caret right" onClick={() => moveCaret(caret + 1)}>▶</button>
          </div>
        </div>
      </div>

      <KeyPad layout={layout} shift={shift} onKey={onKey} />
    </div>
  )
}

/**
 * The keys.
 *
 * Memoised on the only three things that can change how they look or behave — layout, shift, and
 * the handler — so typing a character does not re-render forty buttons that are identical to the
 * forty already on screen. This is the single biggest cost per keystroke, and it was being paid on
 * every one.
 */
const KeyPad = memo(function KeyPad({ layout, shift, onKey }: {
  layout: Layout
  shift: boolean
  onKey: (k: string) => void
}) {
  return (
    <div className="ml-kb__panel">
      {LAYOUTS[layout].map((row, i) => (
        <div
          className={'ml-kb__row' + (layout === 'letters' && i === 1 ? ' ml-kb__row--inset' : '')}
          key={i}
        >
          {row.map((key) => {
            const glyph = key.label ?? (shift && layout === 'letters' ? key.k.toUpperCase() : key.k)
            return (
              <button
                type="button"
                key={key.k}
                className={
                  'ml-kb__key' +
                  (key.accent ? ` ml-kb__key--${key.accent}` : '') +
                  (key.k === 'shift' && shift ? ' ml-kb__key--active' : '')
                }
                style={key.flex ? { flexGrow: key.flex } : undefined}
                // Down, not click: a click waits for the finger to lift, and typing is the one
                // interaction where that wait is paid on every character rather than once. The
                // panel's own pointer-down handler has already kept focus on the field, so acting
                // here costs nothing. `onClick` is left off entirely so the key cannot fire twice.
                onPointerDown={() => onKey(key.k)}
              >
                {glyph}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
})

/**
 * The live value and caret, above the keys.
 *
 * Characters are rendered individually so a tap or drag can be resolved back to an index — the
 * field itself is usually hidden behind the keyboard, which makes this the surface being aimed at.
 * Memoised because it is the *other* per-keystroke cost: one node per character, rebuilt on every
 * press, and a long message is a lot of nodes.
 */
const Echo = memo(function Echo({ display, caret, echoRef, ...handlers }: {
  display: string
  caret: number
  echoRef: React.RefObject<HTMLDivElement | null>
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void
  onPointerUp: () => void
  onPointerCancel: () => void
}) {
  // Split once per change rather than once per character position.
  const chars = useMemo(() => [...display], [display])

  return (
    // touch-action is off in CSS so the drag steers the caret instead of scrolling.
    <div className="ml-kb__echo" ref={echoRef} {...handlers}>
      <span className="ml-kb__value serif">
        {chars.length === 0 && <span className="ml-kb__caret" aria-hidden="true" />}
        {chars.map((ch, i) => (
          <span key={i}>
            {i === caret && <span className="ml-kb__caret" aria-hidden="true" />}
            <span className="ml-kb__char" data-ci={i}>{ch}</span>
          </span>
        ))}
        {chars.length > 0 && caret >= chars.length && (
          <span className="ml-kb__caret" aria-hidden="true" />
        )}
      </span>
    </div>
  )
})
