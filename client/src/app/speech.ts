import { authorizedFetch } from '../api/privateNetwork'

/**
 * Swappable speech layer. The default is the browser's on-device recognizer (Web Speech API) +
 * speech synthesis — works in the kiosk's Chromium with no keys and keeps audio handling local.
 * A server-STT path (see /api/voice/transcribe) can replace the recognizer without touching the
 * VoiceProvider. TTS is always on-device.
 *
 * Speaking is switched off at the moment — see `SPEECH_ENABLED` below.
 */

export interface Recognizer {
  start: () => void
  stop: () => void
}

export interface RecognizerHandlers {
  /** Interim + accumulated transcript, for the live "HEARING…" display. */
  onPartial: (text: string) => void
  /** Full transcript once recognition ends (auto-stop or manual). */
  onFinal: (text: string) => void
  /** Fired whenever speech is detected, so the caller can reset the trailing-silence timer. */
  onSpeech?: () => void
  onError?: (message: string) => void
}

// Minimal Web Speech API typings (not in the default DOM lib).
interface SpeechRecognitionResultLike {
  0: { transcript: string }
  isFinal: boolean
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionLike {
  continuous: boolean
  interimResults: boolean
  lang: string
  start: () => void
  stop: () => void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/** Lowercase, unpunctuated, single-spaced — for comparing two drafts of the same words. */
const normalize = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()

/**
 * Add a finished segment to the transcript so far.
 *
 * **Not an append**, because a segment is not always new words. Chrome hands each finished phrase over
 * once and appending is right; Safari — the phones, not the kiosk — re-states the *whole* utterance
 * every time it revises it, and marks each draft final. So one breath of "testing can you hear me now"
 * arrives as eight final results: `testing`, `testing`, `testing`, `testing can`, `testing can you`,
 * and so on. Glued together verbatim that is the
 * `testingtestingtestingtesting cantesting can you…` transcript the household actually saw — the mic
 * heard perfectly, the drafts were stacked.
 *
 * When one of the two restates the other, the longer one wins and the shorter is dropped. Otherwise
 * they are separate phrases and get joined with the space that `+=` never inserted.
 *
 * The cost is a real one, and small: say "testing", pause past the recognizer's phrase break, then say
 * "testing can you hear me now", and the first is folded away as a draft of the second. Two phrases
 * where one opens the other are rare; a spoken sentence arriving eight times over was every phone in
 * the house.
 */
export function foldTranscript(soFar: string, segment: string): string {
  const next = segment.trim()
  if (!next) return soFar
  if (!soFar) return next

  const a = normalize(soFar)
  const b = normalize(next)
  if (b.startsWith(a)) return next // a revision that grew — keep it
  if (a.startsWith(b)) return soFar // a revision that shrank — keep what we had
  return `${soFar} ${next}`
}

function getRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export function speechSupported(): boolean {
  return getRecognitionCtor() !== undefined
}

export function createRecognizer(handlers: RecognizerHandlers): Recognizer | null {
  const Ctor = getRecognitionCtor()
  if (!Ctor) return null

  const recognition = new Ctor()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = 'en-US'

  let finalText = ''

  recognition.onresult = (e) => {
    let interim = ''
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i]
      const transcript = result[0].transcript
      // Folded rather than concatenated — see `foldTranscript`. A final result is not reliably a new
      // phrase; on Safari it is usually the same phrase said better.
      if (result.isFinal) finalText = foldTranscript(finalText, transcript)
      else interim = foldTranscript(interim, transcript)
    }
    handlers.onSpeech?.()
    // The live band gets the same treatment, so what you watch being heard is what gets sent.
    handlers.onPartial(foldTranscript(finalText, interim))
  }
  recognition.onend = () => handlers.onFinal(finalText.trim())
  recognition.onerror = (e) => handlers.onError?.(e.error ?? 'recognition-error')

  return {
    start: () => {
      finalText = ''
      recognition.start()
    },
    stop: () => recognition.stop(),
  }
}

interface SpeakHandlers {
  onStart?: () => void
  onEnd?: () => void
}

// Central voice availability, discovered lazily on first use and cached: null = unknown, true =
// server Piper TTS in play, false = fall back to the browser synthesizer.
let serverTts: boolean | null = null
let activeAudio: HTMLAudioElement | null = null

