import { NAV_SECTIONS } from './navConfig'

/**
 * Swallow a back navigation that would take somebody off a tab root.
 *
 * <b>Reported twice from the Care tab, and the platform was Android rather than iOS.</b> Somebody
 * paging the SINCE / TODAY / ENTRIES panels swiped and left the screen. On Android's gesture
 * navigation an inward swipe from either edge is a *system* back — it is delivered to Chrome as a
 * command, never to the page as a touch — so there is nothing here to intercept and no amount of
 * `preventDefault` reaches it. Two attempts at blocking the gesture were shipped before that was
 * understood; neither could have worked. `PROJECT.md` §8 records this so it is not tried a third
 * time.
 *
 * What *is* reachable is the thing back navigates to. `BottomNav` already switches tabs with
 * `replace`, so tab-to-tab no longer leaves an entry to pop; this closes the rest by refusing the
 * pop itself whenever it would leave a tab root — which on a household panel is never something
 * anybody asked for. There is no back affordance on a tab root: the bar is how you change tabs, and
 * the only ways to trigger one are the system gesture and the hardware button, both of them here
 * by accident.
 *
 * <b>A drill-in is deliberately left alone.</b> Backing out of a recipe, a room or an event *is* a
 * journey somebody took, the screens have their own back buttons that call `navigate(-1)`, and a
 * swipe that does the same thing is doing what it looks like it does. Deciding on the route rather
 * than on a flag set by callers is what lets those ten-odd call sites stay exactly as they are —
 * nothing has to remember to co-operate with this file, so nothing can forget to.
 */

/** The tab roots. Backing off one of these is the accident; anything deeper is a real journey. */
const TAB_ROOTS = new Set(NAV_SECTIONS.map((s) => s.path))

/** Whether backing away from this path should be refused. Exported for its test. */
export function guardsBackFrom(pathname: string): boolean {
  return TAB_ROOTS.has(pathname)
}

export function installBackGuard(): void {
  /*
   * Where we are, tracked outside React.
   *
   * `popstate` fires *after* the browser has moved, so by the time the handler runs
   * `location.pathname` is already the place we are being taken to — and the decision needs the
   * place we are being taken *from*. React Router knows it, but reading it from a component would
   * mean registering this listener after the router's own, and then the router would have already
   * re-rendered the previous screen before this could refuse it: a visible flash of the wrong tab
   * on every absorbed swipe.
   *
   * So the router's two entry points are wrapped to record each move as it happens. It is a small
   * intrusion, and it buys the listener the right to run first and correct the history before
   * anything reads it.
   */
  let here = snapshot()

  function snapshot() {
    return { path: window.location.pathname, href: window.location.href, state: window.history.state }
  }

  const rawPush = window.history.pushState.bind(window.history)
  const rawReplace = window.history.replaceState.bind(window.history)

  window.history.pushState = function (...args: Parameters<History['pushState']>) {
    rawPush(...args)
    here = snapshot()
  }
  window.history.replaceState = function (...args: Parameters<History['replaceState']>) {
    rawReplace(...args)
    here = snapshot()
  }

  window.addEventListener('popstate', () => {
    // Somewhere with a real back — a drill-in, the event editor, a settings page. Let it go, and
    // take the new position as the current one.
    if (!guardsBackFrom(here.path)) {
      here = snapshot()
      return
    }

    /*
     * Put it back, with the router's own state object.
     *
     * The state carries React Router's index for this entry. Restoring the *same* state as well as
     * the same URL is what makes the correction invisible to it: its own `popstate` handler runs
     * after this one, reads a location and an index identical to what it already held, and
     * concludes that nothing moved. Push the URL alone and its index would drift out of step with
     * the browser's, which is how a later `navigate(-1)` ends up going somewhere nobody asked for.
     *
     * `rawPush`, not the wrapped one: this is a correction rather than a move, and recording it
     * would be recording a position we never actually left.
     */
    rawPush(here.state, '', here.href)
  })
}
