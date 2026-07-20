import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createRecognizer, speak as speakText, cancelSpeech, speechSupported } from './speech'
import type { Recognizer } from './speech'

/** Auto-stop after this much trailing silence (spec: ~5 seconds), reset whenever speech is heard. */
const SILENCE_MS = 5000

/**
 * Global voice state. Push-to-talk only — the mic never opens without an explicit start, and
 * whenever it is open {@link micLive} is true so the privacy banner shows on every screen. On a
 * final transcript the text is handed back to the caller (which routes it through the Stage 7
 * assistant); replies are spoken on-device. No wake word, no always-listening.
 */
interface VoiceState {
  supported: boolean
  micLive: boolean
  listening: boolean
  partial: string
  startListening: (onResult: (text: string) => void) => void
  stopListening: () => void
  speak: (text: string) => void
}

const VoiceContext = createContext<VoiceState | null>(null)

export function VoiceProvider({ children }: { children: ReactNode }) {
  const [micLive, setMicLive] = useState(false)
  const [listening, setListening] = useState(false)
  const [partial, setPartial] = useState('')

  const recognizerRef = useRef<Recognizer | null>(null)
  const silenceTimer = useRef<number | undefined>(undefined)
  const onResultRef = useRef<((text: string) => void) | null>(null)
  const supported = speechSupported()

  const cleanup = useCallback(() => {
    window.clearTimeout(silenceTimer.current)
    recognizerRef.current = null
    setMicLive(false)
    setListening(false)
    setPartial('')
  }, [])

  const stopListening = useCallback(() => {
    // Triggers the recognizer's end → onFinal, which finalizes state.
    recognizerRef.current?.stop()
    window.clearTimeout(silenceTimer.current)
  }, [])

  const startListening = useCallback(
    (onResult: (text: string) => void) => {
      if (!supported || recognizerRef.current) return
      cancelSpeech() // don't listen to our own TTS
      onResultRef.current = onResult

      const armSilence = () => {
        window.clearTimeout(silenceTimer.current)
        silenceTimer.current = window.setTimeout(() => recognizerRef.current?.stop(), SILENCE_MS)
      }

      const recognizer = createRecognizer({
        onSpeech: armSilence,
        onPartial: setPartial,
        onFinal: (text) => {
          const handler = onResultRef.current
          cleanup()
          if (text) handler?.(text)
        },
        onError: () => cleanup(),
      })
      if (!recognizer) return

      recognizerRef.current = recognizer
      setMicLive(true)
      setListening(true)
      setPartial('')
      recognizer.start()
      armSilence()
    },
    [supported, cleanup],
  )

  const speak = useCallback((text: string) => speakText(text), [])

  // Ensure the mic is released if the provider unmounts.
  useEffect(() => () => {
    recognizerRef.current?.stop()
    window.clearTimeout(silenceTimer.current)
    cancelSpeech()
  }, [])

  const value = useMemo<VoiceState>(
    () => ({ supported, micLive, listening, partial, startListening, stopListening, speak }),
    [supported, micLive, listening, partial, startListening, stopListening, speak],
  )

  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>
}

// eslint-disable-next-line react-refresh/only-export-components
export function useVoice(): VoiceState {
  const ctx = useContext(VoiceContext)
  if (!ctx) throw new Error('useVoice must be used within a VoiceProvider')
  return ctx
}
