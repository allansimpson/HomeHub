# State

What is true right now. **Overwrite this file** — it is a snapshot, not a log. Anything worth
keeping once it stops being current belongs in `DECISIONS.md` or `INCIDENTS.md`.

_Updated: 2026-08-21 by Claude._

## Deployed

| | |
|---|---|
| Panel is running | `20260817T193508Z-0bded247023e`, built **17 Aug 14:35** |
| `origin/main` | `bab0234` |
| Gap | **The panel is four days and several features behind the repo.** |
| Traceability | ⚠️ **None.** Commit `0bded247023e` does not exist in this repo — see `DEPLOYMENT.md` |

## Waiting to ship

Nothing reaches the panel until Hermes runs `scripts/deploy.sh`.

- **Pump-session vibration.** The deployed build spends the alert *before* calling `vibrate()` and
  ignores the result, so a refusal — no sticky activation after a PWA relaunch, or a hidden page —
  discards the buzz silently. That is the reported "vibration isn't working". The fix
  (`pumpPhases.ts:148`, only spend the moment when `vibrate()` does not return `false`) is committed
  and verified present in the built bundle. It has never been deployed.
- **The Kitchen section**, the care log, the update mechanism, device panels and auth — all landed
  on `main` after 17 Aug and are likewise unshipped.

## In flight

- **Kitchen visual fidelity.** 25 panels implemented against `design_handoff_kitchen/specs/`, swept
  once for the shared vocabulary (destination header, bisected cut, row supporting line). Two known
  gaps left deliberately, both for missing data rather than missing time: the item sheet's
  `WHERE IT LIVES` band needs shelf-level location, and the recipe photo strip needs
  `Recipe.photos[]`, which is a data note in `RECIPES.md` §4 and was never built.
- **Nothing has been rendered.** Every check on the Kitchen is static — types, lint, tests, and a
  source-reading test that pairs each cut with the CSS height of its rows. Layout is unverified.

## Blocked

- **Visual verification** — needs a headless browser installed. No `sudo` required; not yet done.

## Recently cleared

- Root-owned files across the repo, which broke both builds for ~7 hours. Fixed by Allan on
  2026-08-21 with `chown -R`. Root cause not yet established — see `INCIDENTS.md`.
