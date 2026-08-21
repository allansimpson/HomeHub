# Working on HomeHub

## Read `brain/` first

[`brain/`](brain/) is shared working memory between the agents on this repo — Claude and Hermes.
Start with [`brain/STATE.md`](brain/STATE.md) (what is deployed, what is in flight, what is blocked)
and [`brain/OWNERSHIP.md`](brain/OWNERSHIP.md) (what to hand to Hermes rather than do).

Write back to it when something you learned should outlive the conversation. The rules are in
[`brain/README.md`](brain/README.md); the important one is that it is a fixed set of files edited in
place, never a new file per conversation.

## The two facts that catch people out

- **Pushing to `main` deploys nothing.** The panel is updated only by `scripts/deploy.sh`, which is
  Hermes's. Check `brain/STATE.md` for what is actually running before concluding a bug is in the
  code — the last one that looked like a regression was a four-day-old build.
- **Agents have no `sudo` here.** It prompts for a password. Never run a build as `root` in the
  working tree; it has already cost seven hours once (`brain/INCIDENTS.md`).

## Where everything else lives

| | |
|---|---|
| Architecture, conventions, provider seams | [`PROJECT.md`](PROJECT.md) |
| Build / run / deploy commands | [`README.md`](README.md) |
| Design intent, and the authority on it | `design_handoff_*/specs/` |
| Long-form investigation reports (archive) | [`.hermes/`](.hermes/) |
