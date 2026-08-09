/**
 * Assist's panel-local preferences, alongside `todoPrefs` / `mealsPrefs` / `pantryPrefs`.
 *
 * Replaces `assistPolicy.ts`, and before that the storage half of `attendantPrefs.ts`. The
 * retention window and the store-conversations switch are **not** here — they moved to household
 * settings when the transcripts did, because a policy held on one device would leave the panel and a
 * phone disagreeing about the household's own conversations. What is left is genuinely panel-local:
 * the offered windows (a list of choices, not a value) and which agent this panel was last looking
 * at.
 */

/**
 * The stored window that means "never expire", matching `HouseholdSettings.ConversationRetentionDays`.
 *
 * Named rather than written as a bare `0`, which in a field called "days" reads as unset — and unset
 * is the one thing it must not be taken for, because the code that would then "fix" it is a sweep
 * that deletes the household's chats.
 */
export const NEVER = 0

/**
 * The retention windows Config offers. A list of choices; the value itself lives on the server.
 *
 * `NEVER` is last because it is the far end of the same scale, not a separate idea. It is
 * deliberately not the same answer as switching storing off, which keeps nothing at all: a household
 * can reasonably want either, and neither can stand in for the other.
 */
export const RETENTION_OPTIONS = [7, 30, 90, NEVER] as const

/** Matches `HouseholdSettings.ConversationRetentionDays`; used only before settings have loaded. */
export const DEFAULT_RETENTION_DAYS = 30

/** How a window reads on a chip, and in the Config index's meta line. */
export function retentionLabel(days: number): string {
  return days <= NEVER ? 'Never' : `${days} days`
}

const AGENT_KEY = 'homehub.assist.agent'

const key = (profileId: number | null) => `${AGENT_KEY}.${profileId ?? 'guest'}`

/**
 * The agent this member was last talking to on this panel.
 *
 * Per profile, and panel-local rather than a server setting, because it is a fact about *this
 * screen* rather than about the household: the panel in the kitchen and a phone in a pocket can
 * reasonably be left on different agents, and syncing that would make one of them jump under
 * somebody mid-conversation.
 *
 * Returns null when nothing is remembered or storage is unavailable, which the provider reads as
 * "take the household default".
 */
export function getLastAgent(profileId: number | null): string | null {
  try {
    return localStorage.getItem(key(profileId))
  } catch {
    return null
  }
}

export function setLastAgent(profileId: number | null, agentKey: string): void {
  try {
    localStorage.setItem(key(profileId), agentKey)
  } catch {
    /* best-effort — the default agent is a fine place to land */
  }
}

const THINKING_KEY = 'homehub.assist.thinking'

const thinkingKey = (profileId: number | null) => `${THINKING_KEY}.${profileId ?? 'guest'}`

/**
 * Whether this member wants to watch the agent think.
 *
 * <b>Off by default.</b> Reasoning is several times longer than the answer it produces and reads as
 * an argument the model is having with itself — which is genuinely interesting when you are trying to
 * work out why an agent did something, and noise the rest of the time. A household that has not asked
 * for it should get the answer.
 *
 * <b>Panel-local, per profile</b>, alongside {@link getLastAgent} and for the same reason: this is a
 * fact about a screen rather than about the household. A wall panel read from across the kitchen and
 * a phone held at arm's length are not the same reading surface, and somebody who wants the working
 * on the one they debug from has not thereby asked for a wall of it in the hallway. It is also why
 * this is not household settings: nothing here needs enforcing, only remembering.
 *
 * The reasoning itself is never stored — the panel shows it while the turn is live and the ledger
 * keeps the reply. Turning this on does not reveal the working of turns that have already happened,
 * because there is none to reveal.
 */
export function getShowThinking(profileId: number | null): boolean {
  try {
    return localStorage.getItem(thinkingKey(profileId)) === 'on'
  } catch {
    return false
  }
}

export function setShowThinking(profileId: number | null, on: boolean): void {
  try {
    localStorage.setItem(thinkingKey(profileId), on ? 'on' : 'off')
    // The chat screen is a different subtree from Config and is very likely already mounted behind
    // it. Without this it would go on hiding the working until it happened to re-render for some
    // other reason, which reads as a switch that did not take.
    window.dispatchEvent(new Event('homehub:assistprefs'))
  } catch {
    /* best-effort — the preference simply does not persist */
  }
}
