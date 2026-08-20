import { Icon } from '../icons/Icon'
import { useUpdate } from '../app/UpdateProvider'
import { appliedAt, plateVersion } from '../app/appUpdate'

/**
 * The panel update plate (`design_handoff_update_notice`).
 *
 * <b>Full-bleed at the very top of the Dashboard, above the clock, and not dismissible.</b> It is
 * the severe-weather banner pattern the product already owns, in brass rather than amber: an update
 * that is downloaded and waiting is exactly the case that justifies spending the loudest device the
 * system has. It appears when the next build is ready, stands until it is applied, never
 * re-announces itself, and there is no state in which the panel is out of date and silent about it.
 *
 * <b>One control.</b> APPLY NOW is the whole interaction — deferring is what not pressing it does.
 * No LATER, no DISMISS, no release notes.
 *
 * The plate holds its position through the sequence and changes its own fill: brass while ready and
 * applying, verdigris when it has landed, danger if it did not.
 *
 * <b>Where the copy departs from the handoff, and why.</b> The pack was written for panel software
 * that is written to disk and restarts the machine — "Restarts the panel once. About three minutes.
 * Keep the panel plugged in." None of that is true here: this is a page reload of a few seconds, no
 * restart and nothing to keep plugged in. The pack's own rule is that the copy states the real
 * duration and changes with it, so it does. Every other word is the pack's.
 *
 * @category Status
 */
export function UpdatePlate() {
  const { status, version, runningVersion, at, apply } = useUpdate()
  const coming = plateVersion(version)
  const now = plateVersion(runningVersion)

  if (status === 'none' || status === 'restarting') return null

  if (status === 'applied') {
    return (
      <div className="ml-plate ml-plate--applied" role="status">
        <span className="ml-plate__glyph" aria-hidden="true">
          <Icon id="ico-check" size="1.5rem" />
        </span>
        <span className="ml-plate__body">
          <span className="ml-plate__label">{coming ? `Now on ${coming}` : 'Now up to date'}</span>
          <span className="ml-plate__sub">
            {at ? `Applied at ${appliedAt(at)}. Clears on its own.` : 'Clears on its own.'}
          </span>
        </span>
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div className="ml-plate ml-plate--failed" role="alert">
        {/* A square, not a glyph. The download mark says something is coming and the check says it
            arrived; neither is true here, and there is no third icon in the house that means "it
            did not". */}
        <span className="ml-plate__square" aria-hidden="true" />
        <span className="ml-plate__body">
          <span className="ml-plate__label">{coming ? `${coming} didn’t apply` : 'The update didn’t apply'}</span>
          <span className="ml-plate__sub">
            {`Still on ${now}, running as before. Nothing was lost.`}
          </span>
        </span>
        {/* Theirs to press. A failed apply never retries on its own — a panel looping over a write
            that does not work is a panel nobody can interrupt. */}
        <button type="button" className="ml-plate__action" onClick={apply}>Try again</button>
      </div>
    )
  }

  if (status === 'applying') {
    return (
      <div className="ml-plate ml-plate--applying" role="status">
        <span className="ml-plate__glyph" aria-hidden="true">
          <Icon id="ico-download" size="1.5rem" />
        </span>
        <span className="ml-plate__body">
          <span className="ml-plate__label">{coming ? `Applying ${coming}` : 'Applying'}</span>
          {/*
            Indeterminate, and no percentage beside it.
            The handoff draws a determinate gauge at 58%, and says in the same breath that it is
            determinate only if the writer reports progress — never a fake timer. Nothing here
            reports progress: by the time this plate is up the build is already downloaded and
            warmed, and what is left is a worker handing over, which takes as long as it takes. A
            sweeping fill says "working" honestly; a number would be invented.
          */}
          <span className="ml-plate__track"><span className="ml-plate__fill" /></span>
          <span className="ml-plate__sub">Nothing to do. It reloads itself when it is ready.</span>
        </span>
      </div>
    )
  }

  return (
    <div className="ml-plate ml-plate--ready" role="status">
      <span className="ml-plate__glyph" aria-hidden="true">
        <Icon id="ico-download" size="1.5rem" />
      </span>
      <span className="ml-plate__body">
        <span className="ml-plate__label">{coming ? `Update ready · ${coming}` : 'Update ready'}</span>
        <span className="ml-plate__sub">Reloads the panel once. A few seconds.</span>
      </span>
      <button type="button" className="ml-plate__action" onClick={apply}>Apply now</button>
    </div>
  )
}

/**
 * The one moment the panel is not itself: no plate, no nav, no Dashboard.
 *
 * <b>No gauge.</b> A panel cannot report on itself while it is going away, so it does not pretend
 * to. What it can do is say what is happening and how long, which is the whole of the screen.
 *
 * It is on screen for about a second here rather than the two minutes a firmware write would take —
 * but the alternative is a white flash and a screen that reappears having silently changed, and
 * this covers the slow case (a cold server, a phone on mobile data) with the same words.
 *
 * @category Status
 */
export function RestartingScreen({ version }: { version: string | null }) {
  const coming = plateVersion(version)
  return (
    <div className="ml-restarting" role="status">
      <div className="ml-restarting__col">
        <span className="ml-restarting__label">Reloading</span>
        {coming && <span className="ml-restarting__version serif">{coming}</span>}
        {/* The signature mark itself, not a copy of it — at column width, doing here what it does
            under every screen title: saying this is the panel's own business. */}
        <div className="ml-doublerule ml-doublerule--bare" aria-hidden="true">
          <div className="ml-doublerule__brass" />
          <div className="ml-doublerule__gap" />
          <div className="ml-doublerule__hair" />
        </div>
        {/* Two lines, broken where the handoff breaks them — how long, then what is being asked of
            you. Left to wrap on its own in a 300px column it would break mid-sentence. */}
        <span className="ml-restarting__sub">
          A few seconds.<br />Nothing needs doing.
        </span>
      </div>
    </div>
  )
}
