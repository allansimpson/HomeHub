# Deployment

How a build actually reaches the panel, what is unproven about it, and what a deploy has to catch.

_Last investigated: 2026-08-21 by Claude. Parts of this are inference from artefacts on the server —
each is marked. Hermes owns this area and should correct anything wrong here rather than work
around it._

## What is actually used

**Not `scripts/deploy.sh`.** That script stamps a release `date +%Y%m%d-%H%M%S` →
`20260817-193508`. The release running in production is `20260817T193508Z-0bded247023e` — UTC, with
a `Z`, and a git sha appended. Only one thing in the repo produces that format:

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C /srv/dev/homehub rev-parse --short HEAD)"
```

which is `deploy/test-deploy-from-server.md` — a hand-run runbook, executed **on the server**, that
builds locally, stages a release, flips the symlink and restarts the unit.

So the live route is a sequence of commands run by hand, and `scripts/deploy.sh` is a second,
diverging description of the same job. **Two runbooks for one task is how one of them goes stale
without anybody noticing** — which is what happened here.

> **Inference, not fact:** the stamp format proves what *made* that release. It does not prove which
> document Hermes follows today. Hermes should replace this paragraph with the truth.

⚠️ **The runbook is titled "Deploying the TEST instance."** Production is running a release built by
it. Either the runbook is misnamed or it was used against the wrong target.

## Three things the current process does not catch

### 1 · The running build cannot be traced to a commit

The deployed stamp names commit `0bded247023e`. **That object does not exist in this repository** —
not on `main`, not on any branch, not in the reflog, and `git rev-parse --disambiguate` finds
nothing. It was presumably built from a working tree whose commit was later rewritten or discarded.

The consequence is not academic: nobody can diff what is running against source, reproduce the
build, or say with certainty what is in it. Every question of the form *"is this fixed on the
panel?"* becomes an archaeology exercise against a minified bundle — which is exactly how the
pump-vibration report was eventually answered.

**A deploy should refuse to run from a dirty or unpushed tree**, or record the full sha of something
that actually exists on `origin`.

### 2 · The panel has no way to know it is stale

`build.json` is emitted by the client build (`client/vite.config.ts`, `stampBuild`) and is the
update check for devices with **no service worker** — which is any phone opening the panel over
plain `http://` on the LAN, since a worker needs a secure context.

`/opt/homehub/current/wwwroot/build.json` **does not exist.** The deployed release predates the
mechanism, so the very devices it was written for cannot tell they are four days behind. That is a
large part of why the stale build went unnoticed for so long.

**A deploy should verify `build.json` is present in the release and reports the stamp it just
built.**

### 3 · Green tests were never a precondition

Both builds were broken for ~7 hours on 2026-08-20 and the client suite reported `613 passed` while
61 tests silently did not run (`INCIDENTS.md`). Nothing in the path from source to panel would have
stopped a release during that window.

## What a deploy should catch, in order

Each of these has already failed at least once here.

| Check | Because |
|---|---|
| No root-owned files in the tree | Both builds fail claiming files are *missing*, not unreadable |
| Working tree clean, `HEAD` pushed to `origin` | Otherwise the release names a commit nobody can find |
| Backend build + tests green | See `ENVIRONMENT.md` for the two env vars they need |
| Client typecheck, lint, tests green — **and the file count** | vitest prints `passed` while skipping unreadable files |
| The change is in the built bundle | Grep the artefact. "It is committed" is not "it shipped" |
| `build.json` present, stamp matches | It is how a worker-less device learns it is behind |
| Health probe after the flip, against the *right* port | The runbook warns a probe can be answered by the other instance |
| `PREVIOUS` recorded before flipping | Rollback needs a target |

## Open questions for Hermes

1. Which document is authoritative — the runbook, `scripts/deploy.sh`, or something not in the repo?
   Whichever it is, **delete or clearly mark the other**.
2. Was production deployed with the TEST runbook deliberately?
3. Can a release be built only from a pushed commit, so the panel is always traceable?
