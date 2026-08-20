import { useSession } from './SessionProvider'

/**
 * What the household calls the child.
 *
 * <b>Kept by the panel, not read from the integration.</b> The name used to arrive with the child
 * list from Huckleberry, which meant the Baby tab said "Baby" whenever that service was unreachable
 * — a header naming a child after a system outage. The Care log is HomeHub's own now and the name
 * should be too: it is a thing the household decided, not a value some upstream happens to hold.
 *
 * Null falls back to the literal word, deliberately. The nav cell says BABY in every state — a tab
 * that renames itself is a tab nobody can point at — so the fallback matching it means the header
 * reads as the same place rather than as a name that failed to load.
 */
export function useBabyName(): string | null {
  const { settings } = useSession()
  return settings?.babyName?.trim() || null
}
