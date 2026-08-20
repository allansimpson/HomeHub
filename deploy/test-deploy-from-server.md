# Deploying the TEST instance from the server itself

A runbook for an agent (or a person) working **on the panel server**, with no ssh hop. It does by
hand what `scripts/deploy.sh` does over the network: build here, stage a release under
`/opt/homehub-test/releases`, flip the `current` symlink, restart the unit, prove it answers.

`scripts/deploy.sh` is still the better route when you are on a workstation —
`DEPLOY_ENV=deploy/deploy-test.env bash scripts/deploy.sh`. This file exists for the case where the
work is happening on the box, where scp-ing a 100 MB tarball to `localhost` is a copy with extra
steps.

**Run the steps in order and stop at the first one whose check fails.** Each check is there because
the failure it catches is silent: a release that unpacks and cannot be read, a symlink flipped to a
build that will not start, a health probe answered by the *other* instance.

---

## 0 · Facts this runbook needs, and cannot assume

The test instance is provisioned out-of-band (see `server-systemd.md`), so its port, its service
account and its group are whatever they were set to. Read them; do not copy production's.

```bash
systemctl show homehub-test -p User -p Group -p WorkingDirectory
sudo grep -E 'Server__HttpPort|Server__HttpsPort' /etc/homehub-test/homehub-test.env
readlink -f /opt/homehub-test/current
```

Hold three values for the rest of this file:

| Name | Where it came from |
|---|---|
| `TEST_PORT` | `Server__HttpPort` above — **not** production's 5080 |
| `TEST_GROUP` | the unit's `Group=` |
| `PREVIOUS` | what `current` points at now, for the rollback at the bottom |

```bash
TEST_PORT=<from above>
TEST_GROUP=<from above>
PREVIOUS="$(readlink -f /opt/homehub-test/current)"
```

## 1 · Clear the build blocker

Five files in the working tree are `root:root` mode 660 and unreadable by the repo's own account, so
`dotnet publish` fails with `CS1504 … Access to the path … is denied` before it compiles anything.

```bash
sudo chown simpson:geist-dev \
  /srv/dev/homehub/src/HomeHub.Api/Program.cs \
  /srv/dev/homehub/src/HomeHub.Api/Meals/MealModels.cs \
  /srv/dev/homehub/src/HomeHub.Api/Controllers/RecipesController.cs \
  /srv/dev/homehub/tests/HomeHub.Tests/HubAppFactory.cs \
  /srv/dev/homehub/tests/HomeHub.Tests/MealNotificationTests.cs
```

**Check** — no output means every file in the project is readable:

```bash
find /srv/dev/homehub/src /srv/dev/homehub/tests -name '*.cs' ! -readable
```

## 2 · Build the panel

`npm run build` is `tsc -b && vite build`, and it writes into the API's `wwwroot` — that is how the
SPA gets into the publish. It empties the directory first, so nothing stale survives.

```bash
cd /srv/dev/homehub/client
npm ci
npm run build
```

**Check** — the worker must carry a build stamp and know how to hand over. The instance being
offered updates it cannot apply is exactly the state this deploy exists to end:

```bash
cat /srv/dev/homehub/src/HomeHub.Api/wwwroot/build.json
grep -o "const BUILD = '[^']*'" /srv/dev/homehub/src/HomeHub.Api/wwwroot/sw.js
grep -c SKIP_WAITING /srv/dev/homehub/src/HomeHub.Api/wwwroot/sw.js   # 1 or more
```

An old worker answers the first two with nothing and the third with `0`. If that happens the build
did not run — do not carry on and deploy it.

## 3 · Publish the API

Self-contained, so the instance needs no .NET on the box. Its own folder, so a half-finished publish
never mixes with `scripts/deploy.sh`'s.

```bash
cd /srv/dev/homehub
rm -rf artifacts/publish-test
dotnet publish src/HomeHub.Api/HomeHub.Api.csproj \
  -c Release -r linux-x64 --self-contained true \
  -o artifacts/publish-test --nologo -v minimal
```

**Check** — the SPA travelled with it:

