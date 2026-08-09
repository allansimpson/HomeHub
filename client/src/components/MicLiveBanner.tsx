import { useAssist } from '../app/AssistProvider'
import { WAKE_AGENT_NAME } from '../app/wakeWord'

/**
 * Verdigris "microphone is live" banner. Privacy-forward: it MUST appear on ANY screen
 * whenever the mic is open (driven by global mic state from Stage 7+). It cannot be
 * disabled. Rendered at the app root so it is never scoped to the assistant screen.
 *
 * Names the agent that is actually listening rather than a hard-coded assistant, now that a
 * household can have more than one. The wake-word agent is the fallback because a mic opened by a
 * wake phrase reaches that agent whatever the panel is showing — the bridge has one trained model
 * (`wakeWord.ts`).
 *
 * @category Status
 */
export function MicLiveBanner() {
  const { agent } = useAssist()
  const name = agent?.name ?? WAKE_AGENT_NAME

  return (
    <div className="ml-miclive" role="status">
      <span className="ml-miclive__dot" aria-hidden="true" />
      <span className="ml-miclive__text">{`Microphone is live — ${name} is listening`}</span>
    </div>
  )
}
