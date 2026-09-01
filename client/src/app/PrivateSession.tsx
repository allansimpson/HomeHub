import type { ReactNode } from 'react'
import { useSession } from './SessionProvider'
import { LockScreen } from '../screens/LockScreen'

/**
 * The three states the panel is actually in, which is not the same as locked or unlocked.
 *
 * <b>`offlineCare` is the one that is easy to get wrong, and I did.</b> The first version of this
 * treated an unlocked device-only session as fully private, on the reasoning that an unreachable
 * server has nothing to leak. Hermes rejected that: *"the server is currently unreachable" is not a
 * stable capability boundary* — connectivity returns while stale cookies, polling effects and cached
 * state are still live, and the window between the two is exactly where an old identity's request
 * lands under a new one's cookie.
 *
 * So device-only is its own state with its own capability: the encrypted, profile-bound Care vault
 * and its local UI, and no authenticated network execution at all.
 */
export type PrivateMode = 'locked' | 'offlineCare' | 'confirmed'

/**
 * Extracted so the rule is testable without a DOM — the client suite renders nothing, and a boundary
 * that only a browser can check is a boundary that gets checked once.
 */
export function privateSessionMode(
  locked: boolean,
  activeProfileId: number | null,
  deviceOnly: boolean,
): PrivateMode {
  // Locked, or nobody selected yet — the second is the cold-boot frame before the session answers.
  if (locked || activeProfileId == null) return 'locked'
  // Unlocked, but nothing has confirmed against the server who this is. The stored profile is a
  // memory, not an authorisation.
  if (deviceOnly) return 'offlineCare'
  return 'confirmed'
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
  const { locked, activeProfileId, deviceOnly } = useSession()
  const mode = privateSessionMode(locked, activeProfileId, deviceOnly)

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
  if (mode === 'locked') return <LockScreen />

  /*
   * Both remaining states mount the same tree, and the difference between them is enforced a layer
   * down, in `request` itself.
   *
   * <b>Not because the distinction is cosmetic, but because putting it here would be weaker.</b> The
   * Care surface transitively needs `useBaby` and `useLitter` through `useCareSubjects`, so a
   * device-only tree cannot simply omit the providers without the one capability it exists to
   * preserve going with them. Gating each provider's polling instead is eleven chances to miss one,
   * and the twelfth provider added next year would start life outside the boundary.
   *
   * So the request layer refuses every private call until `SessionProvider` says the server has
   * confirmed who is asking. In `offlineCare` the providers mount, fetch nothing, and hold nothing —
   * a fresh mount that is refused has no data to expose — while the Care vault reads local encrypted
   * storage and the write queue stays owner-bound and suspended. The full subtree is not "mounted
   * with data" until confirmation, which is the property the finding asked for.
   *
   * Keyed by profile either way: a switch discards the tree rather than handing the next member the
   * last one's answers, and if confirmation comes back as somebody else the key changes and the
   * decrypted Care view goes with it.
   */
  return <div key={activeProfileId} className="ml-private">{children}</div>
}
