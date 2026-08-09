# Moving development onto the server

Today the repo lives on the Windows desktop, and every deploy cross-compiles a ~126 MB
self-contained bundle and pushes it over the wire. This guide moves the **working checkout** onto
the Ubuntu server (`192.168.5.15`), so that:

- a deploy becomes a local build and a symlink flip — no tar, no `scp`, no `chmod +x`;
- the dev loop (`dotnet watch` + Vite HMR) runs natively on the same box as SQL Server and Hermes;
- **Hermes can read and write the codebase** on a plain local path, alongside Claude Code.

You keep editing in **VS Code**, over the official **Remote - SSH** extension. Nothing about the
editing experience changes; the files and the toolchain simply live on the other machine.

> **Read this first.** Part 0 is not optional and not skippable. There are **246 changed files and
> 97 untracked files** in the Windows checkout right now, and **2 commits that have never been
> pushed**. If you clone onto the server before dealing with that, you will clone `origin/main` and
> silently leave months of work behind on a machine you have stopped using. Part 0 is the whole
> risk of this migration in one place.

Commands are labelled **[dev]** (the Windows desktop) and **[server]** (over ssh, as
`simpson@192.168.5.15`). After Part 5, "[server]" just means the VS Code terminal.

**Budget about 90 minutes**, most of it waiting on `npm ci` and the first `dotnet build`.

---

## Contents

