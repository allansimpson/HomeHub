import { Fragment } from 'react'
import { segmentLinks } from './messageLinks'

/**
 * A turn's words, with the links in them tappable.
 *
 * <b>The text is still the text.</b> Every character of the message is rendered, in order, exactly
 * as it was said — the links are a treatment applied to runs of it, not a rewrite (`segmentLinks`
 * guarantees the round trip, and its tests hold that line). A transcript that tidied what it showed
 * would stop being a record of what was said.
 *
 * Long addresses wrap *inside themselves* rather than running off the side. A pasted URL is
 * routinely wider than the column, and the alternatives are both bad: overflow hides the end of it
 * behind the edge of the panel, and truncation hides the end of it full stop. Breaking mid-string is
 * ugly for one line and correct for the one thing anybody does with a URL on a shared screen, which
 * is read it out or check where it goes.
 *
 * `_blank` with `noopener`: the panel is a PWA, and a link that navigated in place would replace the
 * conversation with a web page and leave no way back to it.
 */
export function MessageText({ text }: { text: string }) {
  const segments = segmentLinks(text)

  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === 'link' ? (
          <a
            key={i}
            className="ml-turn__link"
            href={segment.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {segment.text}
          </a>
        ) : (
          <Fragment key={i}>{segment.text}</Fragment>
        ),
      )}
    </>
  )
}
