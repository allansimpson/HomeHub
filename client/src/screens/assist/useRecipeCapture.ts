import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError } from '../../api/client'
import { useConnection } from '../../app/ConnectionProvider'
import type { RecipeConversationReadingDto, RecipeDto } from '../../api/types'

/**
 * Where a "save this recipe" has got to.
 *
 * `none` is a state and not an absence: the conversation was read, found to hold no recipe, and the
 * panel says so — the member asked a question and is owed an answer to it, even when the answer is
 * that there is nothing there.
 */
export type RecipeStage = 'reading' | 'offer' | 'none' | 'offline' | 'saving' | 'written'

export interface RecipeCapture {
  /** The turn this began on. One capture at a time; a second request replaces the first. */
  id: string
  stage: RecipeStage
  /** What the member typed. Kept for the re-read after a reconnect, and never sent to the agent. */
  asked: string
  /** The transcript as it was when they asked, newest first — the reading indexes into this. */
  said: string[]
  reading: RecipeConversationReadingDto | null
  /** What was written, once it has been. */
  saved: RecipeDto | null
  /** Why there is nothing, in the household's words. */
  reason: string | null
}

/**
 * "Save this recipe", and everything that follows from it.
 *
 * <b>The panel answers this one, and does not spend a turn on it.</b> A bare instruction to file a
 * recipe is addressed to the panel, not to the agent: Barnaby has no recipe tool — the house tool
 * list is short on purpose — so sending it to him buys a sentence about a recipe he cannot save, at
 * the cost of a full turn. The photo-only path in `ChatScreen` makes the same trade for the same
 * reason, and this follows it: the member's words go on screen, the panel does the work underneath
 * them, and the transcript reads as a conversation because that is what it was.
 *
 * <b>The reading is not a model call.</b> The messages are parsed by the same importer the paste
 * box uses (`ConversationRecipeReader` server-side), which is why it can be run on every request
 * without anybody weighing what it costs — and why a recipe saved out of a chat scales, matches the
 * pantry and merges exactly like one saved off a page.
 */
