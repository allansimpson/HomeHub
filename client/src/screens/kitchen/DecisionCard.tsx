import type { ReactNode } from 'react'

/** One way out of the disagreement. Exactly one is the likely answer and reads in brass. */
export interface DecisionChoice {
  label: string
  onChoose: () => void
  /** The likely answer. One per card, or none where the app genuinely has no opinion. */
  primary?: boolean
  disabled?: boolean
}

interface DecisionCardProps {
  /** What the disagreement is about. */
  item: string
  /** `NOT WHAT WAS ASKED FOR`, `TOO MUCH FOR ONE ITEM`, `CAN'T SAY HOW MUCH IS LEFT`. */
  kind: string
  /** Left column heading — `WANTED` on the review, `ON THE LIST` when putting away. */
  leftLabel: string
  leftValue: string
  /** Right column heading — `IN THE PANTRY`, `CAME HOME`. */
  rightLabel: string
  rightValue: string
  /**
   * Why the panel cannot decide this one — the sentence under the two columns.
   *
   * The columns show *what* disagrees; this says *why it matters*, which is what the household is
   * actually being asked to rule on ("the amount was never counted, so it may be wrong either
   * way"). Without it the card asks a three-way question and supplies no grounds for answering it.
   */
  why?: string
  choices: DecisionChoice[]
  /** A stepper or field the chosen answer needs, e.g. how many bags a split makes. */
  extra?: ReactNode
}

/**
 * The shared decision card (LIST_AND_SHOPPING §2 and §4).
 *
 * The review and the put-away use the *same* card on purpose: both ask the household to settle a
 * disagreement between what the app believed and what turned out to be true. So the disagreement is
 * **shown as data** — two columns, believed against actual — rather than described in a sentence
 * somebody has to parse to work out which number is which.
 *
 * **Every alternative is a bordered control.** Borderless text collapses to about an 11px hit
 * target and reads as a caption on the primary rather than a choice beside it — which is how a
 * three-way question quietly becomes a one-way one.
 *
 * **Cards are sized to their content**, never to a shared height: a card padded out to match its
 * neighbour implies there is something in it that isn't.
 */
export function DecisionCard({
  item, kind, leftLabel, leftValue, rightLabel, rightValue, why, choices, extra,
}: DecisionCardProps) {
  return (
    <div className="ml-kitchen__card">
      <div className="ml-kitchen__cardname">{item}</div>
      <div className="ml-kitchen__cardkind">{kind}</div>

      {/* Believed against actual, in the two-column form the item sheet uses. */}
      <div className="ml-kitchen__cardpair">
        <div className="ml-kitchen__cardside">
          <span className="ml-kitchen__factlabel">{leftLabel}</span>
          <span className="ml-kitchen__cardvalue">{leftValue}</span>
        </div>
        <div className="ml-kitchen__cardside">
          <span className="ml-kitchen__factlabel">{rightLabel}</span>
          <span className="ml-kitchen__cardvalue">{rightValue}</span>
        </div>
      </div>

      {why && <div className="ml-kitchen__cardwhy">{why}</div>}

      {extra && <div className="ml-kitchen__cardextra">{extra}</div>}

      <div className="ml-kitchen__cardchoices">
        {choices.map((choice) => (
          <button
            key={choice.label}
            type="button"
            className={
              'ml-kitchen__cardchoice'
              + (choice.primary ? ' ml-kitchen__cardchoice--likely' : '')
            }
            disabled={choice.disabled}
            onClick={choice.onChoose}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  )
}
