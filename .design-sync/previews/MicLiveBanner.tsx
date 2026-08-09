import { MicLiveBanner } from 'client'

/**
 * The verdigris "microphone is live" banner. It takes no props and cannot be disabled — it is
 * driven by global mic state and must appear on any screen whenever the mic is open.
 */
export const Default = () => <MicLiveBanner />