export function useRecipeCapture() {
  const { online } = useConnection()
  const [capture, setCapture] = useState<RecipeCapture | null>(null)

  /** So a reconnect re-reads what was asked rather than what is on screen by then. */
  const held = useRef<{ id: string; said: string[] } | null>(null)

  const read = useCallback(async (id: string, said: string[]) => {
    try {
      const reading = await api.readConversationRecipe({ messages: said })
      setCapture((cur) => {
        if (cur?.id !== id) return cur
        return {
          ...cur,
          stage: reading.found ? 'offer' : 'none',
          reading,
          reason: reading.reason,
        }
      })
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      /*
       * Only a *network* failure is "the house is off the network" — the same distinction the photo
       * capture had to learn. `ApiError` carries status 0 for a fetch that never completed; a
       * refusal from a server that answered is something else, and the panel has nothing true to
       * say about it beyond that it could not do this now.
       */
      setCapture((cur) => (cur?.id !== id ? cur : {
        ...cur,
        stage: err.status === 0 ? 'offline' : 'none',
        reason: err.status === 0 ? null : 'I couldn’t read that just now.',
      }))
    }
  }, [])

  /** The member asked. Read what has been said. */
  const begin = useCallback((id: string, asked: string, said: string[]) => {
    held.current = { id, said }
    setCapture({
      id, stage: online ? 'reading' : 'offline', asked, said,
      reading: null, saved: null, reason: null,
    })
    if (online) void read(id, said)
  }, [online, read])

  // Back on the network: read what we have been holding, which is what the member was promised
  // while they waited.
  useEffect(() => {
    if (!online || capture?.stage !== 'offline' || !held.current) return
    const { id, said } = held.current
    setCapture((cur) => (cur ? { ...cur, stage: 'reading' } : cur))
    void read(id, said)
  }, [online, capture?.stage, read])

  /**
   * Yes — write it.
   *
   * <b>The same message the reading named, sent back verbatim.</b> The server parses it again, with
   * the same parser, so what is written is what was described: there is no draft in between for the
   * two to disagree about. `forkOf` is the household's answer to "which of the two is this", and
   * only ever arrives from the offer that asked.
   */
  const save = useCallback(async (forkOf: number | null) => {
    const cur = capture
    if (!cur || cur.stage !== 'offer' || cur.reading?.message == null) return
    const text = cur.said[cur.reading.message]
    if (text === undefined) return

    setCapture((c) => (c?.id === cur.id ? { ...c, stage: 'saving' } : c))
    try {
      const response = await api.importRecipeText({
        text,
        // What the reading read off the message, so provenance survives a markdown link whose
        // address is not in the text once the markers come off.
        sourceUrl: cur.reading.sourceUrl,
        forkOf,
      })
      setCapture((c) => {
        if (c?.id !== cur.id) return c
        // A save that came back with nothing is the one outcome the offer said would not happen.
        // Said plainly rather than as a written receipt naming a recipe that does not exist.
        if (!response.recipe) return { ...c, stage: 'none', reason: response.reason }
        return { ...c, stage: 'written', saved: response.recipe, reason: null }
      })
      window.dispatchEvent(new Event('homehub:sync'))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      setCapture((c) => (c?.id !== cur.id ? c : {
        ...c,
        stage: err.status === 0 ? 'offline' : 'none',
        reason: err.status === 0 ? null : 'That didn’t save. Nothing was written.',
      }))
    }
  }, [capture])

  /**
   * There was no recipe written out, but there was a link — try it.
   *
   * <b>The one place this path fetches anything.</b> It is the existing link importer, guard and
   * all (`RecipeFetcher` owns that boundary), reached from the chat because a household that pasted
   * an address and talked about it has already told the panel where the recipe is. A publisher that
   * refuses the fetcher says so, in its own words, and the answer to that is the same as it has
   * always been: read the page in a browser and paste what is on it.
   */
  const tryLink = useCallback(async () => {
    const cur = capture
    const url = cur?.reading?.link
    if (!cur || !url) return

    setCapture((c) => (c?.id === cur.id ? { ...c, stage: 'saving' } : c))
    try {
      const response = await api.importRecipe({ url })
      setCapture((c) => {
        if (c?.id !== cur.id) return c
        return response.recipe
          ? { ...c, stage: 'written', saved: response.recipe, reason: null }
          : { ...c, stage: 'none', reason: response.reason }
      })
      window.dispatchEvent(new Event('homehub:sync'))
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      setCapture((c) => (c?.id !== cur.id ? c : {
        ...c,
        stage: err.status === 0 ? 'offline' : 'none',
        reason: err.status === 0 ? null : 'That link didn’t come back. Nothing was written.',
      }))
    }
  }, [capture])

  /**
   * Undo — and it means it, because there is exactly one thing to take back.
   *
   * Sent without a `baseVersion`: somebody reversing their own write seconds later should not meet a
   * conflict about a recipe nobody else has touched.
   */
  const undo = useCallback(async () => {
    const id = capture?.saved?.id
    setCapture(null)
    if (id === undefined) return
    try {
      await api.deleteRecipe(id)
    } catch (err) {
      if (!(err instanceof ApiError)) throw err
      // The recipe is in the folder and the panel has said so. A failed Undo is a thing to do on the
      // recipe itself, which is one tap away and is where a deletion belongs anyway.
    }
    window.dispatchEvent(new Event('homehub:sync'))
  }, [capture?.saved?.id])

  /** NO, or DISCARD. Nothing was written; the conversation stays exactly as it was. */
  const dismiss = useCallback(() => {
    held.current = null
    setCapture(null)
  }, [])

  return { capture, begin, save, tryLink, undo, dismiss }
}
