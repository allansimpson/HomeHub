import { countWord } from '../../app/eventDrafts'
import type { ConversationMessage, RecipeConversationReadingDto, RecipeDto } from '../../api/types'
import type { PendingTurn } from './useStreamedTurn'

/**
 * When a chat is somebody asking for a recipe to be filed, and what is said either side of it.
 *
 * Pure, and apart from the hook that uses it, for the same reason `photoCapture.ts` is: every
 * sentence here is a claim about what the panel just did to the household's recipe folder, and the
 * one function above them decides whether a member's words reach the agent at all. Both are exactly
 * the kind of thing that is right often enough to stop being checked.
 */

/** How far back the reading looks. The server holds the same bound and is the authority on it. */
const MOST_MESSAGES = 12

/** Verbs of writing something down. */
const WRITES = /\b(add|save|keep|file|store|put|pop|stick)\b/g

/** Words for where a recipe goes. */
const PLACES = /\b(recipes?|cook ?books?|folder)\b/g

/** Openings that ask whether, rather than saying to. */
const DELIBERATING = /^(should|shall we|do you think|would it be|is it worth)\b/

/**
 * Every other word a bare instruction is allowed to contain.
 *
 * <b>An allowlist, and that is what makes the test narrow.</b> Anything outside it is a second
 * thought — "but double the garlic", "once you've halved it" — and a second thought is work only
 * the agent can do. Counting words instead let exactly those through: "save this recipe but double
 * the garlic first" is eight words, and so is a perfectly ordinary instruction.
 */
const FILLER = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'them', 'one', 'ones', 'thing',
  'to', 'into', 'in', 'on', 'up', 'down', 'for', 'me', 'us', 'my', 'our', 'your',
  'can', 'could', 'would', 'will', 'please', 'i', 'we', 'you', 'just', 'now', 'here',
  'new', 'and', 'let', 'lets', 'go', 'ahead', 'do',
])

/**
 * Whether a message is a bare instruction to file the recipe that was just discussed.
 *
 * <b>Deliberately narrow, and narrow in a particular direction.</b> This is the one test that
 * decides a member's words are for the panel rather than for Barnaby — a message it matches is
 * answered here and never sent, which costs nothing when it is right and swallows a question when
 * it is wrong. So it wants three things at once:
 *
 * <b>A verb of writing and a word for where it goes</b>, and two *different* words, as the photo
 * path's `declaresIntent` does. "Save" alone is somebody talking about saving time.
 *
 * <b>Nothing else in the message.</b> "Save this recipe" is an instruction; "save this recipe but
 * double the garlic first" is a request, and one with work in it that only the agent can do. Every
 * word has to be part of the instruction ({@link FILLER}) — anything else and it goes to Barnaby,
 * and the household can say "save it" when he has finished.
 *
 * <b>Not a question about whether to.</b> "Should I save this recipe?" is asking for an opinion, and
 * answering it by filing the recipe is the panel deciding on the member's behalf.
 */
export function asksToSaveARecipe(prompt: string): boolean {
  const text = prompt.trim().toLowerCase()
  if (text.length === 0) return false
  if (DELIBERATING.test(text)) return false

  // Two *different* words, which is not the same test as one from each list — "file" is a verb and
  // "folder" a place, and a single word playing both halves would hear an instruction in a question
  // about where something is filed.
  WRITES.lastIndex = 0
  PLACES.lastIndex = 0
  const writes = [...text.matchAll(WRITES)]
  const places = [...text.matchAll(PLACES)]
  if (!writes.some((w) => places.some((p) => p.index !== w.index))) return false

  const spoken = new Set([...writes, ...places].flatMap((m) => m[0].split(/\s+/)))
  return text
    .split(/[^a-z]+/)
    .filter((word) => word.length > 0)
    .every((word) => spoken.has(word) || FILLER.has(word))
}

/**
 * The transcript as the reader wants it: newest message first, nothing empty, and only as far back
 * as the server will read anyway.
 *
 * <b>Turns in flight come first, and their replies before their prompts.</b> A member who says "save
 * this recipe" the moment a reply finishes means *that* reply — which may still be on screen as a
 * pending turn rather than in the stored ledger, because the transcript reloads a beat later.
 */