- [Part 0 — Get the Windows work somewhere safe](#part-0--get-the-windows-work-somewhere-safe)
- [Part 1 — Prepare the server as a development machine](#part-1--prepare-the-server-as-a-development-machine)
- [Part 2 — Make ssh painless](#part-2--make-ssh-painless)
- [Part 3 — Clone and first build](#part-3--clone-and-first-build)
- [Part 4 — The five things git does not carry](#part-4--the-five-things-git-does-not-carry)
- [Part 5 — VS Code Remote - SSH](#part-5--vs-code-remote---ssh)
- [Part 6 — Run the dev loop](#part-6--run-the-dev-loop)
- [Part 7 — The new deploy](#part-7--the-new-deploy)
- [Part 8 — Hermes and Claude Code on the same tree](#part-8--hermes-and-claude-code-on-the-same-tree)
- [Part 9 — Retire the Windows checkout](#part-9--retire-the-windows-checkout)
- [Troubleshooting](#troubleshooting)
- [What this changes, in one table](#what-this-changes-in-one-table)

---

# Part 0 — Get the Windows work somewhere safe

**All of this is [dev], on the Windows desktop.** Do not touch the server until Part 0 finishes
clean.

## 0.1 · Look at what is actually uncommitted

```powershell
cd C:\CODE\HomeHub
git status
```

That is a long list. Read it rather than scrolling past it — this is your one chance to notice
something you did not mean to commit, and your one chance to notice something you *did* mean to
keep that is sitting untracked.

Two categories matter:

```powershell
# Files git is already tracking that you have modified or deleted
git status --porcelain | Select-String -NotMatch '^\?\?'

# Files git has never seen (the 97) — these are the dangerous ones
git status --porcelain | Select-String '^\?\?'
```

The tracked changes will come along with a commit automatically. The **untracked** ones will not
come along with anything unless you either add them or decide they are junk.

## 0.2 · Triage the untracked files

Most will be new source files that belong in the repo. Some will be scratch. Look for these
specifically before you `git add` anything:

| Pattern | What to do |
|---|---|
| New `.cs` / `.tsx` / `.ts` / `.css` under `src/` or `client/src/` | Commit — this is the work |
| New `.md` at the root | Commit if it is documentation, skip if it is scratch |
| Anything with a key, password or connection string in it | **Do not commit.** Move it into user secrets (0.4) |
| `HomeHubMeals.zip`, `__azurite_db_*`, `HomeHub_DesignPull/`, `ds-bundle/` | Already gitignored — ignore |

`.gitignore` already covers `*.zip`, `artifacts/`, `certs/`, `*.env`, `NOTES.md`, `node_modules/`
and the Azurite state, so the untracked list should be mostly genuine source. Spot-check anything
that surprises you:

```powershell
git status --porcelain | Select-String '^\?\?' | ForEach-Object { $_.ToString().Substring(3) }
```

## 0.3 · Commit and push

```powershell
git add -A
git status                     # LOOK AT IT AGAIN — this is what is about to become permanent
git commit -m "wip: checkpoint before moving development to the server"
git push origin main
```

You are 2 commits ahead already, so this push carries three commits total.

> **A "wip" commit is fine here.** The point of this commit is not tidy history — it is that the
> work exists in a second place before you walk away from the first. You can rewrite history later
> from the server if you want to; you cannot recover work that never left the desktop.

## 0.4 · Export your user secrets

**This is the step people forget, and the failure is confusing rather than loud.** The API has
`UserSecretsId` `54c59da6-3fb5-407f-92e0-4381bb765932`. That file is *not* in the repo and *not*
in the profile folder git knows about — it lives at:

```
C:\Users\allan\AppData\Roaming\Microsoft\UserSecrets\54c59da6-3fb5-407f-92e0-4381bb765932\secrets.json
```

Confirm it is there and see what is in it:

```powershell
dotnet user-secrets list --project src\HomeHub.Api
```

If that prints keys — SensorPush credentials, the Google/Microsoft OAuth pairs, `Ai:OpenAiApiKey`,
the Hermes per-profile keys — **you need them on the server**. Without them, every provider seam
silently falls back to its simulated implementation and you spend an afternoon wondering why the
sensors are producing suspiciously tidy numbers.

Copy the file somewhere you can reach from the server. The simplest safe route is straight over
ssh in Part 4; for now just confirm the path exists:

```powershell
Test-Path "$env:APPDATA\Microsoft\UserSecrets\54c59da6-3fb5-407f-92e0-4381bb765932\secrets.json"
```

Should print `True`. If it prints `False`, you have no user secrets and can skip the secrets half
of Part 4 entirely.

## 0.5 · Note what else is machine-local

Three more things are gitignored and will not travel. You do not need to act yet — Part 4 handles
each — but know they exist:

| Thing | Where | Part 4 step |
|---|---|---|
| `deploy/deploy.env` | Repo, gitignored (`*.env`) | 4.2 — recreate, no secrets in it |
| `certs/` — the dev CA **and its private key** | Repo, gitignored | 4.3 — **copy, do not regenerate** |
| `NOTES.md` | Repo root, gitignored | 4.4 — copy if you still want it |

> **The dev CA is the one that matters.** Every phone and tablet in the house has been told to
> trust `certs/homehub-dev-ca.crt`. If you generate a *new* CA on the server, every one of those
> devices stops trusting the dev server, and each has to be walked through the install-and-enable
> dance again (including iOS's Certificate Trust Settings toggle). Copying the existing CA across
> makes that a non-event. 4.3 does exactly that.

---

# Part 1 — Prepare the server as a development machine

**Everything in Part 1 is [server].** Log in:

```powershell
ssh simpson@192.168.5.15        # [dev]
```

## 1.1 · Check what the server is already running

Before adding anything, know what is there. Your production panel is on **5080/5081** (not the
5000/5001 the docs use as examples — `deploy/deploy.env` sets `HTTP_PORT=5080`,
`HTTPS_PORT=5081`).

```bash
sudo ss -lntp | grep -E ':(5080|5081|5173|5220|7288|8642|8643|1433)'
```

What you expect to see, and what each is:

| Port | What | Must stay working |
|---|---|---|
| 5080 / 5081 | The **live panel** (`homehub.service`) | Yes — the household uses this |
| 8642 / 8643 | Hermes gateways, Barnaby and Geist | Yes |
| 1433 | SQL Server | Yes |
| 5173 / 5220 / 7288 | **Should be empty** — these are what dev will take | — |

If 5173, 5220 or 7288 come back occupied, stop and find out by what. Vite is configured
`strictPort: true`, so it will refuse to start rather than quietly hop to 5174 — which is the
behaviour you want, but it means a conflict is a hard stop, not a warning.

Also check you have room. Each release is ~126 MB, `node_modules` is ~400 MB, and a debug build
tree is another few hundred:

```bash
df -h /home /opt
```

Anything under ~10 GB free on `/home` is worth clearing first.

## 1.2 · Install the .NET 10 SDK

The server currently has **no .NET at all** — by design, since releases are self-contained. That
changes now: building on the box requires the SDK (not just the runtime).

```bash
sudo apt-get update
sudo apt-get install -y dotnet-sdk-10.0
```

If Ubuntu's feed does not carry 10.0 yet, use Microsoft's:

```bash
# Only if the apt package above was not found
wget https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb -O /tmp/msprod.deb
sudo dpkg -i /tmp/msprod.deb
rm /tmp/msprod.deb
sudo apt-get update
sudo apt-get install -y dotnet-sdk-10.0
```

> Match the `24.04` to your actual release — `lsb_release -rs` tells you. A mismatched feed
> installs, then fails to find the package, which reads like a network problem.

Verify — you want **10.0.302** or newer, matching the desktop:

```bash
dotnet --version
dotnet --list-sdks
```

## 1.3 · Install Node 20+

The desktop is on Node 26. Ubuntu's packaged Node is far older and will not build this client.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node --version        # want v22 or newer
npm --version
```

> **Node 22 rather than 26 is deliberate.** 22 is the current LTS. The client is *built* with 26 on
> the desktop and nothing in it needs a 26-only feature; pinning the server to LTS is the version
> you want a household appliance building against. If you would rather match the desktop exactly,
> use `setup_26.x` — either works.

## 1.4 · Install the rest

```bash
sudo apt-get install -y git libicu-dev build-essential
```

- **`libicu-dev`** — `Directory.Build.props` sets `InvariantGlobalization=false`. Without ICU the
  first database call dies with *"Globalization Invariant Mode is not supported"*. Your server
  already has this from the original bootstrap, but installing again costs nothing.
- **`build-essential`** — some npm packages compile native bits.

## 1.5 · Tell git who you are

```bash
git config --global user.name "Allan Simpson"
git config --global user.email "allansimpson@outlook.com"

# The important one. On Linux this must be 'input', never 'true'.
git config --global core.autocrlf input
```

> **Why `input`.** `core.autocrlf=true` is the Windows setting — it converts to CRLF on checkout.
> On Linux that would write CRLF line endings into shell scripts, and a `.sh` file with CRLF fails
> on Linux with a *"bad interpreter: no such file or directory"* that names the interpreter and not
> the real cause. `input` normalises to LF in the repo and leaves the working tree alone. This one
> line is why several workarounds in `scripts/deploy.sh` stop being necessary.

## 1.6 · Give GitHub a credential

You will be pushing from the server. HTTPS with a cached credential is simplest:

```bash
git config --global credential.helper 'store --file ~/.git-credentials'
```

You will be prompted once on the first push and never again. Use a **GitHub personal access token**
as the password, not your account password — GitHub has not accepted passwords over HTTPS for
years, and the error it gives ("Support for password authentication was removed") is clear but only
appears after you have typed it.

> `credential.helper store` writes the token to `~/.git-credentials` in plain text, mode 600. On a
> single-user home server that is a reasonable trade. If you would rather not, set up an ssh
> deploy key instead and clone with the `git@github.com:` URL.

---

# Part 2 — Make ssh painless

**[dev], on Windows.** You are about to open this connection dozens of times a day. Two minutes
here removes a password prompt from every single one.

## 2.1 · Key-based login

If `C:\Users\allan\.ssh\id_ed25519` does not exist yet:

```powershell
ssh-keygen -t ed25519 -C "allan@desktop"
```

Accept the default path. A passphrase is your call — with the Windows ssh-agent running you will
type it once per boot.

Copy the public key up. Windows has no `ssh-copy-id`, so:

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh simpson@192.168.5.15 "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Test it — this should not ask for a password:

```powershell
ssh simpson@192.168.5.15 hostname
```

## 2.2 · Give the host a short name

Create or edit `C:\Users\allan\.ssh\config`:

```
Host homehub
    HostName 192.168.5.15
    User simpson
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
    ServerAliveCountMax 6
```

Now `ssh homehub` works, and — the reason this matters — **VS Code's Remote - SSH extension reads
this file**, so the server shows up in its host list by name with no further configuration.

`ServerAliveInterval` is not decoration: without it, a Remote - SSH session that idles through a
router's NAT timeout drops silently, and VS Code reports it as a mysterious "connection closed"
some minutes after you last touched the keyboard.

Test the alias:

```powershell
ssh homehub hostname
```

---

# Part 3 — Clone and first build

**[server].** `ssh homehub`.

## 3.1 · Choose where the code lives

```bash
mkdir -p ~/code
cd ~/code
git clone https://github.com/allansimpson/HomeHub.git
cd HomeHub
git log --oneline -3
```

That last line should show the `wip: checkpoint…` commit from 0.3 at the top. **If it does not,
stop** — Part 0 did not finish, and continuing here means working on stale code.

> **Why `~/code/HomeHub` and not `/opt/homehub`.** `/opt/homehub` is the *release* target — owned
> by the deploy account, read by the `homehub` service user, containing timestamped published
> output and nothing else. Putting a git checkout with `node_modules` and `obj/` into it would
> confuse the release/rollback model, and the service account has no business being able to read
> your working tree. Keep the two completely separate: source in `~/code`, releases in `/opt`.

## 3.2 · Restore and build the API

```bash
cd ~/code/HomeHub
dotnet restore
dotnet build
```

The first restore pulls the whole NuGet graph and takes a few minutes. Expect warnings; expect no
errors. If the build fails, it is almost always the SDK version — recheck `dotnet --list-sdks`
against 1.2.

## 3.3 · Install client dependencies

```bash
cd ~/code/HomeHub/client
npm ci
```

`npm ci` rather than `npm install` — it installs exactly what `package-lock.json` pins, which is
what you want when reproducing a known-good tree on a new machine.

This is the step that would have been unbearable over a Samba share. Natively it is a couple of
minutes.

## 3.4 · Run the tests

The honest check that the move worked:

```bash
cd ~/code/HomeHub
dotnet test
```

The suite uses `WebApplicationFactory` + EF InMemory and needs no database and no credentials, so
it should pass cleanly on a fresh machine. **745 unit checks** is the number you are looking for.
If they pass, the toolchain is correct and anything that breaks later is configuration, not setup.

---

# Part 4 — The five things git does not carry

Still **[server]** unless marked otherwise. Each of these is gitignored for a good reason, and each
has to be reconstructed by hand exactly once.

## 4.1 · User secrets

**[dev]**, on Windows — push the file up:

```powershell
$secrets = "$env:APPDATA\Microsoft\UserSecrets\54c59da6-3fb5-407f-92e0-4381bb765932\secrets.json"
ssh homehub "mkdir -p ~/.microsoft/usersecrets/54c59da6-3fb5-407f-92e0-4381bb765932"
scp $secrets homehub:~/.microsoft/usersecrets/54c59da6-3fb5-407f-92e0-4381bb765932/secrets.json
```

**[server]** — lock it down and confirm .NET can see it:

```bash
chmod 700 ~/.microsoft/usersecrets/54c59da6-3fb5-407f-92e0-4381bb765932
chmod 600 ~/.microsoft/usersecrets/54c59da6-3fb5-407f-92e0-4381bb765932/secrets.json

cd ~/code/HomeHub
dotnet user-secrets list --project src/HomeHub.Api
```

That last command must print the same keys `dotnet user-secrets list` printed on Windows in 0.4. If
it prints "No secrets configured for this application", the path or the ID is wrong — the GUID in
the directory name must match `UserSecretsId` in
[`HomeHub.Api.csproj`](../src/HomeHub.Api/HomeHub.Api.csproj) exactly.

> The Linux path is `~/.microsoft/usersecrets/<id>/secrets.json` — lowercase, under the home
> directory, not under `.config`. It is a different shape from the Windows path and the tooling
> gives no hint when you get it wrong; it simply finds nothing.

## 4.2 · `deploy/deploy.env`

Gitignored by the `*.env` rule. Recreate it with the values you are already using:

```bash
cd ~/code/HomeHub
cp deploy/deploy.env.example deploy/deploy.env
```

Then edit it to match your real configuration:

```ini
PANEL_HOST=192.168.5.15
PANEL_SSH_USER=simpson
HTTP_PORT=5080
HTTPS_PORT=5081
```

> **Note the ports.** 5080/5081, not the 5000/5001 that most of the docs use as examples. Something
> else on this server had 5000. Getting this wrong makes `deploy.sh --logs` and the health check
> point at nothing, and the deploy reports a failure that is really a wrong URL.

After Part 7 you will barely use this file — but `--rollback`, `--releases` and `--logs` all read
it, and those stay useful.

## 4.3 · The dev certificates — copy the CA, reissue the leaf

**This is the step with a trap in it.** `scripts/make-dev-certs.sh` **reuses an existing CA if one
is present** and only reissues the leaf. That behaviour is what lets you move machines without
re-trusting every phone in the house — but only if you copy the CA across *first*.

**[dev]**, on Windows:

```powershell
ssh homehub "mkdir -p ~/code/HomeHub/certs"
scp C:\CODE\HomeHub\certs\homehub-dev-ca.key homehub:~/code/HomeHub/certs/
scp C:\CODE\HomeHub\certs\homehub-dev-ca.crt homehub:~/code/HomeHub/certs/
```

**[server]** — now reissue the leaf so it carries the *server's* address:

```bash
cd ~/code/HomeHub
chmod 600 certs/homehub-dev-ca.key
bash scripts/make-dev-certs.sh
```

Read the output. It must say:

```
CA        : reusing /home/simpson/code/HomeHub/certs/homehub-dev-ca.crt
```

If it says `CA : creating` instead, the copy did not land — **stop, delete the new files, and redo
the copy**, because every household device has just been orphaned from its trust anchor.

The script's IP detection has a non-Windows fallback (`ip -4 -o addr show scope global`), so it
picks up `192.168.5.15` automatically. Check the `SANs:` line it prints includes that address.

Two consequences worth knowing:

- The leaf now covers the *server's* IP, not the desktop's. That is correct — the dev server now
  runs there. Phones reach it at `https://192.168.5.15:5173`.
- The script copies the CA into `client/public/homehub-dev-ca.crt` so a new phone can download it
  from the dev server itself. That file is gitignored and machine-local. **Delete it from
  `client/public/` before any production build** — otherwise a release publishes your development
  CA at a public URL. The `.gitignore` comment on that rule says the same thing.

## 4.4 · `NOTES.md`, if you want it

Gitignored deliberately (it has held pasted secrets). Bring it if it still has anything live in it:

```powershell
scp C:\CODE\HomeHub\NOTES.md homehub:~/code/HomeHub/NOTES.md     # [dev]
```

## 4.5 · A separate development database — do not skip this

**The single most dangerous thing about developing on this box is that SQL Server is right there,
holding the household's real data.** `dotnet ef database update` against the wrong connection
string, or a migration you are still iterating on, and you are restoring the family's sensor
history from a backup you may not have.

Create a dev database with its own login. **[server]**:

```bash
# The sqlcmd that ships with mssql-tools; adjust the path if yours differs
/opt/mssql-tools18/bin/sqlcmd -S 127.0.0.1 -U sa -C
```

At the `1>` prompt:

```sql
CREATE DATABASE HomeHub_Dev;
GO
CREATE LOGIN homehub_dev WITH PASSWORD = 'pick-a-strong-one-here';
GO
USE HomeHub_Dev;
GO
CREATE USER homehub_dev FOR LOGIN homehub_dev;
ALTER ROLE db_owner ADD MEMBER homehub_dev;
GO
EXIT
```

Then point **development only** at it, via user secrets — which the production service never reads:

```bash
cd ~/code/HomeHub
dotnet user-secrets set "ConnectionStrings:HomeHub" \
  "Server=127.0.0.1,1433;Database=HomeHub_Dev;User Id=homehub_dev;Password=pick-a-strong-one-here;TrustServerCertificate=True;Connect Timeout=60" \
  --project src/HomeHub.Api
```

Prove the separation, out loud, before you run a single migration:

```bash
dotnet user-secrets list --project src/HomeHub.Api | grep ConnectionStrings
grep ConnectionStrings /etc/homehub/homehub.env
```

The first must say `HomeHub_Dev`. The second must say `HomeHub`. **They must differ.** If they are
the same, fix it now — this is the one mistake in this guide that is not recoverable with a
symlink flip.

> `127.0.0.1` rather than `localhost`, for the same reason `server-systemd.md` gives: on Linux
> `localhost` can resolve to `::1` first, SQL Server listens on IPv4, and the result is a puzzling
> timeout rather than a refusal.

Now create the schema in the dev database:

```bash
dotnet ef database update --project src/HomeHub.Api
```

---

# Part 5 — VS Code Remote - SSH

**[dev]**, on Windows. This is the part that makes it feel local.

## 5.1 · Install the extension

In VS Code: Extensions → search **"Remote - SSH"** → the one published by **Microsoft**
(`ms-vscode-remote.remote-ssh`). Install it.

## 5.2 · Connect

- `F1` → **Remote-SSH: Connect to Host…**
- Pick **homehub** — it is listed because of the `~/.ssh/config` entry from 2.2.
- First connect downloads the VS Code server onto the Ubuntu box (~100 MB, one time). The bottom-left
  status bar turns green and reads **SSH: homehub**.

That green indicator is your safety check for the rest of your life on this project: it tells you
which machine the terminal, the debugger, and every file you open belong to.

## 5.3 · Open the folder

`File → Open Folder…` → `/home/simpson/code/HomeHub` → Open.

## 5.4 · Install the extensions *on the server side*

This trips everyone once. Extensions are installed **per-remote** — your local extensions do not
automatically run in the remote. Open the Extensions panel and you will see two groups: "Local" and
"SSH: homehub". Anything that has to touch the code must be in the second group; each shows an
**"Install in SSH: homehub"** button.

Install at minimum:

| Extension | Why |
|---|---|
| **C# Dev Kit** (`ms-dotnettools.csdevkit`) | IntelliSense, build, test, debug for the API |
| **ESLint** (`dbaeumer.vscode-eslint`) | Client linting |
| **Prettier** | If you use it |
| **Claude Code** | So it runs on the server, next to Hermes — see Part 8 |

To make this automatic for the future, add to `.vscode/extensions.json` in the repo. Note that
`.gitignore` excludes `*.code-workspace`, so don't rely on `HomeHub.code-workspace` carrying this.

Give the C# Dev Kit a minute to load the solution the first time. When the status bar stops
churning, open a `.cs` file and hover a symbol — if you get IntelliSense, the language server is
running natively on the server and the migration has essentially worked.

## 5.5 · Port forwarding — mostly automatic

VS Code auto-forwards ports it sees a process listening on, and shows them in the **Ports** panel
next to the terminal. When you start Vite you will get `localhost:5173` on the Windows machine
tunnelled to the server, so the desktop browser works with no LAN configuration at all.

For a **phone or tablet**, the tunnel is irrelevant — those devices hit `https://192.168.5.15:5173`
directly across the LAN, which works because Vite is configured `host: true` and the leaf
certificate from 4.3 now covers that address.

---

# Part 6 — Run the dev loop

**[server]** — meaning the VS Code integrated terminal from here on. Use two terminals (the split
button, or `Ctrl+Shift+5`).

## Terminal 1 — the API

```bash
cd ~/code/HomeHub
dotnet watch --project src/HomeHub.Api
```

Binds **5220** (HTTP) and, because `certs/homehub-dev.crt` now exists, **7288** (HTTPS), on
`0.0.0.0`.

## Terminal 2 — the SPA

```bash
cd ~/code/HomeHub/client
npm run dev
```

Binds **5173**, HTTPS (the cert is present), proxying `/api` to `https://localhost:7288`. Both hops
stay on the server, which is why no CORS configuration is needed.

## Where to point a browser

| From | URL |
|---|---|
| Windows desktop | `https://localhost:5173` — via the VS Code forwarded port |
| Phone / tablet / the Pi | `https://192.168.5.15:5173` |
| The live panel, untouched | `https://192.168.5.15:5081` |

**File watching works.** This is the payoff over a Samba share: edit a `.tsx` in VS Code and Vite
HMR fires immediately, because the file is on ext4 and inotify actually delivers the event. Edit a
`.cs` and `dotnet watch` rebuilds. Nothing round-trips over the network except your keystrokes.

## Debugging

`F5` in the remote window attaches the debugger to a process running on the server. Breakpoints,
watches, and stepping all behave normally — the debug adapter runs server-side and only the UI is
local. This is a capability a Samba share simply does not have.

---

# Part 7 — The new deploy

The old flow was: build on Windows → cross-compile self-contained linux-x64 → tar → scp 126 MB →
unpack → `chmod +x` → flip → restart. Six of those eight steps existed only because the build
happened on a different machine with a different filesystem.

Now the build is already on the target. **[server]:**

```bash
cd ~/code/HomeHub

# Work from committed code, not your working tree
git status                                  # should be clean
STAMP=$(date +%Y%m%d-%H%M%S)

# 1. Build the SPA into wwwroot
(cd client && npm ci && npm run build)

# 2. Publish straight into the release directory — framework-dependent, since the SDK is here now
dotnet publish src/HomeHub.Api/HomeHub.Api.csproj -c Release \
  -o /opt/homehub/releases/$STAMP

# 3. Permissions for the service account
chgrp -R homehub /opt/homehub/releases/$STAMP
chmod -R g+rX /opt/homehub/releases/$STAMP

# 4. Atomic flip
ln -sfn /opt/homehub/releases/$STAMP /opt/homehub/current.tmp
mv -Tf /opt/homehub/current.tmp /opt/homehub/current

# 5. Restart and verify — note port 5080
sudo systemctl restart homehub
curl -s "http://127.0.0.1:5080/api/health?deep=true"
```

Three things that were mandatory before and are now gone:

- **No `chmod +x HomeHub.Api`.** A native Linux publish sets the executable bit itself. The old
  `203/EXEC` failure came from `tar` on a Windows filesystem dropping it.
- **No CRLF stripping.** `core.autocrlf=input` (1.5) means shell scripts are checked out with LF.
- **No `--self-contained`.** The SDK is on the box, so releases drop from ~126 MB to ~15 MB. Five
  retained releases go from 630 MB to 75 MB.

> **If you prefer to keep self-contained releases**, add
> `-r linux-x64 --self-contained true` back to step 2. The build is still local and still fast;
> you just spend the disk. Self-contained is genuinely more robust — a release cannot be broken by
> someone upgrading the SDK — so this is a real trade, not an obvious win either way.

## Before deleting the old script

`scripts/deploy.sh` still works from Windows and is worth keeping until the new flow has served you
a few times. Its genuinely valuable part is `restart_and_verify` — the health-check loop that
distinguishes "systemd says active" from "the app actually answers", checks
`pendingMigrations`, and warns separately about an unreachable database. Do not throw that away;
fold it into whatever you replace the script with.

## Migrations against the live database

`git status` clean and a deploy is one thing. A **schema change** is another, and it is the only
part of a deploy that a symlink flip cannot roll back. When a release carries a migration:

```bash
# Back up first. Every time. No exceptions.
/opt/mssql-tools18/bin/sqlcmd -S 127.0.0.1 -U sa -C \
  -Q "BACKUP DATABASE HomeHub TO DISK='/var/opt/mssql/backup/HomeHub-$(date +%F).bak'"
```

Migrations run automatically at startup when a connection string is present, and a failure there is
logged non-fatally — which means a broken migration produces a *running* service with a stale
schema. That is what `pendingMigrations` in the health check exists to catch. Read it.

---

# Part 8 — Hermes and Claude Code on the same tree

This is the reason for the move, and the part with the most room to go wrong. Hermes runs on this
box already (`127.0.0.1:8642` Barnaby, `127.0.0.1:8643` Geist). It can now be given a filesystem
path to the codebase.

## 8.1 · The problem to avoid

**Two agents editing the same working tree concurrently will destroy each other's work.** This is
not a merge conflict git can help with — they are both writing the same dirty files, and the loser
is whoever read the file first. Git never sees a conflict because there was never a second commit.

## 8.2 · The fix: a worktree per agent

`git worktree` gives each agent its own directory and its own branch, sharing one object store.
Cheap in disk, and integrating the work is an ordinary merge.

```bash
cd ~/code/HomeHub
git worktree add ../HomeHub-hermes -b hermes/scratch
git worktree list
```

You now have:

| Path | Branch | Who edits it |
|---|---|---|
| `~/code/HomeHub` | `main` | You, in VS Code, and Claude Code |
| `~/code/HomeHub-hermes` | `hermes/scratch` | Hermes |

Hermes's worktree needs its own dependencies, since `node_modules` and `obj/` are per-directory:

```bash
cd ~/code/HomeHub-hermes
npm --prefix client ci
dotnet restore
```

Reviewing what Hermes did is then a normal git operation:

```bash
cd ~/code/HomeHub
git log main..hermes/scratch --oneline
git diff main..hermes/scratch
git merge hermes/scratch          # when you are happy with it
```

> **Ports.** Only one of the two trees can hold 5173/5220/7288 at a time — `strictPort: true`
> means the second `npm run dev` fails loudly rather than drifting to 5174. That is the correct
> behaviour; it just means agreeing that the dev servers run out of *your* tree, and Hermes builds
> and tests but does not serve. If Hermes genuinely needs to run the app, give it a different port
> pair via `--port` and `Server__HttpPort`.

## 8.3 · Consider read-only first

If Hermes's job is mostly analysis and review — which, reading `HERMES_INTEGRATION.md`, is where
the useful work is — mount the repo read-only for it and have it propose patches rather than apply
them. You get the benefit with none of the concurrency risk, and you can loosen it later. Going the
other way, after an agent has silently clobbered an afternoon's work, is less pleasant.

## 8.4 · Move Claude Code onto the server too

Run it in the VS Code remote terminal rather than on Windows. Same reasoning as everything else:
native filesystem, same box as Hermes and SQL Server, and it can actually run the tests and the
service it is reasoning about.

## 8.5 · Two boundaries to keep

Nothing in this part should weaken what `HERMES_INTEGRATION.md` already establishes:

- **Filesystem access is not house-control access.** Hermes being able to read `src/` says nothing
  about which MCP tools it may call. Question 9 in `HERMES_QUESTIONS_ROUND2.md` — the read-only
  allowlist for Geist, writes reserved to Barnaby — is enforced by the credential and the
  per-profile toolset, and stays exactly as it is.
- **Neither agent gets the production connection string.** They work against `HomeHub_Dev` like
  you do. `/etc/homehub/homehub.env` is root-owned and stays that way.

---

# Part 9 — Retire the Windows checkout

Do this **after a week of comfortable use**, not on day one. Until then the Windows copy is your
insurance.

## 9.1 · Confirm nothing is stranded

**[dev]:**

```powershell
cd C:\CODE\HomeHub
git status                       # must be clean
git log origin/main..HEAD        # must be empty
git stash list                   # must be empty
```

All three clean means everything that machine held is on GitHub, and therefore on the server.

## 9.2 · Make it read-only in practice

The failure mode now is *forgetting which machine you are on* and editing the desktop copy for an
hour. Two defences:

```powershell
# Rename it so the path no longer matches muscle memory
Rename-Item C:\CODE\HomeHub C:\CODE\HomeHub-OLD-ARCHIVE
```

And in VS Code, remove `C:\CODE\HomeHub` from the recent-folders list so it stops being one click
away.

## 9.3 · Keep the secrets

**Do not delete** `%APPDATA%\Microsoft\UserSecrets\54c59da6-…\`. It is the only copy of those
credentials outside the server, and it costs nothing to leave alone.

## 9.4 · What stays useful on Windows

- **The dev CA private key**, at `C:\CODE\HomeHub-OLD-ARCHIVE\certs\` — a second copy of the thing
  every household device trusts. Worth keeping precisely because it is not in git.
- The archive itself, until you are certain.

---

# Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `dotnet: command not found` in the VS Code terminal | PATH not picked up by a non-login shell | `source /etc/profile.d/dotnet*.sh`, or reconnect the window |
| Every provider is simulated; sensors look too tidy | User secrets did not land | 4.1 — check the GUID directory name matches `UserSecretsId` exactly |
| `Globalization Invariant Mode is not supported` | `libicu` missing | `sudo apt-get install -y libicu-dev` (1.4) |
| `bad interpreter: no such file or directory` on a `.sh` | CRLF line endings | `git config --global core.autocrlf input`, then re-clone (1.5) |
| Vite exits: port 5173 in use | Something else has it, or a second worktree is serving | `sudo ss -lntp \| grep 5173` |
| Phone shows a certificate warning and no camera | Leaf does not cover the server IP, or the CA was regenerated | Re-run 4.3; confirm it says **reusing**, and check the `SANs:` line |
| C# IntelliSense dead, no errors shown | C# Dev Kit installed locally, not in the remote | 5.4 — install it under "SSH: homehub" |
| Remote - SSH drops after idling | NAT timeout | `ServerAliveInterval 30` in `~/.ssh/config` (2.2) |
| `"database":"unreachable"` from dev | Dev connection string wrong, or `HomeHub_Dev` not created | 4.5 |
| `"database":"unreachable"` from the live panel | You changed the wrong connection string | `/etc/homehub/homehub.env` must still say `Database=HomeHub` |
| Deploy succeeds, panel serves stale UI | `npm run build` skipped, so `wwwroot` is old | Re-run step 1 of Part 7 |
| `pendingMigrations` non-zero after deploy | A startup migration failed and was swallowed | `journalctl -u homehub -n 40 --no-pager` |

## If you need to abandon the move

Nothing here is destructive until Part 9. To back out:

1. `git pull` on the Windows checkout — it now has everything from the server.
2. Carry on as before with `scripts/deploy.sh`.
3. Delete `~/code/HomeHub` on the server at your leisure.

The production service is never touched by Parts 0–6, so the household panel keeps running
throughout regardless.

---

# What this changes, in one table

| | Before | After |
|---|---|---|
| Working tree | `C:\CODE\HomeHub` (NTFS) | `~/code/HomeHub` (ext4) |
| Editor | VS Code, local | VS Code, Remote - SSH |
| Build target | cross-compile linux-x64 from Windows | native |
| Deploy | build → tar → scp 126 MB → unpack → `chmod +x` → flip | publish into `releases/` → flip |
| Release size | ~126 MB (self-contained) | ~15 MB (framework-dependent) |
| File watching | local only | works, natively |
| Debugger | local only | remote, full |
| Dev database | remote SQL over the LAN | `HomeHub_Dev` on `127.0.0.1` |
| Hermes access to the code | none | `~/code/HomeHub-hermes`, own branch |
| CRLF / exec-bit workarounds | three, in `deploy.sh` | none needed |

## See also

- [`updating.md`](updating.md) — the old Windows-to-server deploy, still valid as a fallback
- [`server-systemd.md`](server-systemd.md) — how the server was originally set up
- [`dev-https.md`](dev-https.md) — trusting the dev CA on phones and tablets
- [`ai-stack.md`](ai-stack.md) — Hermes, the MCP seam, the voice stack
- [`../HERMES_INTEGRATION.md`](../HERMES_INTEGRATION.md) — the agent seam and its security boundaries