/**
 * How a line should be delivered. Chosen at the call site — Piper ignores it today, but the server
 * carries it to Chatterbox after the GPU migration with no change here.
 */
export type Prosody = 'neutral' | 'urgent' | 'warm' | 'subdued'

/**
 * TEMPORARY — the panel does not speak.
 *
 * Held here rather than at the call site on purpose: this is the one place both routes (server Piper
 * and the browser synthesizer) pass through, so nothing can start speaking around it. Recognition is
 * untouched — the mic still hears you, the reply is still written, it is only read aloud that stops.
 *
 * Flip back to `true` to restore the voice. Nothing else needs changing.
 */
const SPEECH_ENABLED = false

/**
 * Whether the panel will read anything aloud.
 *
 * For the surfaces whose behaviour only makes sense *because* a reply is spoken — the inbox answers a
 * spoken turn without opening the chat, on the grounds that you are listening rather than looking.
 * With the voice off that reasoning inverts, and they need to know.
 */
export function speechEnabled(): boolean {
  return SPEECH_ENABLED
}

/**
 * Speak text in the app's central voice (server TTS) when available, else the browser's on-device
 * synthesizer. Cancels any in-progress speech first. `handlers` fire on real playback start/end so
 * the Speaking UI (THE_ATTENDANT.md) tracks actual audio, not "reply received".
 */
export function speak(text: string, handlers?: SpeakHandlers, prosody: Prosody = 'neutral'): void {
  if (!text || !SPEECH_ENABLED) {
    // `onEnd` without `onStart` is the same shape as a line with nothing in it to say, which the
    // Speaking indicator already handles: it never appears, rather than appearing and hanging.
    handlers?.onEnd?.()
    return
  }
  cancelSpeech()
  if (serverTts === false) {
    speakViaBrowser(text, handlers)
  } else {
    void speakViaServer(text, handlers, prosody)
  }
}

async function speakViaServer(text: string, handlers?: SpeakHandlers, prosody: Prosody = 'neutral'): Promise<void> {
  try {
    // Through the authorised transport, not `fetch`: the house voice is an authenticated endpoint,
    // and a panel that has not confirmed who is asking must not be sending it text to speak. The
    // refusal lands in the `catch` below and falls back to the browser voice, which is the same
    // behaviour as a server that is not configured for TTS — so a device-only panel still talks.
    const res = await authorizedFetch('/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Assistant replies are one-off text; caching them would fill the cache with lines never
      // spoken twice. Fixed phrases (alerts, cues) leave allowCache on.
      body: JSON.stringify({ text, prosody, allowCache: prosody !== 'warm' }),
    })
    if (!res.ok) {
      serverTts = false // 501 (not configured) / 502 — this session uses the browser voice
      speakViaBrowser(text, handlers)
      return
    }
    serverTts = true
    const url = URL.createObjectURL(await res.blob())
    const audio = new Audio(url)
    activeAudio = audio
    const cleanup = () => {
      URL.revokeObjectURL(url)
      if (activeAudio === audio) activeAudio = null
    }
    audio.onplay = () => handlers?.onStart?.()
    audio.onended = () => { cleanup(); handlers?.onEnd?.() }
    audio.onerror = () => { cleanup(); speakViaBrowser(text, handlers) }
    await audio.play()
  } catch {
    serverTts = false
    speakViaBrowser(text, handlers)
  }
}

function speakViaBrowser(text: string, handlers?: SpeakHandlers): void {
  if (!('speechSynthesis' in window)) {
    handlers?.onEnd?.()
    return
  }
  window.speechSynthesis.cancel()
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.rate = 1
  if (handlers?.onStart) utterance.onstart = () => handlers.onStart!()
  if (handlers?.onEnd) {
    utterance.onend = () => handlers.onEnd!()
    utterance.onerror = () => handlers.onEnd!()
  }
  window.speechSynthesis.speak(utterance)
}

/** Stop any in-progress speech (browser utterance and/or central-voice audio). */
export function cancelSpeech(): void {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  if (activeAudio) {
    activeAudio.onended = null
    activeAudio.onerror = null
    activeAudio.pause()
    activeAudio = null
  }
}
