/**
 * Verdigris "microphone is live" banner. Privacy-forward: it MUST appear on ANY screen
 * whenever the mic is open (driven by global mic state from Stage 7+). It cannot be
 * disabled. Rendered at the app root so it is never scoped to the assistant screen.
 */
export function MicLiveBanner() {
  return (
    <div className="ml-miclive" role="status">
      <span className="ml-miclive__dot" aria-hidden="true" />
      <span className="ml-miclive__text">Microphone is live — Central is listening</span>
    </div>
  )
}
