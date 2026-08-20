import { useEffect } from 'react'

/**
 * A kept photograph, whole (screens 13–14).
 *
 * <b>Why the SOURCE block needed something to open into.</b> The block draws the flyer at a fixed
 * 230px under `object-fit: cover`, which is right for a block that has to sit in a column of rows and
 * keep its shape whatever aspect the camera produced — but cover *crops*, and a portrait flyer loses
 * its top and bottom to it. The whole reason the photograph is kept at all is so somebody can go back
 * and check what was actually printed: the cost, the room, the line the reading did not take. A
 * preview that cannot show that is a preview of the wrong thing.
 *
 * So this is `contain` against a scrim, and nothing else. No zoom, no pan, no rotate: the panel is a
 * wall-mounted screen that people walk up to, the picture is already upright (the client re-encodes
 * from an orientation-corrected bitmap — see `assist/attachments.downscale`), and a gesture surface
 * on a kiosk is a thing to get stuck in rather than a thing to use.
 *
 * <b>Dismissal is deliberately over-served.</b> Tapping the picture is what somebody who opened it by
 * tapping the picture will try first, so the whole overlay closes on press; CLOSE is drawn as well
 * because a full-screen image with no visible way out is the one state on a household panel where
 * somebody fetches another person. Escape is for the desk browser this is developed in.
 */
export function PhotoViewer({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    // The dismiss target is the overlay itself rather than a scrim behind the picture: a tap that
    // lands on the flyer has to close it too, and the picture covers most of what there is to tap.
    <div
      className="ml-photoview"
      role="dialog"
      aria-modal="true"
      aria-label="The photograph this engagement was read from"
      onClick={onClose}
    >
      <img className="ml-photoview__img" src={src} alt="The photograph this engagement was read from" />
      <button type="button" className="ml-photoview__close" onClick={onClose}>Close</button>
    </div>
  )
}
