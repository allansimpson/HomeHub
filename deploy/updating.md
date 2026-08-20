# Pushing an update

The routine for a panel that is **already running**. Build on your machine, copy the result up,
switch to it, restart.

Setting a server up for the first time is a different job — see
[`server-systemd.md`](server-systemd.md). Nothing here creates users, directories or certificates;
those already exist and survive every update.

**Roughly two minutes.** Steps 1–4 on your machine, 5–7 on the server.

---

## Quick reference

If you have done this before, it is these two blocks.

```powershell
# [dev] PowerShell, at the repo root
cd C:\CODE\HomeHub
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"
cd client; npm ci; npm run build; cd ..
if (Test-Path artifacts\publish) { Remove-Item -Recurse -Force artifacts\publish }
dotnet publish src/HomeHub.Api/HomeHub.Api.csproj -c Release -r linux-x64 --self-contained true -o artifacts/publish
tar -czf "artifacts/homehub-$STAMP.tar.gz" -C artifacts/publish .
scp "artifacts/homehub-$STAMP.tar.gz" <you>@<server>:/tmp/
```

```bash
# [server] over ssh
STAMP=$(ls -1 /tmp/homehub-*.tar.gz | sort -r | head -1 | sed 's#.*/homehub-##; s#\.tar\.gz$##')
mkdir -p /opt/homehub/releases/$STAMP
tar -xzf /tmp/homehub-$STAMP.tar.gz -C /opt/homehub/releases/$STAMP
chmod +x /opt/homehub/releases/$STAMP/HomeHub.Api
chgrp -R homehub /opt/homehub/releases/$STAMP
chmod -R g+rX /opt/homehub/releases/$STAMP
ln -sfn /opt/homehub/releases/$STAMP /opt/homehub/current.tmp
mv -Tf /opt/homehub/current.tmp /opt/homehub/current
sudo systemctl restart homehub
curl -s "http://127.0.0.1:5000/api/health?deep=true"
```

Everything below is the same thing, explained.

---

## What you need

- The repo on your machine, and `ssh <you>@<server>` working.
- **Your panel's HTTP port.** Examples here use `5000`; if the server had something else on that
  port, yours differs. Check once and remember it:

  ```bash
  sudo ss -lntp | grep -i homehub
  ```

Nothing else. The server needs no .NET and no Node — a release carries its own runtime.

---

## 1 · Build the SPA — [dev]

```powershell
cd C:\CODE\HomeHub
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"
cd client; npm ci; npm run build; cd ..
```

The stamp names this release; the rest of the steps use it. Output goes to
`src/HomeHub.Api/wwwroot`, which the API serves.

<details><summary>Git Bash instead of PowerShell?</summary>

```bash
STAMP=$(date +%Y%m%d-%H%M%S)
cd client && npm ci && npm run build && cd ..
```
</details>

## 2 · Publish the API — [dev]

```powershell
if (Test-Path artifacts\publish) { Remove-Item -Recurse -Force artifacts\publish }
dotnet publish src/HomeHub.Api/HomeHub.Api.csproj -c Release -r linux-x64 --self-contained true -o artifacts/publish
```

Clear the folder first — `-o` merges into whatever is already there, so a file that stopped being
produced would otherwise survive into every later release.

> `rm -rf` does not work in PowerShell: `rm` is an alias for `Remove-Item`, which has no `-rf`.

## 3 · Package — [dev]

```powershell
tar -czf "artifacts/homehub-$STAMP.tar.gz" -C artifacts/publish .
```

## 4 · Upload — [dev]

```powershell
scp "artifacts/homehub-$STAMP.tar.gz" <you>@<server>:/tmp/
```

> Keep the `<you>@<server>:/tmp/` on the end. `scp a b` with no remote destination is a *local copy*.

## 5 · Unpack — [server]

```bash
ssh <you>@<server>
```

Take the stamp from the file you just uploaded rather than retyping it:

```bash
STAMP=$(ls -1 /tmp/homehub-*.tar.gz | sort -r | head -1 | sed 's#.*/homehub-##; s#\.tar\.gz$##')
echo $STAMP
```

If that prints nothing, step 4 did not land — go back and repeat it.

```bash
mkdir -p /opt/homehub/releases/$STAMP
tar -xzf /tmp/homehub-$STAMP.tar.gz -C /opt/homehub/releases/$STAMP
rm -f /tmp/homehub-$STAMP.tar.gz
```

Then two lines that are not optional:

```bash
chmod +x /opt/homehub/releases/$STAMP/HomeHub.Api
chgrp -R homehub /opt/homehub/releases/$STAMP
chmod -R g+rX /opt/homehub/releases/$STAMP
```

- **`chmod +x`** — `tar` built on Windows carries no executable bit, and systemd fails with a bare
  `203/EXEC` without it.
- **`chgrp` + `g+rX`** — the service runs as `homehub` and must be able to read what you unpacked.
  (With setgid set on `releases/` the group is inherited anyway; this costs nothing and covers a
  server prepared before that was in place.)

Confirm the service can actually run it:

```bash
sudo -u homehub test -x /opt/homehub/releases/$STAMP/HomeHub.Api && echo ok || echo "CANNOT READ IT"
```

## 6 · Switch and restart — [server]

```bash
ln -sfn /opt/homehub/releases/$STAMP /opt/homehub/current.tmp
mv -Tf /opt/homehub/current.tmp /opt/homehub/current
readlink /opt/homehub/current        # should print your new stamp
sudo systemctl restart homehub       # asks for your password
```

Two steps for the symlink because `ln -sfn` onto an existing symlink-to-a-directory creates a link
*inside* the old target instead of replacing it. Writing a temp link and `mv -T`-ing over it is the
version that actually swaps atomically.