export function transcriptFor(
  messages: readonly ConversationMessage[],
  pending: readonly PendingTurn[],
): string[] {
  const said: string[] = []
  for (const turn of [...pending].reverse()) {
    said.push(turn.text, turn.prompt)
  }
  for (const message of [...messages].reverse()) {
    said.push(message.text)
  }
  return said.map((t) => t.trim()).filter((t) => t.length > 0).slice(0, MOST_MESSAGES)
}

/** "14 ingredients and 6 steps" — what is actually in front of somebody, in one clause. */
function bodyOf(reading: RecipeConversationReadingDto): string {
  const lines = [
    reading.ingredientCount > 0
      ? `${reading.ingredientCount} ingredient${reading.ingredientCount === 1 ? '' : 's'}`
      : null,
    reading.stepCount > 0 ? `${reading.stepCount} step${reading.stepCount === 1 ? '' : 's'}` : null,
  ].filter((l) => l !== null)
  return lines.join(' and ')
}

/**
 * The offer, in Barnaby's words.
 *
 * <b>It names the recipe and says how much of one it found.</b> A chat can hold two recipes and a
 * long argument about a third, so "shall I save it?" on its own is a question somebody cannot
 * answer without scrolling. The counts do the other half: `Partial` means the panel could not find
 * a name, or the ingredients, or the method, and a household that can see "4 ingredients and no
 * method" before saying yes is not the one who finds out afterwards.
 *
 * <b>A recipe already in the folder under that name changes the question rather than the answer.</b>
 * It stops being "shall I save this" and becomes "which of the two is this" — which is the question
 * the household is actually being asked, and the only one they can answer.
 */
export function offerProse(reading: RecipeConversationReadingDto): string {
  const name = reading.title ?? 'that'
  const body = bodyOf(reading)
  const found = body ? `${name} — ${body}` : name

  if (reading.existing) {
    return `That's ${found}, and there's already a ${reading.existing.title} in the folder. `
      + 'Shall I keep this one as a variation of it, or as a recipe of its own?'
  }
  return `That's ${found}. Shall I put it in the recipe folder?`
}

/**
 * What Barnaby says once it is filed.
 *
 * Names what was written rather than announcing success, exactly as the photo path's confirmation
 * does — somebody who walks up to the panel afterwards can tell what happened without pressing
 * anything.
 */
export function confirmationProse(recipe: RecipeDto): string {
  /*
   * A variation usually carries its parent's name, because that is the case the offer exists for —
   * so naming both reads as "a variation of Chicken Katsu Curry, a variation of Chicken Katsu
   * Curry", which is the panel saying one thing twice and sounding unsure of it. Only visible
   * rendered; the receipt row underneath still names the parent, where naming it is the point.
   */
  const parent = recipe.forkedFromTitle
  const where = !parent
    ? `In the folder — ${recipe.title}.`
    : parent === recipe.title
      ? `In the folder — ${recipe.title}, as a variation of the one you had.`
      : `In the folder — ${recipe.title}, a variation of ${parent}.`
  return recipe.completeness === 'Partial' && recipe.incompleteReason
    ? `${where} ${recipe.incompleteReason}`
    : where
}

/**
 * The IT TOUCHED rows.
 *
 * <b>The lineage line is conditional on the link, not on the intention.</b> A variation saved
 * against a parent that turned out to be gone is refused server-side rather than saved unlinked, so
 * this line and the recipe agree by construction — but it is still read off the saved recipe, which
 * is the only thing that knows.
 */
export function receiptLines(recipe: RecipeDto): string[] {
  const lines = [
    `The recipe folder was written to · ${countWord(recipe.ingredients.length)} ingredient${recipe.ingredients.length === 1 ? '' : 's'}`,
  ]
  if (recipe.forkedFromTitle) lines.push(`Kept as a variation of ${recipe.forkedFromTitle}`)
  return lines
}
