import { afterEach, describe, expect, it, vi } from 'vitest'
import { setPrivateNetworkConfirmed } from '../api/privateNetwork'
import { speak } from './speech'

/**
 * The house voice is an authenticated endpoint, and a panel that has not confirmed who is asking
 * must not be sending it text to speak.
 *
 * <b>And the fallback must survive the refusal.</b> `speakViaServer` already degrades to the browser
 * voice when the server answers 501 or 502 — a household whose panel has no TTS configured still
 * gets spoken alerts — so a device-only panel must land in that same path rather than falling silent.
 * A boundary that muted the panel would be traded away the first time somebody noticed.
 */

afterEach(() => {
  setPrivateNetworkConfirmed(false)
  vi.unstubAllGlobals()
})

describe('server TTS', () => {
  it('sends nothing while unconfirmed', async () => {
    setPrivateNetworkConfirmed(false)
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { calls.push(url); return new Response('') }))
    // No `speechSynthesis` in the Node harness; `speak` must cope with that rather than throw, which
    // is also what a browser with speech disabled looks like.
    vi.stubGlobal('speechSynthesis', undefined)

    speak('the freezer door is open')
    await new Promise((r) => setTimeout(r, 0))

    expect(calls).toHaveLength(0)
  })
})