## 7 · Verify — [server]

```bash
systemctl is-active homehub
curl -s "http://127.0.0.1:5000/api/health?deep=true"
```

What you want:

```json
{"status":"ok","service":"HomeHub.Api","version":"1.0.0.0","database":"ok","pendingMigrations":0}
```

**Check all three.** `status` alone only says the process is up — the panel serves its shell quite
happily with no database at all, so a deploy can look clean while nothing works:

| Field | Wanted | If not |
|---|---|---|
| `status` | `ok` | See the table below |
| `database` | `ok` | `unreachable` → connection string or SQL Server; `not-configured` → missing entirely |
| `pendingMigrations` | `0` | A startup migration failed and was swallowed — read the log |

Then load the panel in a browser to be sure the UI came with it.

---

## How an update reaches the panels

Step 7 finishes the deploy on the *server*. Every device that has the panel open is still running the
build it launched on, and getting it onto them used to mean clearing each browser's site data by
hand. It no longer does.

**Nothing to do, per device.** Each panel asks the server whether it is still current every half
hour, and again whenever somebody wakes the screen after a couple of minutes away. When a newer
build is found the Dashboard carries a brass plate at the top — `UPDATE READY · <commit>` — with one
control, **APPLY NOW**. Pressing it reloads onto the new build in a few seconds and the plate turns
verdigris to say what landed. The plate stands until it is pressed; it is not dismissible, so no
device sits quietly out of date.

The wall panel is the one to watch after a deploy: it is never closed and never navigates, so the
half-hourly check is the only thing that will find the update. Walking past and pressing APPLY NOW
is the fast path.

**What makes it work**, if you are ever debugging it:

- `client/public/sw.js` carries a `__BUILD_STAMP__` placeholder that `vite.config.ts` fills in at
  build time. A browser re-installs a service worker only when the worker's bytes change, so this
  constant is what makes every release a new worker — and installing is what fetches the new app.
  The build fails loudly if that placeholder ever goes missing.
- `build.json`, written beside it, carries the same stamp. Devices with no service worker — a phone
  on plain `http://`, which is not a secure context — compare that against the build they are
  running.
- The stamp is `<commit><+ if dirty> · <UTC to the second>`, the same one Config → System shows. Two
  panels showing different stamps are running different code.

Rolling back is a deploy like any other from a device's point of view: the stamp changes, so panels
offer the older build exactly as they would a newer one.

## Rolling back

The previous release is still on disk, so this is the switch in reverse — no rebuild, no upload:

```bash
ls -1 /opt/homehub/releases | sort     # what is available
readlink /opt/homehub/current          # what you are on

ln -sfn /opt/homehub/releases/<previous-stamp> /opt/homehub/current.tmp
mv -Tf /opt/homehub/current.tmp /opt/homehub/current
sudo systemctl restart homehub
curl -s "http://127.0.0.1:5000/api/health?deep=true"
```

> Rolling back does **not** undo a database migration. If the release you are leaving applied one,
> the older code meets the newer schema — usually fine (EF ignores columns it does not know), but it
> is the one thing a symlink cannot reverse.

## Housekeeping

Each release is ~126 MB. Keep a few for rollback, delete the rest:

```bash
ls -1 /opt/homehub/releases | sort
readlink /opt/homehub/current          # never delete this one
rm -rf /opt/homehub/releases/<old-stamp>
```

---

## When it goes wrong

```bash
systemctl is-active homehub
journalctl -u homehub -n 40 --no-pager
```

| What you see | Cause | Fix |
|---|---|---|
| `tar … Cannot open: No such file or directory` | `STAMP` wrong, or the upload never landed | `ls -1 /tmp/homehub-*.tar.gz`, re-derive it (step 5) |
| `203/EXEC` | Executable bit missing | `chmod +x …/HomeHub.Api` (step 5) |
| `Permission denied` reading the release | Wrong group on the unpacked files | `chgrp -R homehub …` (step 5) |
| `activating (auto-restart)`, never `active` | Crash loop — the journal names it | `journalctl -u homehub -n 40 --no-pager` |
| `Failed to bind to address … already in use` | Another service took the port | `sudo ss -lntp \| grep ':<port>'`, then change `Server__HttpPort` in `/etc/homehub/homehub.env` |
| `"database":"unreachable"` | Connection string, or SQL Server not reachable from the server | Check `ConnectionStrings__HomeHub` in `/etc/homehub/homehub.env` |
| `https` port gone after an update | Certificate unreadable — the app logs `HTTPS disabled: …` and serves HTTP | `ls -l /etc/homehub/certs/`; `chgrp homehub` the pair |
| UI looks stale in the browser | A device that has not checked yet | Nothing. See [How an update reaches the panels](#how-an-update-reaches-the-panels) — it offers itself within half an hour, or as soon as somebody wakes the screen |

Nothing here touches `/etc/homehub/homehub.env`, `/var/lib/homehub` or `/etc/homehub/certs` — your
settings, recipe images, voice cache and certificate all survive an update untouched.

---

## What this does not cover

- **Renewing the panel certificate** — [`server-systemd.md` Part D](server-systemd.md#part-d--https-for-the-panel).
- **Changing settings** — edit `/etc/homehub/homehub.env` and `sudo systemctl restart homehub`. No
  redeploy needed.
- **The assistant and voice stack** — its own guide.

## The scripted version

`scripts/deploy.sh` automates exactly these seven steps, plus `--rollback`, `--releases` and
`--logs`. It is there if you ever want it; nothing in this guide depends on it.
