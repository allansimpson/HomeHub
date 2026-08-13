import { useRef } from 'react'
import { Icon } from '../icons/Icon'

/**
 * The empty-state offer (screen 16).
 *
 * Between the double rule and TITLE, and <b>only while the form is untouched</b> — it is an offer,
 * not permanent furniture, and a form somebody has started typing into has already answered it.
 */
export function ReadFromPhotoRow({ onOpen }: { onOpen: () => void }) {
  return (
    <button type="button" className="ml-readphoto" onClick={onOpen}>
      <Icon id="ico-camera" size="1.5rem" />
      <span className="ml-readphoto__body">
        <span className="ml-readphoto__label">Read it from a photo</span>
        <span className="ml-readphoto__sub">A flyer, an invitation, a card on the fridge</span>
      </span>
      <span className="ml-readphoto__chev" aria-hidden="true">▸</span>
    </button>
  )
}

/**
 * READ FROM (screen 17) — the attach panel's three sources, camera first.
 *
 * The order is inverted from the chat's on purpose: a flyer in the hand is the common case for
 * somebody who has already opened the form to write it down.
 */
export function ReadFromSheet({ onPick, onCancel }: {
  onPick: (file: File, capture: boolean) => void
  onCancel: () => void
}) {
  const camera = useRef<HTMLInputElement>(null)
  const photo = useRef<HTMLInputElement>(null)
  const file = useRef<HTMLInputElement>(null)

  const take = (input: HTMLInputElement | null, capture: boolean) => {
    const chosen = input?.files?.[0]
    if (chosen) onPick(chosen, capture)
    if (input) input.value = ''
  }

  return (
    <div className="ml-sheetwrap">
      <div className="ml-sheet__scrim ml-sheet__scrim--light" />
      <section className="ml-sheet" role="dialog" aria-label="Read from">
        <header className="ml-sheet__head">
          <span className="ml-sheet__title">Read from</span>
        </header>

        <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={() => take(camera.current, true)} />
        <input ref={photo} type="file" accept="image/*" hidden onChange={() => take(photo.current, false)} />
        <input ref={file} type="file" hidden onChange={() => take(file.current, false)} />

        <button type="button" className="ml-readfrom__row" onClick={() => camera.current?.click()}>
          <Icon id="ico-camera" size="1.375rem" />
          <span>Take a picture</span>
        </button>
        <button type="button" className="ml-readfrom__row" onClick={() => photo.current?.click()}>
          <Icon id="ico-image" size="1.375rem" />
          <span>A photo</span>
        </button>
        <button type="button" className="ml-readfrom__row" onClick={() => file.current?.click()}>
          <Icon id="ico-file" size="1.375rem" />
          <span>A file</span>
        </button>

        <button type="button" className="ml-readfrom__never" onClick={onCancel}>Never mind</button>
      </section>
    </div>
  )
}

/** Reading in place (screen 18). The field rows behind it hold; they do not skeleton or shuffle. */
export function ReadingBlock({ preview }: { preview: string | null }) {
  return (
    <div className="ml-reading">
      {preview
        ? <img className="ml-reading__thumb" src={preview} alt="" />
        : <span className="ml-reading__thumb" aria-hidden="true" />}
      <span className="ml-reading__body">
        <span className="ml-reading__label">Reading the photo</span>
        <span className="ml-reading__track"><span className="ml-reading__fill" /></span>
        <span className="ml-reading__sub">Looking for a date, an hour and a name</span>
      </span>
    </div>
  )
}

/** The source strip once a reading has landed (screen 19). */
export function SourceStrip({ preview, summary, onReplace }: {
  preview: string | null
  summary: string
  onReplace: () => void
}) {
  return (
    <div className="ml-srcstrip">
      {preview
        ? <img className="ml-srcstrip__thumb" src={preview} alt="" />
        : <span className="ml-srcstrip__thumb" aria-hidden="true" />}
      <span className="ml-srcstrip__body">
        <span className="ml-srcstrip__label">Filled from a photo</span>
        <span className="ml-srcstrip__sub">{summary}</span>
      </span>
      <button type="button" className="ml-srcstrip__replace" onClick={onReplace}>Replace</button>
    </div>
  )
}

/**
 * Nothing on it (screen 20).
 *
 * Takes the photo row's place rather than opening anything. The form keeps its defaults and its
 * focus — the person was already writing an engagement, so nothing is cleared and nothing is
 * blocked.
 */
export function NothingToTake({ message, onAnother, onDismiss }: {
  message: string | null
  onAnother: () => void
  onDismiss: () => void
}) {
  return (
    <div className="ml-nothing">
      <span className="ml-nothing__head">
        <span className="ml-nothing__square" aria-hidden="true" />
        <span className="ml-nothing__label">Nothing to take</span>
      </span>
      <p className="ml-nothing__text">
        {message ?? 'No date reads on that photo. The form is yours to fill in by hand, or try another picture in better light.'}
      </p>
      <span className="ml-nothing__actions">
        <button type="button" className="ml-nothing__btn ml-nothing__btn--alt" onClick={onAnother}>Another photo</button>
        <button type="button" className="ml-nothing__btn" onClick={onDismiss}>Dismiss</button>
      </span>
    </div>
  )
}

/**
 * What the photograph says, under a row the household wrote (screen 23).
 *
 * One per field, and no bulk accept — each is a separate small judgement about whose version is
 * right, and a button that took them all would be a button nobody could safely press.
 */
export function PhotoOffer({ value, onTake }: { value: string; onTake: () => void }) {
  return (
    <div className="ml-offer">
      <span className="ml-offer__text">
        Photo says <span className="ml-offer__value">{value}</span>
      </span>
      <button type="button" className="ml-offer__take" onClick={onTake}>Take it</button>
    </div>
  )
}

/** After TAKE IT (screen 24) — names what changed, and puts the typed value back. Per take, not per photo. */
export function TakeUndo({ field, onUndo }: { field: string; onUndo: () => void }) {
  return (
    <div className="ml-srcstrip__taken">
      <span>{field} taken from the photo</span>
      <button type="button" className="ml-srcstrip__undo" onClick={onUndo}>Undo</button>
    </div>
  )
}
