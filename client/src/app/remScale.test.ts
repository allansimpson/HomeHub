import { describe, expect, it } from 'vitest'
import { heldViewport, remPx } from './remScale'

/** A phone in portrait, before anything is typed into. */
const phone = { width: 412, height: 830 }

describe('rem scale', () => {
  it('fits the 540×960 canvas to whichever axis runs out first', () => {
    // The wall panel: 16:9 portrait, so the width is the binding constraint and 1rem lands at 4×.
    expect(remPx({ width: 2160, height: 3840 })).toBeCloseTo(64)
    // A squatter window is bound by its height instead, which is what the min() is there for.
    expect(remPx({ width: 2160, height: 2400 })).toBeCloseTo(40)
  })

  it('holds the height while the software keyboard is up', () => {
    // `interactive-widget=resizes-content` shortens the layout viewport when the keyboard opens.
    // The layout is meant to reflow into that; the type is not meant to change size with it.
    const typing = heldViewport(phone, { width: 412, height: 420 }, true)
    expect(typing).toEqual(phone)
    expect(remPx(typing)).toBe(remPx(phone))
  })

  it('takes the height back when the keyboard goes away', () => {
    expect(heldViewport(phone, phone, true)).toEqual(phone)
  })

  it('takes a genuinely shorter window when nothing is being typed into', () => {
    // A desktop window dragged up by its edge. Nothing has focus, so there is no keyboard to blame.
    const dragged = { width: 412, height: 420 }
    expect(heldViewport(phone, dragged, false)).toEqual(dragged)
  })

  it('takes a rotation even mid-sentence, because the width proves it is not the keyboard', () => {
    const landscape = { width: 830, height: 412 }
    expect(heldViewport(phone, landscape, true)).toEqual(landscape)
  })

  it('follows a keyboard that gets wider without letting it change the scale', () => {
    // Swapping to a taller keyboard layout shortens the viewport again; the width is unchanged, so
    // the held height survives it.
    const held = heldViewport(phone, { width: 412, height: 420 }, true)
    expect(heldViewport(held, { width: 412, height: 360 }, true)).toEqual(phone)
  })

  it('has nothing to hold on the first measurement', () => {
    expect(heldViewport(null, phone, true)).toEqual(phone)
  })
})
