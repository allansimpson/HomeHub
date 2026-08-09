import { useCallback, useMemo } from 'react'
import { useAssist } from '../../app/AssistProvider'
import { selectTurns } from '../../app/assistTurns'
import type { AssistTurn, TurnAttachment } from '../../app/assistTurns'

/** What the screen renders for a turn that is not in the stored transcript yet. */
export type PendingTurn = AssistTurn

/**
 * The turns being written for one conversation — none, one, or one and a short queue behind it.
 *
 * <b>A view, not an owner.</b> This used to run the stream itself, in the chat screen's own state,
 * with an unmount handler that aborted the request — so leaving the screen destroyed the turn, and
 * because nothing is written until a turn ends, it destroyed the member's message with it. The
 * machinery moved to `app/assistTurns.ts`, above the router, where navigation cannot reach it. What
 * is left here is a lookup: the screen asks what is in flight for the chat it is showing, and gets
 * the same answer whether it has been mounted for ten seconds or ten milliseconds.
 *
 * <b>It returns a list now.</b> Sending a second message while a reply is still arriving used to be
 * impossible — the composer was disabled for the duration — so one turn per chat was all there was
 * to look up. A chat can now hold a queue, and the screen draws all of it: the reply in progress, and
 * under it the messages already accepted and waiting their go.
 */
export function useStreamedTurn(conversationId: number | null) {
  const { turns, runTurn, cancelTurn, settleTurn, clearTurn, retryTurn } = useAssist()

  const pending = useMemo(() => selectTurns(turns, conversationId), [turns, conversationId])

  /**
   * The one being written right now, if any.
   *
   * The first that has not finished — which is the only one that can be, because the store runs a
   * chat's turns strictly in order. What the composer's square reads to know whether it is a Stop,
   * and what that Stop then acts on.
   */
  const live = useMemo(() => pending.find((t) => !t.done && !t.error) ?? null, [pending])

  const run = useCallback(
    (prompt: string, attachment?: TurnAttachment | null) => runTurn(conversationId, prompt, attachment),
    [runTurn, conversationId],
  )

  return {
    /**
     * Every turn on screen but not in the ledger: in flight, queued, recovering, or failed.
     *
     * In the order they were sent. At most one is being written at any moment — the store runs a
     * chat's turns strictly in order — so the screen does not have to work out which is live.
     */
    pending,
    live,
    run,
    cancel: cancelTurn,
    settle: settleTurn,
    dismiss: clearTurn,
    retry: retryTurn,
  }
}
