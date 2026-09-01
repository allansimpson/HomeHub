import { useNavigate } from 'react-router'
import { confirmationProse, offerProse, receiptLines } from './recipeCapture'
import type { RecipeCapture as Capture } from './useRecipeCapture'

interface Props {
  capture: Capture
  agentName: string
  /** YES, with the recipe this is a variation of, or null for a recipe of its own. */
  onSave: (forkOf: number | null) => void
  /** There is no recipe written out, but there is a link. Try it. */
  onTryLink: () => void
  /** NO, or DISCARD. Nothing has been written. */
  onDismiss: () => void
  onUndo: () => void
}

/**
 * Everything "save this recipe" says on the transcript, from looking back to the receipt.
 *
 * Each stage is one block at the foot of the conversation in the agent's own turn shape, because
 * that is what it is: Barnaby answering something somebody said to the panel. It reuses the photo
 * capture's blocks exactly — the same reading bar, the same fault strip, the same IT TOUCHED rows —
 * since a household should not have to learn two vocabularies for "the panel read something and is
 * offering to write it down".
 */
export function RecipeCapture({ capture, agentName, onSave, onTryLink, onDismiss, onUndo }: Props) {
  const navigate = useNavigate()

  return (
    <>
      {/*
        The member's own words.

        No turn is carrying them — this request is never sent to the agent (`useRecipeCapture`) — and
        a panel that swallowed the instruction and started talking about recipes would be answering
        something nobody could see they had asked.
      */}
      <div className="ml-turn ml-turn--user">
        <div className="ml-turn__text">{capture.asked}</div>
      </div>

      <div className="ml-turn ml-turn--assistant">
        <div className="ml-turn__label">{agentName}</div>

        {capture.stage === 'reading' && (
          <>
            <div className="ml-turn__text">Looking back through this…</div>
            {/* Indeterminate, and honest about it: nothing downstream reports progress. */}
            <div className="ml-capture__track" aria-hidden="true"><span className="ml-capture__fill" /></div>
          </>
        )}

        {capture.stage === 'saving' && (
          <>
            <div className="ml-turn__text">Filing it…</div>
            <div className="ml-capture__track" aria-hidden="true"><span className="ml-capture__fill" /></div>
          </>
        )}

        {capture.stage === 'offline' && (
          <>
            <div className="ml-turn__text">
              The house is off the network, so I can’t read this back yet. I’m holding it — I’ll look
              the moment we’re back.
            </div>
            <div className="ml-capture__fault">
              <span className="ml-capture__faultsquare" aria-hidden="true" />
              <span className="ml-capture__faulttext">No network</span>
              <span className="ml-capture__faultstate">Retrying</span>
            </div>
            <div className="ml-capture__actions">
              <button type="button" className="ml-capture__btn" onClick={onDismiss}>Discard</button>
            </div>
          </>
        )}

        {capture.stage === 'none' && <Nothing capture={capture} onTryLink={onTryLink} onDismiss={onDismiss} />}

        {capture.stage === 'offer' && capture.reading && (
          <>
            <div className="ml-turn__text">{offerProse(capture.reading)}</div>
            <div className="ml-capture__actions">
              {capture.reading.existing ? (
                <>
                  <button
                    type="button"
                    className="ml-capture__btn ml-capture__btn--go"
                    onClick={() => onSave(capture.reading!.existing!.id)}
                  >
                    A variation
                  </button>
                  <button
                    type="button"
                    className="ml-capture__btn ml-capture__btn--alt"
                    onClick={() => onSave(null)}
                  >
                    Its own recipe
                  </button>
                </>
              ) : (
                <button type="button" className="ml-capture__btn ml-capture__btn--go" onClick={() => onSave(null)}>
                  Save it
                </button>
              )}
              <button type="button" className="ml-capture__btn" onClick={onDismiss}>Not now</button>
            </div>
          </>
        )}

        {capture.stage === 'written' && capture.saved && (
          <>
            <div className="ml-turn__text">{confirmationProse(capture.saved)}</div>
            <div className="ml-touched">
              <span className="ml-touched__label">It touched</span>
              {receiptLines(capture.saved).map((line) => (
                <span key={line} className="ml-touched__row">
                  <span className="ml-touched__mark ml-touched__mark--written" aria-hidden="true" />
                  <span className="ml-touched__text">{line}</span>
                </span>
              ))}
            </div>
            <div className="ml-capture__actions">
              <button
                type="button"
                className="ml-capture__btn ml-capture__btn--alt"
                onClick={() => navigate(`/kitchen/recipes/${capture.saved!.id}`)}
              >
                See it
              </button>
              <button type="button" className="ml-capture__btn" onClick={onUndo}>Undo</button>
            </div>
          </>
        )}
      </div>
    </>
  )
}

/**
 * Nothing to save — and the two quite different reasons for it.
 *
 * <b>A link is a way forward, not a consolation.</b> A chat that is "have a look at this" and an
 * address has told the panel exactly where the recipe is, and the link importer is the path built
 * for that. Everything else offers the add screen with what was said already in the box, so the
 * work of copying the recipe out of the conversation is not handed back to the household.
 */
function Nothing({ capture, onTryLink, onDismiss }: {
  capture: Capture
  onTryLink: () => void
  onDismiss: () => void
}) {
  const navigate = useNavigate()
  const link = capture.reading?.link ?? null
  // The longest thing said, which is the likeliest to be the recipe that would not parse. Better in
  // the box than a blank screen and the transcript to scroll back through.
  const fullest = [...capture.said].sort((a, b) => b.length - a.length)[0] ?? ''

  return (
    <>
      <div className="ml-turn__text">
        {capture.reason ?? 'I can’t find a recipe in what we’ve said.'}
        {link ? ' Shall I try it?' : ' Paste the ingredients and the method and I’ll read them.'}
      </div>
      <div className="ml-capture__actions">
        {link && (
          <button type="button" className="ml-capture__btn ml-capture__btn--go" onClick={onTryLink}>
            Try the link
          </button>
        )}
        <button
          type="button"
          className={'ml-capture__btn' + (link ? ' ml-capture__btn--alt' : ' ml-capture__btn--go')}
          onClick={() => navigate('/kitchen/recipes/add', { state: { text: fullest } })}
        >
          Add it myself
        </button>
        <button type="button" className="ml-capture__btn" onClick={onDismiss}>Leave it</button>
      </div>
    </>
  )
}
