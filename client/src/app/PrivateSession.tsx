import type { ReactNode } from 'react'
import { useSession } from './SessionProvider'
import { LockScreen } from '../screens/LockScreen'

/**
 * The identity this subtree may run as, or null when it must not run at all.
 *
 * Extracted so the rule is testable without a DOM — the client suite renders nothing, and a boundary
 * that only a browser can check is a boundary that gets checked once. Returning the *key* rather
 * than a boolean is deliberate: "may it run" and "who for" are the same question here, and answering
 * them separately is how a subtree ends up mounted for the wrong member.
 */
export function privateSessionKey(
  locked: boolean,
  activeProfileId: number | null,
): number | null {
  // Both conditions, not either. A confirmed profile that is locked must not run, and an unlocked
  // panel with nobody selected has no identity to run as — the second happens on a cold boot, in the
  // frame before the session answers.
  if (locked || activeProfileId == null) return null
  return activeProfileId
}

/**
 * The one place private data is allowed to exist, and the boundary the lock actually enforces.
 *
 * <b>The lock used to be a rendering decision and nothing more.</b> Every private provider was
 * mounted above `App`, so locking the panel changed what was drawn and changed nothing about what
 * was running: Calendar kept polling every two minutes and kept one unpartitioned array of the
 * household's engagements, bound to no confirmed profile. Across a boot, a lock, a sign-out or a
 * profile switch, those requests and that cache outlived the identity they belonged to — and a newly
 * unlocked profile could see the previous profile's calendar until a refresh happened to replace it.
 * That is a privacy boundary *between household members*, on a panel they share, which is why it was
 * a High finding rather than an untidiness.
 *
 * Two mechanisms, and the second is the one that does the real work:
 *
 * <b>Mounted only when unlocked.</b> Locking unmounts this whole subtree, which stops every poll,
 * cancels every interval, and discards every provider's state at once. Nothing has to remember to
 * clear itself, which is the point — eleven providers each remembering would be eleven chances to
 * forget, and the one that forgot would be invisible.
 *
 * <b>Keyed by profile.</b> Switching members changes the key, so React discards the subtree and
 * builds a new one rather than handing the next person a tree still holding the last person's
 * answers. Partitioning each cache by profile id would have worked too and is far easier to get
 * subtly wrong: a remount cannot leak what it no longer has.
 *
 * <b>`deviceOnly` still mounts, deliberately.</b> An unlocked-but-unconfirmed session is a phone out
 * of range that proved its PIN against the device, and the care log is built to work there — see
 * `careVault`. Refusing to mount would delete that feature. It is safe for the reason it looks
 * unsafe: with no reachable server there is nothing to fetch, and the write queue above this holds
 * writes until the server confirms who is asking.
 *
 * <b>What stays outside.</b> `SessionProvider` owns the transition and must survive it.
 * `WriteQueueProvider` sits above this on purpose: queued offline writes have to outlive a lock and a
 * remount, or a member who wrote three feeds offline and then locked the panel would lose them.
 * `UpdateProvider` and `ConnectionProvider` are unauthenticated — whether a newer build is being
 * served, and whether the server answers at all, are facts about the server rather than about the
 * household, and both must work on a panel where every private feed is gone.
 */
export function PrivateSession({ children }: { children: ReactNode }) {
  const { locked, activeProfileId } = useSession()
  const key = privateSessionKey(locked, activeProfileId)

  /*
   * The lock screen renders here rather than inside `App`, which is what makes the gate real.
   *
   * While it was `App`'s decision, `App` had to be inside the providers to render at all — so the
   * providers were necessarily mounted before anyone had unlocked anything. Rendering it here puts
   * the lock *above* everything private, which is the only arrangement in which "locked" can mean
   * "not running" instead of "not drawn".
   *
   * `App` keeps its own `/lock` handling, and that is a different screen: the profile switcher, opened
   * deliberately by somebody already unlocked. This is the gate at boot and on idle.
   */
  if (key == null) return <LockScreen />

  return <div key={key} className="ml-private">{children}</div>
}
