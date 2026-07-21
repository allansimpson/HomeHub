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

/** Speak text through the on-device synthesizer. Cancels any in-progress utterance first.
 * `handlers` let callers track real playback start/end (drives the Speaking UI — THE_ATTENDANT.md). */
export function speak(text: string, handlers?: { onStart?: () => void; onEnd?: () => void }): void {
  if (!('speechSynthesis' in window) || !text) {
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

export function cancelSpeech(): void {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
}
