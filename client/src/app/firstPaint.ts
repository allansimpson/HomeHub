/**
 * How long the household waits between pressing send and seeing the first character.
 *
 * **This is the number, and it is deliberately not the server's.** Server-side generation latency
 * says when the model produced a token; it cannot see the queue behind a committed response, a
 * proxy holding a buffer, or a React commit that landed a frame late — and those are exactly where
 * a streaming panel goes wrong. Measuring at the browser, after paint, is the only version of the
 * figure that matches what somebody standing at the panel experienced.
 *
 * The measurement stops at the *first* character, not the last. A reply that finishes fast but
 * starts slow feels broken; one that starts instantly and finishes slowly reads as thinking.
 */

/** One turn's wait, in milliseconds. */
export interface FirstPaintSample {
  ms: number
  /** Which agent answered — Barnaby and Geist are different routes and will not be alike. */
  agent: string
}

const MAX_SAMPLES = 50

const samples: FirstPaintSample[] = []

/** Record one measured wait. Oldest fall off, so a long-running panel reports recent behaviour. */
export function recordFirstPaint(sample: FirstPaintSample): void {
  samples.push(sample)
  if (samples.length > MAX_SAMPLES) samples.shift()
}

export interface FirstPaintSummary {
  count: number
  /** Typical wait. The median rather than the mean — one cold start should not move it. */
  medianMs: number
  /** The slow tail. What the household actually complains about. */
  p95Ms: number
  lastMs: number
}

/** The rolling summary, or null before any turn has been measured. */
export function firstPaintSummary(agent?: string): FirstPaintSummary | null {
  const pool = agent ? samples.filter((s) => s.agent === agent) : samples
  if (pool.length === 0) return null

  const sorted = pool.map((s) => s.ms).sort((a, b) => a - b)
  return {
    count: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    lastMs: pool[pool.length - 1].ms,
  }
}

/** Nearest-rank, so a small sample never interpolates a figure nothing actually measured. */
function percentile(sorted: number[], p: number): number {
  const rank = Math.ceil(p * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]
}

/** Test seam. */
export function resetFirstPaint(): void {
  samples.length = 0
}

/**
 * Measure the wait for the turn starting now, and report it once the text is on the screen.
 *
 * Returns a function to call at the moment the first delta is committed to state. It waits two
 * animation frames before reading the clock: the first callback runs *before* the browser paints,
 * so stopping there would report a time at which nothing was yet visible. The second runs after
 * that paint has been committed, which is when a person could have read the character.
 */
export function beginFirstPaint(agent: string): () => void {
  const submittedAt = now()
  let done = false

  return () => {
    if (done) return
    done = true

    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (cb: FrameRequestCallback) => setTimeout(() => cb(now()), 0) as unknown as number

    raf(() => raf(() => {
      const ms = Math.round(now() - submittedAt)
      recordFirstPaint({ ms, agent })
      // A wall panel has no console anyone will open. Hanging the summary off the window means it
      // can be read over remote debugging without a rebuild, which is the only practical way to
      // check a panel that is mounted on a wall.
      ;(globalThis as Record<string, unknown>).__assistFirstPaint = firstPaintSummary
    }))
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}
