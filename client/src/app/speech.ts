/**
 * Swappable speech layer. The default is the browser's on-device recognizer (Web Speech API) +
 * speech synthesis — works in the kiosk's Chromium with no keys and keeps audio handling local.
 * A server-STT path (see /api/voice/transcribe) can replace the recognizer without touching the
 * VoiceProvider. TTS is always on-device.
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
      if (result.isFinal) finalText += transcript
      else interim += transcript
    }
    handlers.onSpeech?.()
    handlers.onPartial((finalText + interim).trim())
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
 * Speak text in the app's central voice (server TTS) when available, else the browser's on-device
 * synthesizer. Cancels any in-progress speech first. `handlers` fire on real playback start/end so
 * the Speaking UI (THE_ATTENDANT.md) tracks actual audio, not "reply received".
 */
export function speak(text: string, handlers?: SpeakHandlers, prosody: Prosody = 'neutral'): void {
  if (!text) {
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
    const res = await fetch('/api/voice/speak', {
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
