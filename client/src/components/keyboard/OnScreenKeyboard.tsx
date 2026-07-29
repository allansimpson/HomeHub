import { useCallback, useEffect, useRef, useState } from 'react'

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
 * PIN entry uses its own numeric pad on the Lock screen (buttons, not an input), so it is untouched.
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
  const [field, setField] = useState<Field | null>(null)
  const [value, setValue] = useState('')
  const [caret, setCaret] = useState(0)
  const [layout, setLayout] = useState<Layout>('letters')
  const [shift, setShift] = useState(true)
  // The field's value when editing began — CANCEL restores it (true discard).
  const original = useRef('')
  const fieldRef = useRef<Field | null>(null)
  fieldRef.current = field

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
  }, [close])

  // Keep the echo in step with hardware typing / caret moves into the same field.
  useEffect(() => {
    const el = field
    if (!el) return
    el.addEventListener('input', sync)
    el.addEventListener('keyup', sync)
    el.addEventListener('click', sync)
    return () => {
      el.removeEventListener('input', sync)
      el.removeEventListener('keyup', sync)
      el.removeEventListener('click', sync)
    }
  }, [field, sync])

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
  if (!field) return null

  const display = masked ? '•'.repeat(value.length) : value
  const rows = LAYOUTS[layout]

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
          <span className="ml-kb__value serif">
            {display.slice(0, caret)}
            <span className="ml-kb__caret" aria-hidden="true" />
            {display.slice(caret)}
          </span>
        </div>
      </div>

      <div className="ml-kb__panel">
        {rows.map((row, i) => (
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
                  onClick={() => onKey(key.k)}
                >
                  {glyph}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
