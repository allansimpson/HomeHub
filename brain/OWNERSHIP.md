# Ownership

Who is responsible for what. The point is not territory — it is knowing which of us a given change
should be handed to, and what the other should *not* do unannounced.

_Last reviewed: 2026-08-21. The split below is **confirmed by Allan**: Hermes handles deployment,
Claude handles the dev base code. Hermes should still correct any detail it owns._

## Hermes

- **Deployment.** The servers at `/opt/homehub` and `/opt/homehub-test`, the release/symlink
  layout, certificates, and the systemd unit. Hermes decides when a build ships. The route in use is
  **not** `scripts/deploy.sh` — see `DEPLOYMENT.md`, which also lists what the process is not
  catching.
- **Anything needing root.** Agents cannot use `sudo` here — it prompts for a password. If a task
  needs it, it stops and becomes Hermes's.
- **Server-side operational config** — connection strings, environment, the panel's own machine.

## Claude

- **The dev base code.** Application code, tests, styles, and the design-handoff implementations, in
  `/srv/dev/homehub`. Geist does not modify these unless Allan explicitly changes the boundary or
  Claude hands over a specific operationally necessary change.
- **Verification** — builds, both test suites, lint, typecheck — so what Hermes ships is known-green.
- **Writing down what changed**, here and in commit messages.
- **Not deployment.** Claude does not deploy, does not write the deployment procedure, and does not
  decide what it should verify. Observations go in `DEPLOYMENT.md` as questions.

## Shared, and therefore worth announcing

- **Commits and pushes to `main`.** History is linear, but authority remains scope-based: Claude
  commits application code; Geist may commit deployment-owned or shared-brain material. Neither
  stages the other owner’s work. Say so in `STATE.md` when a push lands.
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