```bash
ls artifacts/publish-test/HomeHub.Api artifacts/publish-test/wwwroot/build.json
grep -o "const BUILD = '[^']*'" artifacts/publish-test/wwwroot/sw.js
```

## 4 · Stage the release

Timestamped and named after the commit, matching what `deploy.sh` writes, so `--releases` and a
rollback still read sensibly afterwards.

```bash
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$(git -C /srv/dev/homehub rev-parse --short HEAD 2>/dev/null || echo local)"
REL="/opt/homehub-test/releases/$STAMP"

sudo mkdir -p "$REL"
sudo cp -a /srv/dev/homehub/artifacts/publish-test/. "$REL"/
sudo chmod +x "$REL/HomeHub.Api"
sudo chgrp -R "$TEST_GROUP" "$REL"
sudo chmod -R g+rX "$REL"
```

`chgrp` is not housekeeping. The service account reads these files as a group member; a release
carrying the wrong group is one systemd cannot execute, and it presents as a unit that will not
start over files that look perfectly fine.

**Check**:

```bash
ls -ld "$REL" && sudo -u "$(systemctl show homehub-test -p User --value)" test -x "$REL/HomeHub.Api" && echo "executable by the service account"
```

## 5 · Flip, atomically

`ln -sfn` onto an existing symlink-to-a-directory creates a link *inside* the old target instead of
replacing it. Writing a temporary link and `mv -T`-ing over it is the version that actually replaces.

```bash
sudo ln -sfn "$REL" /opt/homehub-test/current.tmp
sudo mv -Tf /opt/homehub-test/current.tmp /opt/homehub-test/current
readlink -f /opt/homehub-test/current    # must be $REL
```

## 6 · Restart and prove it serves

"Active" is not "answering": a bad connection string produces a process that starts, throws, and is
restarted forever, which `systemctl is-active` reports as running.

```bash
sudo systemctl restart homehub-test
sleep 3
curl -fsS "http://127.0.0.1:$TEST_PORT/api/health?deep=true"
```

**Required in that response**: `"database":"ok"` and `"pendingMigrations":0`. Anything else means the
release is on disk and must not be treated as deployed — roll back (below) and read
`journalctl -u homehub-test -n 50 --no-pager`.

## 7 · Prove the update path itself

This is the point of the exercise: the phone's APPLY NOW fails when the worker it is handed cannot
take a hand-over.

```bash
curl -s "http://127.0.0.1:$TEST_PORT/build.json"                              # 200, the new stamp
curl -s "http://127.0.0.1:$TEST_PORT/sw.js" | grep -o "const BUILD = '[^']*'" # the same stamp
curl -s "http://127.0.0.1:$TEST_PORT/sw.js" | grep -c SKIP_WAITING            # 1 or more
```

A `401` on `build.json` means the file is not in the release and the request fell through to the
authenticated SPA fallback — devices with no service worker will never be offered an update. A
`sw.js` with no `BUILD` and no `SKIP_WAITING` is the old worker: the plate will appear and every
apply will time out after 20 seconds.

## 8 · On the phone

Background the app for two minutes and reopen it — that is the `visibilitychange` check, throttled
to once every two minutes; otherwise it is up to thirty. The plate should name the new build, and
APPLY NOW should return on it rather than reporting "still on …".

---

## Rollback

```bash
sudo ln -sfn "$PREVIOUS" /opt/homehub-test/current.tmp
sudo mv -Tf /opt/homehub-test/current.tmp /opt/homehub-test/current
sudo systemctl restart homehub-test
curl -fsS "http://127.0.0.1:$TEST_PORT/api/health?deep=true"
```

## What this runbook does not touch

`/etc/homehub-test/homehub-test.env`, `/var/lib/homehub-test`, and the instance's database. A deploy
replaces code; state and settings are the instance's own and outlive it. If the new build needs a
setting the test instance has never been given, this deploy will not add it — that is the
out-of-band provisioning gap `server-systemd.md` warns about, and it is why step 6 checks readiness
rather than trusting the restart.
