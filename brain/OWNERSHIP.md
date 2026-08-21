# Ownership

Who is responsible for what. The point is not territory — it is knowing which of us a given change
should be handed to, and what the other should *not* do unannounced.

_Last reviewed: 2026-08-21._

## Hermes

- **Deployment.** `scripts/deploy.sh`, the servers at `/opt/homehub` and `/opt/homehub-test`, the
  release/symlink layout, certificates, and the systemd unit. Hermes decides when a build ships.
- **Anything needing root.** Agents cannot use `sudo` here — it prompts for a password. If a task
  needs it, it stops and becomes Hermes's.
- **Server-side operational config** — connection strings, environment, the panel's own machine.

## Claude

- **The codebase.** Application code, tests, styles, and the design-handoff implementations.
- **Verification before a deploy** — builds, both test suites, lint, typecheck.
- **Writing down what changed**, here and in commit messages.

## Shared, and therefore worth announcing

- **Commits and pushes to `main`.** History is linear and both of us commit directly to it. Say so
  in `STATE.md` when a push lands, or the other agent finds out by diffing.
- **Shared components.** `CutGroup` came from Claude and `CutFitProvider` was built on it by Hermes
  without either knowing. That worked out; it easily might not have. Note the intent here first.
- **The working tree.** It is frequently large and uncommitted. Before a sweeping change, check
  `STATE.md` for work in flight.

## Hand over rather than do

| Situation | Goes to |
|---|---|
| Needs `sudo`, or writes outside `/srv/dev/homehub` | Hermes |
| Shipping a build to the panel | Hermes |
| Rotating certificates or secrets | Hermes |
| A change to the design specs themselves | The specs are signed off; ask Allan |

## The rule this folder was created for

**Never run a build or a script as `root` inside the working tree.** It leaves root-owned files that
the ordinary user cannot read, and both builds fail with errors that name a *missing* file rather
than an unreadable one — see `INCIDENTS.md`.
