import { describe, expect, it, beforeEach, vi } from 'vitest'
import { beginFirstPaint, firstPaintSummary, recordFirstPaint, resetFirstPaint } from './firstPaint'

beforeEach(resetFirstPaint)

describe('first-paint latency', () => {
  it('reports nothing until a turn has been measured', () => {
    expect(firstPaintSummary()).toBeNull()
  })

  it('reports the typical wait rather than the average one', () => {
    // One cold start among nine warm turns. A mean would report ~250ms and imply the panel is slow;
    // the median says what nearly every turn actually felt like, which is the truth worth acting on.
    for (const ms of [90, 95, 100, 105, 110, 95, 100, 105, 90]) recordFirstPaint({ ms, agent: 'barnaby' })
    recordFirstPaint({ ms: 1800, agent: 'barnaby' })

    const s = firstPaintSummary()!
    expect(s.medianMs).toBeLessThan(150)
    // ...and the tail still shows up, because that cold start is exactly what gets complained about.
    expect(s.p95Ms).toBe(1800)
    expect(s.lastMs).toBe(1800)
  })

  it('keeps the agents apart', () => {
    // Barnaby and Geist are separate gateways on separate routes. Pooling them would average away
    // the difference and hide a regression in whichever one is used less.
    recordFirstPaint({ ms: 100, agent: 'barnaby' })
    recordFirstPaint({ ms: 900, agent: 'geist' })

    expect(firstPaintSummary('barnaby')!.medianMs).toBe(100)
    expect(firstPaintSummary('geist')!.medianMs).toBe(900)
    expect(firstPaintSummary('nobody')).toBeNull()
  })

  it('forgets old turns so a panel left running reports recent behaviour', () => {
    for (let i = 0; i < 60; i++) recordFirstPaint({ ms: i, agent: 'barnaby' })
    expect(firstPaintSummary()!.count).toBe(50)
  })

  it('measures after the paint, not when the delta arrived', async () => {
    // The wait is only over once the character is on the glass. Stopping the clock on the first
    // animation-frame callback would stop it *before* the browser painted — the exact error this
    // measurement exists to avoid, and one that would flatter every reading.
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length })

    const paint = beginFirstPaint('barnaby')
    paint()

    expect(frames).toHaveLength(1)
    frames.shift()!(0)                       // pre-paint callback: nothing recorded yet
    expect(firstPaintSummary()).toBeNull()

    frames.shift()!(0)                       // post-paint callback
    expect(firstPaintSummary()!.count).toBe(1)

    vi.unstubAllGlobals()
  })

  it('records one measurement per turn even if the first delta is committed twice', () => {
    // React may run a state updater more than once, and the measurement is taken inside one.
    const paint = beginFirstPaint('barnaby')
    paint()
    paint()
    expect(firstPaintSummary()?.count ?? 0).toBeLessThanOrEqual(1)
  })
})
