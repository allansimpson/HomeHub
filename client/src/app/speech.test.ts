import { afterEach, describe, expect, it } from 'vitest'
import { createRecognizer, foldTranscript } from './speech'

/**
 * What the recognizer makes of the results it is handed.
 *
 * The regression this pins down: one breath of "testing can you hear me now", spoken cleanly into an
 * iPhone, was sent to the assistant as
 * `testingtestingtestingtesting cantesting can youtesting can you heartesting can you hear me now` —
 * the recognizer's own successive drafts of the sentence, glued end to end. Nothing was misheard. The
 * last draft is verbatim what was said; the seven before it were the same sentence in progress, each
 * marked final, each appended.
 *
 * Both engines are replayed below, because the fix has to leave Chrome — the kiosk, where this never
 * happened — behaving exactly as it did.
 */

interface Result { 0: { transcript: string }; isFinal: boolean }

/** The stub the recognizer is built on top of, standing in for the browser's. */
class FakeRecognition {
  continuous = false
  interimResults = false
  lang = ''
  started = 0
  onresult: ((e: { resultIndex: number; results: ArrayLike<Result> }) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((e: { error?: string }) => void) | null = null

  private results: Result[] = []

  start() { this.started++; this.results = [] }
  stop() { this.onend?.() }

  /** Deliver one result, the way an engine does: appended to the list, with the index it landed at. */
  emit(transcript: string, isFinal: boolean) {
    const resultIndex = this.results.length
    this.results.push({ 0: { transcript }, isFinal })
    this.onresult?.({ resultIndex, results: this.results })
  }

  /** Deliver a revision *in place* — Chrome overwrites the pending interim rather than adding one. */
  revise(transcript: string, isFinal: boolean) {
    const resultIndex = Math.max(0, this.results.length - 1)
    this.results[resultIndex] = { 0: { transcript }, isFinal }
    this.onresult?.({ resultIndex, results: this.results })
  }
}

/** Put a scripted engine behind `window.SpeechRecognition`, the way a browser would. */
function install(): FakeRecognition {
  const recognition = new FakeRecognition()
  ;(globalThis as { window?: unknown }).window = { SpeechRecognition: function () { return recognition } }
  return recognition
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

/** Run the recognizer over a scripted engine and report what the caller would have been handed. */
function listen(script: (engine: FakeRecognition) => void) {
  const engine = install()
  const partials: string[] = []
  let final = ''
  const recognizer = createRecognizer({
    onPartial: (text) => partials.push(text),
    onFinal: (text) => { final = text },
  })!
  recognizer.start()
  script(engine)
  recognizer.stop()
  return { final, partials }
}

const SPOKEN = 'testing can you hear me now'

describe('createRecognizer', () => {
  it('keeps one utterance whole when Safari re-states it as a run of final results', () => {
    // The exact sequence behind the reported transcript: every draft of the sentence, each its own
    // final result at its own index.
    const { final } = listen((engine) => {
      for (const draft of [
        'testing', 'testing', 'testing', 'testing can', 'testing can you',
        'testing can you hear', 'testing can you hear me', SPOKEN,
      ]) engine.emit(draft, true)
    })
    expect(final).toBe(SPOKEN)
  })

  it('shows the same thing live that it ends up sending', () => {
    const { final, partials } = listen((engine) => {
      for (const draft of ['testing', 'testing can you', SPOKEN]) engine.emit(draft, true)
    })
    expect(partials.at(-1)).toBe(final)
    // Nothing on the way there is a stack of drafts either — the band read the doubled text too.
    expect(partials.every((p) => !p.includes('testingtesting'))).toBe(true)
  })

  it('still builds a Chrome utterance from interim revisions and one final', () => {
    const { final, partials } = listen((engine) => {
      engine.emit('testing', false)
      engine.revise('testing can you', false)
      engine.revise(SPOKEN, false)
      engine.revise(SPOKEN, true)
    })
    expect(final).toBe(SPOKEN)
    expect(partials).toEqual(['testing', 'testing can you', SPOKEN, SPOKEN])
  })

  it('joins genuinely separate phrases with a space', () => {
    // Chrome breaks a long dictation into several final results; those are new words, not redrafts,
    // and `+=` used to run the last word of one into the first of the next.
    const { final } = listen((engine) => {
      engine.emit('add milk to the list', true)
      engine.emit('and oat flour', true)
    })
    expect(final).toBe('add milk to the list and oat flour')
  })

  it('drops the transcript from the previous turn when the mic reopens', () => {
    const engine = install()
    let final = ''
    const recognizer = createRecognizer({ onPartial: () => {}, onFinal: (text) => { final = text } })!

    recognizer.start()
    engine.emit('turn the kettle on', true)
    recognizer.stop()

    recognizer.start()
    engine.emit(SPOKEN, true)
    recognizer.stop()
    expect(final).toBe(SPOKEN)
  })
})

describe('foldTranscript', () => {
  it('replaces a draft with the one that grew out of it', () => {
    expect(foldTranscript('testing can', 'testing can you hear me')).toBe('testing can you hear me')
  })

  it('keeps the fuller draft when a revision comes back shorter', () => {
    expect(foldTranscript('testing can you hear me', 'testing can you')).toBe('testing can you hear me')
  })

  it('sees past punctuation and case, which the engine adds and removes between drafts', () => {
    expect(foldTranscript('testing', 'Testing, can you hear me?')).toBe('Testing, can you hear me?')
  })

  it('appends when the segment is not a redraft', () => {
    expect(foldTranscript('add milk', 'and oat flour')).toBe('add milk and oat flour')
  })

  it('ignores empty segments rather than leaving a stray space', () => {
    expect(foldTranscript('add milk', '   ')).toBe('add milk')
    expect(foldTranscript('', 'add milk')).toBe('add milk')
  })
})
