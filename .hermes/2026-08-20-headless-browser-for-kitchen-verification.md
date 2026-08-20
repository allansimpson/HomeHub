# Headless browser for Kitchen panel verification

**Short version: nothing needs installing by you.** I checked, and the install needs no `sudo` and
no package Ubuntu is missing. What follows is the evidence for that, the one decision that is
Allan's rather than mine, and a fallback if something fails in a layer I cannot see.

---

## Why it is wanted

The Kitchen section (25 panels, `client/src/screens/kitchen/`) has been built and corrected against
the locked specs in `design_handoff_kitchen/specs/`, but **it has never been rendered**. Every check
so far is static: TypeScript, oxlint, 638 vitest cases, 1152 xUnit cases, and a source-reading test
that pairs each scroll group with the CSS height of the rows inside it.

None of that can see a layout. The section's signature treatment is the **bisected cut** — a group
sized so the next row is visibly cut through its text, which is the only scroll affordance it has
(`design_handoff_kitchen/specs/pantry/PANTRY_SHELVES.md` §1). Whether that lands mid-glyph or in a
padding band is a thing you confirm by looking. `RECIPES.md` §6 records it going wrong three times
in one segment.

## What the machine already has

Checked on 2026-08-20, on this host:

| | |
|---|---|
| OS | Ubuntu 24.04.4 LTS, x86_64, kernel 6.8.0-138 |
| Node / npm | v24.19.0 / 11.17.0 |
| Free disk | 715 GB on `/` |
| `~/.cache` | writable by `simpson` |
| npm registry | reachable (`npm ping` → PONG, 185 ms) |
| `cdn.playwright.dev` | reachable (HTTP 400 — a server answering, not a block) |
| `playwright.azureedge.net` | reachable (HTTP 307) |
| Existing browser | `/usr/bin/firefox` only, a wrapper script; no Playwright cache |

**Every shared library Chromium needs is already present.** Verified with `ldconfig -p`:
`libnss3`, `libnspr4`, `libdbus-1`, `libatk-1.0`, `libatk-bridge-2.0`, `libcups`, `libdrm`,
`libatspi`, `libX11`, `libXcomposite`, `libXdamage`, `libXext`, `libXfixes`, `libXrandr`, `libgbm`,
`libxcb`, `libxkbcommon`, `libpango-1.0`, `libcairo`, `libasound.so.2`, `libexpat.so.1`.

That last pair is the usual gap on a server image and the reason `install-deps` normally needs root.
Here they came in with the desktop, so **`sudo playwright install-deps` is not needed**.

This matters because `sudo` on this box prompts for a password, which a non-interactive agent
cannot supply. That was the only thing that would have required a human.

## What actually has to run

Two commands, both as `simpson`, neither privileged:

```bash
cd /srv/dev/homehub/client
npm i -D playwright                 # the driver
npx playwright install chromium     # the browser, into ~/.cache/ms-playwright (~150 MB)
```

`npx playwright install --with-deps chromium` is the form usually quoted. **Do not use it here** —
`--with-deps` shells out to `apt-get` and will fail on the password prompt for no benefit, since
the dependencies are already satisfied.

If only screenshots are wanted rather than a full browser, `chromium-headless-shell` is the smaller
target and enough for this job.

## The one open decision

Where the dependency lives. This is Allan's call, not a technical constraint:

1. **In `client/package.json` as a devDependency.** Reproducible, and anyone else who clones the
   repo can render the panels too. Costs a line in the manifest and a lockfile change, on a working
   tree that is already large and uncommitted.
2. **Outside the repo** — install into a scratch directory and point `PLAYWRIGHT_BROWSERS_PATH` at
   the shared cache. The repo stays untouched; nobody else gets the capability.

I have not run either. Ask him which.

## Fallback, if the install fails anyway

I can see the network responds from inside my sandbox, but I cannot see every policy layer between
here and the CDN. If `npx playwright install chromium` fails on download:

- **Blocked CDN.** Allow `cdn.playwright.dev` and `playwright.azureedge.net`, or set
  `PLAYWRIGHT_DOWNLOAD_HOST` at an internal mirror.
- **Prefer a distro browser.** `sudo apt-get install -y chromium-browser` (needs your password),
  then point Playwright at it with `channel: 'chromium'` or `executablePath`. Works, but the version
  then drifts from what Playwright expects.
- **No network at all.** Fetch the Chromium zip on another machine and unpack it into
  `~/.cache/ms-playwright/`; the directory name has to match the build Playwright asks for, which
  `npx playwright install --dry-run chromium` will print.

## What I will do with it

Serve the built SPA, drive it to each of the 25 `/kitchen/*` routes at the design's own reference
canvas of **540 × 1169**, and screenshot each one against its PNG in
`design_handoff_kitchen/screens/`. The three things static checks cannot reach are:

1. Whether each cut lands inside a row's text box or in the padding band beneath it.
2. Whether the panels still fit their content area now that several have gained a search row, a
   footer, or a band — `PLAN_WEEK.md` §6 warns both L1 and L3 were within ~40 px of full.
3. Whether anything I could only verify by type — a band with no rows, a control with no target —
   actually renders.

The API needs a database for most panels to hold data, but the layout faults above show up on empty
state too, so this is worth doing before the data side is wired up.

---

*Written by Claude, 2026-08-20. Environment facts measured on this host on the same day; the library
list will not survive a reinstall of the OS image.*
