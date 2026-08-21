# brain

Shared working memory for the agents on this repo — **Claude** and **Hermes**. Both read it before
starting and both write to it when something they learned should outlive the conversation.

It exists because we kept surprising each other. One of us deployed, changed ownership of 89 files
or built on the other's component, and the other found out by reading file timestamps. Nothing here
is clever; it is just the small set of facts that were expensive to rediscover.

## The rules

1. **One folder, a fixed set of files.** Everything below is one of five types. Do not add a file
   per conversation — that is the habit this replaces. A genuinely new *type* may earn a file, but
   add it to the index below in the same edit or nobody will read it.
2. **Edit in place.** Correct a wrong line rather than appending a newer one underneath it. Two
   entries that disagree are worse than one that is out of date, because the reader cannot tell
   which won.
3. **Say how you know.** A claim worth recording is worth a date and a source — a command that was
   run, a file that was read, a person who said so. `STATE.md` and `ENVIRONMENT.md` go stale fastest;
   an unverifiable line in either is a trap.
4. **Prune.** If a file is over ~200 lines it has stopped being memory and become an archive. Move
   the durable part into `PROJECT.md` and delete the rest.
5. **Write on the way out.** If a session changed who-does-what, what is deployed, or what is safe
   to assume, that belongs here *before* the session ends.

## The files

| File | Holds | Shape |
|---|---|---|
| `OWNERSHIP.md` | Who is responsible for what, and what to hand over rather than do | Stable; edit in place |
| `ENVIRONMENT.md` | This machine and its servers — paths, commands, limits, what agents cannot do | Stable; edit in place |
| `STATE.md` | What is true *right now* — deployed release, work in flight, blockers | Volatile; **overwrite** |
| `DECISIONS.md` | Choices made and why, so neither of us re-litigates or silently reverses one | Append |
| `INCIDENTS.md` | What broke, the root cause, and what prevents a repeat | Append |

## What does not go here

- **Architecture, conventions, the provider-seam model** → `PROJECT.md`. That is the project's
  knowledge base and predates this folder.
- **Build and run commands** → `README.md`.
- **Design intent for the Kitchen and other sections** → `design_handoff_*/specs/`. Those specs are
  the authority; this folder never restates them, because a restatement is a second source that can
  drift from the first.
- **Long-form investigation reports.** Keep them in `.hermes/` as a dated archive. What comes back
  here is the conclusion, in a line or two, not the working.
