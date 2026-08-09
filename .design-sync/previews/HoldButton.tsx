import { HoldButton } from 'client'

/** The default hold: press and keep pressing until the fill completes. A plain tap does nothing. */
export const Default = () => <HoldButton onHold={() => {}}>Reset the drawer</HoldButton>

/** Destructive actions take the terracotta treatment and a 2s hold. */
export const Destructive = () => (
  <HoldButton onHold={() => {}} ms={2000} destructive>
    Delete this entry
  </HoldButton>
)

/** `meta` carries the second line — here, why the action is worth pausing over. */
export const WithMeta = () => (
  <HoldButton onHold={() => {}} destructive meta="Invalidates the reading until the next cycle">
    Reset waste drawer
  </HoldButton>
)

/** Disabled states say why on the meta line rather than going quiet. */
export const Disabled = () => (
  <HoldButton onHold={() => {}} disabled meta="Robot unreachable — retrying">
    Start clean cycle
  </HoldButton>
)

/**
 * `progressTrack` renders the hold as a slim track under the label instead of a fill sweeping the
 * whole block — for full-width bands where a background sweep would read as selection.
 */
export const ProgressTrack = () => (
  <HoldButton onHold={() => {}} progressTrack meta="Runs about 12 minutes">
    Start clean cycle
  </HoldButton>
)
