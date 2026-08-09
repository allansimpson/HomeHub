import type { SearchHit, SearchResults as Results } from '../../api/types'
import { conversationTime } from './assistTime'

interface Props {
  results: Results | null
  /** A query is in flight and there is nothing to show yet. */
  searching: boolean
  onOpen: (id: number) => void
}

/**
 * Search results (ASSIST.md · `1i`).
 *
 * **Per match, not per chat.** A conversation that mentions the boiler four times is four rows, and
 * that is the whole reason this is a different view rather than a filter over the inbox: the answer
 * to "when did we talk about the boiler" is a line someone said, not a chat title.
 *
 * Full transcripts, current agent, active *and* archived, matched on the home server. Archived hits
 * are not excluded — they carry a chip instead, because a conversation being out of the way is not
 * the same as it being irrelevant, and a search that silently skipped them would be lying about
 * what the household said.
 */
export function SearchResults({ results, searching, onOpen }: Props) {
  if (!results) {
    return searching ? <div className="ml-search__status">Searching…</div> : null
  }

  if (results.hits.length === 0) {
    return <div className="ml-search__status">No matches.</div>
  }

  const { matches, conversations } = results

  return (
    <>
      <div className="ml-search__header">
        {`${matches} ${matches === 1 ? 'match' : 'matches'} · ${conversations} ${conversations === 1 ? 'chat' : 'chats'} · Includes archive`}
      </div>

      {results.hits.map((hit, i) => (
        // Nothing in a hit is unique on its own — the same chat appears once per match — so the key
        // is the position, which is stable for a given result set.
        <button
          key={`${hit.conversationId}:${i}`}
          type="button"
          className="ml-searchhit"
          onClick={() => onOpen(hit.conversationId)}
        >
          <span className="ml-searchhit__top">
            <span className="ml-searchhit__title">{hit.title}</span>
            {hit.archived && <span className="ml-searchhit__chip">Archived</span>}
            <span className="ml-searchhit__time">{conversationTime(hit.atUtc)}</span>
          </span>
          <span className="ml-searchhit__line">{highlight(hit)}</span>
        </button>
      ))}
    </>
  )
}

/**
 * Mark the matched term inside the snippet.
 *
 * The offset comes from the server rather than being re-found here, because re-finding it would
 * highlight the *first* occurrence in the snippet and the server matched a specific one. On a line
 * that says the same word twice, those are different places.
 */
function highlight(hit: SearchHit) {
  const { snippet, matchStart: start, matchLength: len } = hit
  if (start < 0 || len <= 0 || start + len > snippet.length) return snippet

  return (
    <>
      {snippet.slice(0, start)}
      <mark className="ml-searchhit__mark">{snippet.slice(start, start + len)}</mark>
      {snippet.slice(start + len)}
    </>
  )
}
