# Server deployment — Ubuntu (systemd), by hand

Every step here is a command you run yourself. Nothing is automated.

The panel is one deployable unit: the ASP.NET Core API serves the built React SPA from `wwwroot`.
You build it on your dev machine and copy the result to the server. **The server needs no .NET, no
Node, and no copy of this repo** — a release carries its own runtime.

- **Setting up a new server?** Work through **A → B → C → D** in order. All four are part of the
  build: prepare the machine, give it the database, deploy a release, then give it HTTPS.
- **Pushing an update to a panel that already runs?** [`updating.md`](updating.md) — that job on its
  own, without the setup around it. (It is the same steps as [Part C](#part-c--deploy-a-release).)
- **Rolling back?** [Part E](#part-e--roll-back).
- **Want the assistant and the voice?** [`ai-stack.md`](ai-stack.md) — the local model, the cloud
  tier, speech-to-text and the house voice. Genuinely optional, any time after C.
- **Something wrong?** [Troubleshooting](#troubleshooting).
- **Why it is built this way?** [Reference](#reference).

Commands are marked **[dev]** to run on your machine and **[server]** to run over ssh.

> **Note on step names.** The server-prep steps below are `A1`–`A6`. [`ai-assistant.md`](../ai-assistant.md)
> uses `A1`–`A7` for the *AI assistant build stages* — a different, unrelated sequence. Nothing
> here depends on those, and the two never need doing together. Worth knowing before someone reads
> "A2" in the wrong document.

---

## Before you start

| Need | Check it with | If it fails |
|---|---|---|
| SSH to the server | `ssh <user>@<server> hostname` | `ssh-copy-id <user>@<server>` |
| `sudo` on that account | `ssh <user>@<server> sudo -v` | Use an account in the `sudo` group |
| `HomeHub` database reachable **from the server** | `ssh <user>@<server> "nc -zv <sql-host> 1433"` | Open TCP 1433 to the panel host |

The Ubuntu server and SQL Server already exist — this guide installs neither.

### Two machines — know which one you are typing on

This is the single thing to keep straight. Every code block below is labelled:

| Label | Where you type it | You are in… |
|---|---|---|
| **[dev]** | Your Windows machine, **at the repo root** | Git Bash / your normal terminal |
| **[server]** | The Ubuntu server, over ssh | the ssh session |

Write your own two values down now — every `<you>@<server>` below means these:

```
<you>     = your ssh username on the server     e.g. simpson
<server>  = the server's hostname or IP         e.g. 192.168.5.15
```

so `<you>@<server>` reads `simpson@192.168.5.15`, and `scp file <you>@<server>:/tmp/` becomes
`scp file simpson@192.168.5.15:/tmp/`.

> **Why spelled out rather than a shell variable.** A variable would be tidier to paste, but it lives
> only in the one shell that set it — it does not follow you into a second terminal window, and it
> does not travel with you onto the server. An unset one turns `scp file $PANEL:/tmp/` into
> `scp file :/tmp/`, which fails without ever mentioning the variable. Substituting two values by
> hand is duller and never lies to you.

### Ports — check yours before trusting any URL here

Examples below use **5080** for HTTP and **5081** for HTTPS. They are set in A4:

```ini
Server__HttpPort=5080
Server__HttpsPort=5081
```

**Not 5000/5001** — a home server usually has 5000 taken already (Kavita, Flask apps, many add-ons
default to it), and a busy port does not degrade gracefully: the host stops, systemd restarts it
seconds later, the dying process still holds the socket, and it crash-loops. A1 has you check. If you
pick a different pair then *every URL in this guide uses your numbers instead*.

> **These must match `HTTP_PORT` / `HTTPS_PORT` in `deploy/deploy.env` on your dev machine.** They are
> different settings doing different jobs — `Server__HttpPort` is where the app *binds*; `HTTP_PORT`
> is only where `deploy.sh` *probes* for health and what URLs it prints — and nothing checks that they
> agree. When they disagreed here, a good deploy still reported failure, because the verification
> curled a port nothing was listening on.
>
> **If `Server__HttpPort` is absent the app falls back to 5080**, matching this guide — it used to
> fall back to 5000, which is how a machine ends up crash-looping on a port nobody chose. Either way,
> the bind error names the port actually attempted, not the one you meant, so read it literally.

Find them any time:

```bash
grep Server__Http /etc/homehub/homehub.env      # what is configured
sudo ss -lntp | grep -i homehub                 # what is actually bound
```

The second is the one to trust — it is what the running process holds, and the answer to almost
every "why is it refusing the connection" question.

---

# Part A — Prepare the server (once)

**Everything in Part A happens on the server**, in one ssh session, except the file copy in A5 —
which is called out clearly when you get there.

Log in and become root — **[dev]**, then you are on the server for the rest of this part:

```bash
ssh <you>@<server>      # [dev] — e.g. ssh simpson@192.168.5.15
sudo -i                 # [server] — asks for your password
```

Your prompt changes to `root@<server>:~#`. That is how you know the following steps are landing on
the server and not on your laptop.

### A1 · Install the two packages needed

```bash
apt-get update
apt-get install -y libicu-dev curl
```

`libicu-dev` is not optional. The app runs with globalization on, and without it the first database
connection dies with *"Globalization Invariant Mode is not supported"*.

> **Check the ports are free before you go further.** A home server usually has other things on it.
> This guide uses 5080/5081 precisely because 5000 is a popular default — Kavita, Flask apps and
> various add-ons all want it — but check the pair you are about to use regardless.
>
> ```bash
> sudo ss -lntp | grep -E ':(5080|5081)'
> ```
>
> Anything listed means the pair A4 uses is taken; pick another and change it in A4, in
> `deploy/deploy.env`, and in the kiosk URL in [`pi-kiosk.md`](pi-kiosk.md) — all three, or they
> disagree silently.

> **`apt-get update` warnings about other repositories are fine.** A home server usually carries
> third-party apt sources — a Home Assistant addon repo, a PPA — and one of them failing to resolve
> looks alarming but is unrelated:
>
> ```
> Err:1 https://repo.home-assistant.io/addons/debian stable InRelease
>   Something wicked happened resolving 'repo.home-assistant.io:https' …
> W: Some index files failed to download. They have been ignored, or old ones used instead.
> ```
>
> `libicu-dev` and `curl` come from Ubuntu's own archives, which are the `Hit:` lines that succeeded.
> Carry on, and confirm the install actually worked:
>
> ```bash
> dpkg -s libicu-dev | grep '^Status:'    # Status: install ok installed
> command -v curl
> ```
>
> To silence it permanently, find and disable the source that is failing — it is not needed here:
>
> ```bash
> grep -rl "repo.home-assistant.io" /etc/apt/sources.list /etc/apt/sources.list.d/
> # then comment the line out, or: mv <that-file> <that-file>.disabled
> ```

### A2 · Create the service account

It owns the running process. No home directory, no login shell — nothing about serving a wall panel
needs the ability to log in as it.

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin homehub
```

Then add **your own** account to two groups (replace `allan` with your username):

```bash
usermod -a -G homehub allan
usermod -a -G systemd-journal allan
```

- `homehub` — so the files you upload can be read by the service.
- `systemd-journal` — so you can read the service log without `sudo`.

### A3 · Create the directories

```bash
mkdir -p /opt/homehub/releases
mkdir -p /var/lib/homehub/recipe-images /var/lib/homehub/event-photos /var/lib/homehub/voice-cache /var/lib/homehub/keys
mkdir -p /etc/homehub/certs
```

Set ownership — you write releases, the service reads them:

```bash
chown -R allan:homehub /opt/homehub       && chmod -R 750 /opt/homehub
chown -R homehub:homehub /var/lib/homehub && chmod -R 750 /var/lib/homehub
chown -R allan:homehub /etc/homehub/certs && chmod 750 /etc/homehub/certs
```

Now set **setgid** on the two directories you will later write into. Do not skip this:

```bash
chmod g+s /opt/homehub /opt/homehub/releases /etc/homehub/certs
```

> **Why it matters more than it looks.** The `chown` above fixes ownership *now*. Everything created
> afterwards — `mkdir releases/<stamp>`, `tar -x` unpacking a release, `scp` dropping a certificate —
> is created with **your** primary group, not the directory's. A later `chmod g+rX` then grants read
> to a group the `homehub` service account is not in, and you get the most misleading failure
> available: `ls -l` looks entirely correct, the files are plainly there, and the service cannot read
> the application it is meant to run or the key it is meant to serve. setgid makes new entries
> inherit the directory's group, so this holds for every future deploy without anyone remembering it.
>
> `ls -ld /opt/homehub/releases` should show `drwxr-s---` — the `s` is the bit that matters.

`/var/lib/homehub` holds recipe images, the photographs engagements were read off, the voice cache,
and the Data Protection key ring. It lives outside the release directory so it survives every deploy.

> **Every one of these needs a path in the env file, and the app does not complain when one is
> missing.** `ProtectSystem=strict` in the unit mounts the whole filesystem read-only apart from
> `ReadWritePaths`, so a component left on its default — which is almost always somewhere under the
> release directory — cannot write and degrades quietly instead. `EventCapture__PhotoPath` is the
> one that has already been shipped without: kept flyer photographs went to
> `/opt/homehub/current/event-photos`, every write was refused, and `EventPhotoStore` read that as
> the ordinary "not kept" it also uses for a format the panel cannot draw. The setting said photos
> were being kept, the readings were perfect, and every event detail said "read from a photo · not
> kept". Check the whole list when you add an instance.

> **This applies to *every* instance, not just production.** A second environment — the TEST
> instance at `/opt/homehub-test` under `homehub-test.service` — is the same hardened unit with its
> own service account and its own `ReadWritePaths=/var/lib/homehub-test`, so it needs its own state
> directories and its own copy of each path setting in `/etc/homehub-test/homehub-test.env`.
> Provisioning it is out-of-band rather than scripted here, which is exactly how it ends up one
> setting behind production.

> **`keys/` is not a cache — losing it costs the household something.** It holds the keys that
> encrypt the stored Google and Microsoft refresh tokens (AUDIT A2). If the directory is deleted,
> moved, or recreated empty, those tokens become undecryptable and every household member has to
> re-link their account in Config. Nothing else breaks and nothing is dangerous — but it is annoying
> and entirely avoidable, so: back it up with the database, and never place it under
> `/opt/homehub/releases`, where the next deploy would leave it behind.
>
> The service account must own it and nobody else should read it: `chmod 700 /var/lib/homehub/keys`.
> The `chown -R homehub:homehub` above already covers ownership.

### A4 · Write the settings file

```bash
cat > /etc/homehub/homehub.env <<'EOF'
ASPNETCORE_ENVIRONMENT=Production

# Ports. Program.cs is the only thing that binds, so these are the only place they are declared —
# deliberately no ASPNETCORE_URLS. HTTP is always bound; HTTPS is added only when the certificate
# below is present.
Server__HttpPort=5080
Server__HttpsPort=5081

# HTTPS for the panel — set up in Part D, which is part of the build, not an extra. Leave these
# lines as they are: Kestrel binds 5081 the moment the files below exist, and ignores them until
# then, so the first deploy works before the certificate is issued.
Server__CertPath=/etc/homehub/certs/homehub-panel.crt
Server__KeyPath=/etc/homehub/certs/homehub-panel.key

# Runtime state, kept outside the release directory so it survives every deploy.
Meals__ImagePath=/var/lib/homehub/recipe-images
Voice__Tts__CacheDirectory=/var/lib/homehub/voice-cache

# The photographs engagements were read off. REQUIRED in production. Unset, EventPhotoStore falls
# back to `event-photos/` under the release directory, which ProtectSystem=strict mounts read-only.
# The failure is silent by design: a write that cannot land is treated as "not kept", which is the
# same ordinary outcome as a format the panel cannot draw, and the engagement is still written. The
# symptom is that "Keep photos read into events" is on, flyers read correctly, and every event
# detail says "read from a photo · not kept".
EventCapture__PhotoPath=/var/lib/homehub/event-photos

# Where Data Protection keeps the keys that encrypt stored OAuth refresh tokens (AUDIT A2).
# REQUIRED in production. Unset, ASP.NET Core falls back to $HOME/.aspnet/DataProtection-Keys —
# which ProtectHome=true in the unit file makes unwritable, so it degrades to keys held only in
# memory. That works perfectly until the first restart, and then every linked account silently
# stops refreshing. The app logs a warning at startup when this is missing.
DataProtection__KeyPath=/var/lib/homehub/keys

# Bearer credentials for callers that are programs rather than people (AUDIT A1). The panel and
# phones sign in with a PIN and hold a session cookie; the voice bridge is server-to-server and has
# nowhere to keep one, so it presents a token instead. One entry per caller, so revoking the bridge
# revokes nothing else and the log can say which caller did what.
#
# Generate with `openssl rand -hex 32`. Leave unset and no service caller is admitted at all, which
# is the right default — the panel itself does not use this.
#Auth__ServiceTokens__Tokens__voice-bridge=REPLACE_ME

# Which Host headers the app will answer (AUDIT A6). Left unset it accepts any, which is the safe
# default for a first deploy: the panel is reached by IP, by hostname and by <name>.local, and a
# value that misses one of those makes every request a 400 — the panel simply gone, health check
# included. Narrow it once the real names are known, semicolon-separated:
#AllowedHosts=homehub.local;192.168.1.50;localhost

# The database — see Part B. REQUIRED for anything beyond the shell.
# 127.0.0.1 rather than localhost when SQL Server is on this same host: `localhost` can resolve to
# ::1 first and SQL Server listens on IPv4, which turns a working setup into a puzzling timeout.
ConnectionStrings__HomeHub=Server=127.0.0.1,1433;Database=HomeHub;User Id=homehub_app;Password=REPLACE_ME;TrustServerCertificate=True

# Schema is applied at startup; a failure there is logged but non-fatal. Set false to apply by hand.
#RunMigrationsOnStartup=false

# --- Home Assistant ----------------------------------------------------------
# Three features ride this one token: mini-split climate, Huckleberry (baby tracking) and the
# Litter-Robot. Without it all three degrade quietly — climate shows no zones, and the Cat and Baby
# sections report "not connected". Nothing fails and nothing is logged as an error, so this is the
# setting most likely to be working on your dev machine (where it lives in user-secrets, which never
# leave that machine) and missing here.
#
# The token: HA → your profile → Long-Lived Access Tokens → Create Token. It needs service-call
# permission — the Litter-Robot recovery path calls services, it does not only read.
# Prefer 127.0.0.1 when HA runs on this same server.
#HomeAssistant__BaseUrl=http://127.0.0.1:8123
#HomeAssistant__Token=
#
# Children and robots are auto-discovered from HA's entity list — nothing to enumerate here.
# Optional display overrides:
#HomeAssistant__ZoneNames__climate.bedroom=Bedroom
#HomeAssistant__EveningScene=scene.evening

# --- Assist and voice (optional) ----------------------------------------------
# The panel works with none of this. With no agent key set, Assist answers with a canned line that
# says the assistant is unavailable — and the actions-first layer (timers, lists, climate) keeps
# working regardless, because it runs before any agent and needs no model at all.
#
# ---- Assist: the Hermes agents ----
#
# HomeHub chooses an AGENT. Hermes owns the model, provider, tier, routing, escalation, fallback and
# locality — none of which appear here, and none of which should ever be added. There is no model
# name, no provider and no route in HomeHub's configuration.
#
# One independent Hermes gateway per agent, each with its own profile, session database, memory and
# key. The endpoint IS the agent selector. Addresses live in appsettings.json; only the keys are
# secrets, and each gateway accepts only its own.
#
# Copy each value from that profile's own env file on this server:
#   grep API_SERVER_KEY /home/hermes/.hermes/profiles/barnaby/.env
#   grep API_SERVER_KEY /home/hermes/.hermes/profiles/geist/.env
#
# Double underscores, because this is the environment form of Hermes:Agents:barnaby:ApiKey.
# `dotnet user-secrets` does NOT work here — it is only read in Development.
#Hermes__Agents__barnaby__ApiKey=
#Hermes__Agents__geist__ApiKey=
#
# Loopback in appsettings.json is deliberate: API_SERVER_KEY has no route-level scoping, so the
# gateways are not exposed to the LAN. HomeHub therefore has to share this host's network namespace.
# If it is ever containerised without host networking, that is a deployment change to raise — not a
# reason to rebind Hermes.
#
# --- The house, exposed back to the agents (MCP) ---
#
# The other direction: these are the keys the AGENTS present to HomeHub, not the ones HomeHub
# presents to them. One per agent, each with its own method allowlist, because the two agents are
# not equally trusted with the house:
#
#   Barnaby  reads and writes  — thermostat, to-do list
#   Geist    reads only        — it advises; it does not touch the heating
#
# The Methods list is the authority. Hermes has matching include lists, but a restriction that lives
# only in a config file on another machine is one edit away from not existing — and the edit need not
# be malicious. HomeHub authorises every method call against the key that made it.
#
# NEVER give both agents the same key. Two agents behind one token cannot be told apart, so neither
# can be scoped, and startup refuses it rather than pretending otherwise.
#
# Generate two distinct keys:
#   openssl rand -hex 32   # -> barnaby
#   openssl rand -hex 32   # -> geist
#
#Mcp__Credentials__barnaby__ApiKey=<first hex string>
#Mcp__Credentials__barnaby__Methods__0=get_calendar
#Mcp__Credentials__barnaby__Methods__1=get_sensor_readings
#Mcp__Credentials__barnaby__Methods__2=get_climate_zones
#Mcp__Credentials__barnaby__Methods__3=set_climate_mode
#Mcp__Credentials__barnaby__Methods__4=set_climate_setpoint
#Mcp__Credentials__barnaby__Methods__5=add_todo
#
#Mcp__Credentials__geist__ApiKey=<second hex string>
#Mcp__Credentials__geist__Methods__0=get_calendar
#Mcp__Credentials__geist__Methods__1=get_sensor_readings
#Mcp__Credentials__geist__Methods__2=get_climate_zones
#
# Adding a tool to HouseTools later grants it to nobody until its name is added above. That is
# deliberate: forgetting should mean an agent that cannot do something, never one that quietly can.
#
# The old single shared key. Still works, still grants all six methods — but it cannot distinguish
# Barnaby from Geist, so it warns at startup and should be replaced by the pair above.
#Mcp__ApiKey=
#
# Cloud speech-to-text. This is a SPEECH credential that happens to be OpenAI's; it is not an
# assistant model choice and never reaches the agent path. Local Whisper below is the alternative.
#Ai__OpenAiApiKey=sk-...
#
# Local speech-to-text. LocalModel must be the Hugging Face repo id, not the plain Whisper name.
#Voice__Stt__LocalEndpoint=http://localhost:8000
#Voice__Stt__LocalModel=Systran/faster-whisper-base.en
#
# The house voice. Both paths required, or server TTS reports itself unconfigured and every
# spoken reply — the panel's and the Pi bridge's alike — falls back to the browser synthesizer.
#Voice__Tts__PiperPath=/opt/piper/.venv/bin/piper
#Voice__Tts__VoiceModel=/opt/piper/voices/en_US-norman-medium.onnx

# Other service credentials go here too, in the same __ form (see the README's config reference).
EOF
```

Lock it down — root-owned, readable only by the service's group:

```bash
chown root:homehub /etc/homehub/homehub.env
chmod 640 /etc/homehub/homehub.env
```

> Your deploy account is in the `homehub` group, so it can read this file. Treat anything you put
> here as visible to that account.

### A5 · Install the systemd unit

The unit file lives in the repo, on your dev machine, so this step needs both machines.

> **This is the only place in Part A where you leave the server.** Keep the root shell open in your
> current terminal — you come straight back to it.

**First, on your dev machine.** Open a **second terminal** and go to the repo root (the folder
containing `deploy/` and `client/`):

```bash
# [dev] — a NEW terminal, at the repo root
cd /c/CODE/HomeHub
scp deploy/homehub.service <you>@<server>:/tmp/
```

You should see `homehub.service   100%  ...`. If instead it says `No such file or directory`, you are
not in the repo root — check with `ls deploy/homehub.service`.

**Now back to the first terminal**, the one still sitting at `root@<server>:~#`:

```bash
install -m 644 /tmp/homehub.service /etc/systemd/system/homehub.service
systemctl daemon-reload
systemctl enable homehub
```

Enable, but **do not start it yet** — there is no release for it to run.

### A6 · Log out and back in

```bash
exit        # leave the root shell
exit        # close the ssh session entirely
```

> **This matters.** Linux only applies group membership at login. Until you reconnect, your account
> is not really in the `homehub` group and Part C will fail with permission errors.

---

# Part B — Set the connection string (once)

```bash
# [dev] — opens the editor on the server over ssh
ssh <you>@<server> 'sudo nano /etc/homehub/homehub.env'
```

Replace the placeholder on the `ConnectionStrings__HomeHub` line:

```ini
ConnectionStrings__HomeHub=Server=localhost;Database=HomeHub;User Id=homehub_app;Password=REPLACE_ME;TrustServerCertificate=True
```

- **Same machine?** Use `Server=127.0.0.1,1433`. Prefer the literal address over `localhost`: on
  Linux that name can resolve to `::1` first, and SQL Server listens on IPv4 by default, so the
  client may stall on the IPv6 address before falling back — a confusing timeout that reads like the
  database being down. `127.0.0.1,1433` is unambiguous. There is no shared-memory or named-pipe
  shortcut on Linux; even a local connection is TCP.
- **Different machine?** Use its hostname or IP, and confirm that instance accepts TCP connections
  from the panel host.
- Keep `TrustServerCertificate=True` either way. SQL Server on Linux presents a self-signed
  certificate, and the client encrypts by default — this is needed for a local connection just as
  much as a remote one.
- Use a least-privilege login scoped to the `HomeHub` database.

Check whether SQL Server is on this host at all:

```bash
ss -lntp | grep 1433          # a listener here means it is local
systemctl is-active mssql-server
```

**Do this before Part C.** The app is offline-first: a wrong connection string does not stop it
starting, so the panel comes up looking fine while every data endpoint returns 500. Step C7 checks
for exactly this.

---

# Part C — Deploy a release

This is the routine you repeat for every update. About two minutes, and it runs in two halves:

| Steps | Where | What |
|---|---|---|
| C1 – C4 | **[dev]** — one terminal at the repo root | build, package, upload |
| C5 – C8 | **[server]** — ssh, after C4 | unpack, switch, restart, verify |

You cross from one to the other exactly once, in C5. Do C1–C4 in a single terminal so the `STAMP`
variable stays set throughout.

### Which shell for the [dev] steps

On Windows, **PowerShell** is assumed below — it is the default terminal, and everything C1–C4 needs
(`npm`, `dotnet`, `tar`, `scp`) works there. Only two commands differ from the Unix form, and both
are given.

> **Do not run the `.sh` scripts with `bash` from PowerShell.** On Windows `bash` resolves to
> `C:\Windows\System32\bash.exe`, which is **WSL** — a different machine with a different filesystem
> and its own `openssl`. Anything in `scripts/` expects **Git Bash** (from Git for Windows). That
> only matters in Part D; Part C touches no scripts.

The **[server]** steps are always Linux — plain bash, exactly as written.

Start on your dev machine, at the repo root, and set the release stamp — every command below uses it:

```powershell
# [dev] PowerShell — at the repo root
cd C:\CODE\HomeHub
$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"
$STAMP                        # e.g. 20260803-142233
```

<details><summary>Git Bash instead?</summary>

```bash
cd /c/CODE/HomeHub
STAMP=$(date +%Y%m%d-%H%M%S)
echo $STAMP
```
</details>

### C1 · Build the SPA — [dev]

```powershell
cd client
npm ci
npm run build
cd ..
```

Output goes to `src/HomeHub.Api/wwwroot`, which the API serves. Identical in Git Bash.

### C2 · Publish the API — [dev]

```powershell
if (Test-Path artifacts\publish) { Remove-Item -Recurse -Force artifacts\publish }
dotnet publish src/HomeHub.Api/HomeHub.Api.csproj -c Release -r linux-x64 --self-contained true -o artifacts/publish
```

Clear the folder first: `-o` merges into whatever is there, so a file that stopped being produced
would otherwise survive into every later release. The result (~126 MB) includes the SPA and its own
.NET runtime.

> `rm -rf artifacts/publish` does **not** work in PowerShell — `rm` is an alias for `Remove-Item`,
> which has no `-rf`, so it fails with *"A parameter cannot be found that matches parameter name
> 'rf'"*. Hence the `Remove-Item` form above.

<details><summary>Git Bash instead?</summary>

```bash
rm -rf artifacts/publish
dotnet publish src/HomeHub.Api/HomeHub.Api.csproj \
  -c Release -r linux-x64 --self-contained true \
  -o artifacts/publish
```
</details>

### C3 · Package it — [dev]

```powershell
tar -czf "artifacts/homehub-$STAMP.tar.gz" -C artifacts/publish .
```

`tar` ships with Windows (`C:\Windows\System32\tar.exe`), so this is the same command in both shells.

### C4 · Upload — [dev]

```powershell
scp "artifacts/homehub-$STAMP.tar.gz" <you>@<server>:/tmp/
$STAMP        # note this down — you need it on the server in a moment
```

### C5 · Unpack it — [server]

Connect. `STAMP` does not come with you — it is a different shell on a different machine — so rebuild
it **from the file you just uploaded** rather than retyping it:

```bash
ssh <you>@<server>                 # [dev] — from here you are on the server
```

```bash
# [server] — see what actually arrived
ls -1 /tmp/homehub-*.tar.gz
```

That should list the archive from C4. Now take the stamp straight off it — no typing, nothing to get
wrong:

```bash
# [server]
STAMP=$(ls -1 /tmp/homehub-*.tar.gz | sort -r | head -1 | sed 's#.*/homehub-##; s#\.tar\.gz$##')
echo $STAMP                        # must match the value C4 printed
```

> **If `ls` lists nothing**, the upload in C4 did not happen — go back and re-run it. Do not invent a
> stamp: every command below is built from this one, and a wrong value fails with
> `tar: Cannot open: No such file or directory`, naming a file that was never there.

```bash
mkdir -p /opt/homehub/releases/$STAMP
tar -xzf /tmp/homehub-$STAMP.tar.gz -C /opt/homehub/releases/$STAMP
rm -f /tmp/homehub-$STAMP.tar.gz
```

**Make the app executable and group-readable.** Do not skip this — `tar` built on Windows carries no
executable bit, so without the first line systemd fails with a bare `203/EXEC`:

```bash
chmod +x /opt/homehub/releases/$STAMP/HomeHub.Api
chgrp -R homehub /opt/homehub/releases/$STAMP
chmod -R g+rX /opt/homehub/releases/$STAMP
```

The `chgrp` is belt-and-braces: setgid in A3 should already have handled it, but on a server set up
before that step existed the release would land in your own group and the service could not read it.
Confirm the service can actually run what you just unpacked:

```bash
sudo -u homehub test -x /opt/homehub/releases/$STAMP/HomeHub.Api && echo "service can run it" || echo "SERVICE CANNOT READ IT"
```

### C6 · Switch to it and restart — [server]

Point `current` at the new release. Two steps, because `ln -sfn` onto an existing symlink-to-a-
directory creates a link *inside* the old target instead of replacing it:

```bash
ln -sfn /opt/homehub/releases/$STAMP /opt/homehub/current.tmp
mv -Tf /opt/homehub/current.tmp /opt/homehub/current
readlink /opt/homehub/current        # confirm it points at $STAMP
```

```bash
sudo systemctl restart homehub       # asks for your password
```

### C7 · Verify — [server]

```bash
curl -s "http://127.0.0.1:5080/api/health?deep=true"
```

You want:

```json
{"status":"ok","service":"HomeHub.Api","version":"1.0.0.0","database":"ok","pendingMigrations":0}
```

**Check `database` and `pendingMigrations` before walking away.** `status` alone only means the
process is up — the app serves its shell happily with no database at all. Anything other than
`"database":"ok"` and `"pendingMigrations":0` is in [Troubleshooting](#troubleshooting).

If it does not answer at all:

```bash
systemctl is-active homehub
journalctl -u homehub -n 40 --no-pager
```

Then open `http://<server>:5080/` in a browser — or your HTTP port, if you changed it. The panel UI
should load; that is the first end-to-end proof that the SPA and the API are both being served.

### C8 · Tidy up old releases — [server], occasionally

Each release is ~126 MB. Keep a few for rollback and delete the rest:

```bash
ls -1 /opt/homehub/releases | sort            # oldest first
readlink /opt/homehub/current                 # never delete this one
rm -rf /opt/homehub/releases/<old-stamp>
```

---

# Part D — HTTPS for the panel

Part of the build, not an extra. Do it once, immediately after your first deploy.

**Why it is required.** Barcode scanning is a phone job — nobody carries the shopping to the wall
panel — and browsers expose `navigator.mediaDevices.getUserMedia` **only in a secure context**:
HTTPS, or `localhost`. A phone at `http://192.168.5.15:5080` is neither, so the camera is not blocked
but *absent* (`navigator.mediaDevices` is `undefined`) and the scan screen falls back to
`NEEDS HTTPS FOR THE CAMERA`. No amount of clicking through warnings fixes that: it is per-origin, it
resets, and on iOS it does not reliably grant a secure context at all. HTTPS is the feature.

**What you are building.** A small certificate authority that lives in your `certs/` folder, trusted
once per household device, signing a certificate for the panel. Not a public CA, not Let's Encrypt —
those need a public domain and this machine has a LAN address.

**Seven steps.** D1–D3 on your dev machine, D4–D5 on the server, D6–D7 on each phone.

> **All `[dev]` steps here run in Git Bash, not PowerShell.** In PowerShell `bash` resolves to
> `C:\Windows\System32\bash.exe`, which is **WSL** — a separate Linux environment with its own
> filesystem and `openssl`. The scripts would fail to find `certs/`, or write into a folder you
> cannot then `scp` from. Right-click the repo folder → *Git Bash Here*. From PowerShell you can also
> call it explicitly: `& "C:\Program Files\Git\bin\bash.exe" scripts/make-panel-cert.sh …`

### D1 · Create the household CA — [dev, Git Bash]

Skip if `certs/homehub-dev-ca.crt` already exists — **do not create a second CA**, or every device
already trusting the first has to be set up again.

```bash
cd /c/CODE/HomeHub
ls certs/homehub-dev-ca.crt 2>/dev/null || bash scripts/make-dev-certs.sh
```

It writes three files into `certs/` (gitignored, and rightly so — the CA key can mint a certificate
for any hostname your household devices will trust):

| File | What it is |
|---|---|
| `homehub-dev-ca.crt` | The CA certificate. **This is the one that goes on phones** (D6). Public. |
| `homehub-dev-ca.key` | The CA private key. Never leaves this folder, never goes on the server. |
| `homehub-dev.crt` / `.key` | A certificate for your dev machine — unrelated to the panel, harmless. |

### D2 · Issue the panel's certificate — [dev, Git Bash]

```bash
bash scripts/make-panel-cert.sh 192.168.5.15 homehub.local
```

**List every name and IP a phone might use to reach the panel.** A name outside the certificate's
SAN list produces a mismatch warning, and on iOS a mismatch means no camera. Include:

- the server's **LAN IP** (`192.168.5.15`) — what most devices will actually use;
- its **hostname** and the `.local` mDNS form, if your network resolves them;
- any alias you have put in a router's DNS or a hosts file.

The script adds `localhost` and `127.0.0.1` itself, and appends `.local` to any bare hostname. It
signs with the CA from D1 and **refuses to run if that CA is missing** — deliberately, because
silently minting a second CA would invalidate every device already trusting the first.

Confirm what you got:

```bash
openssl x509 -in certs/homehub-panel.crt -noout -ext subjectAltName -enddate
```

Every address a phone will type must appear in that SAN list.

### D3 · Upload the pair — [dev]

`/etc/homehub/certs/` was created in A3 and is owned by your deploy account, so no `sudo` is needed:

```bash
scp certs/homehub-panel.crt certs/homehub-panel.key <you>@<server>:/etc/homehub/certs/
```

> **Do not run that command without the destination.** `scp a b` with no remote target is a *local
> copy* — it overwrites `homehub-panel.key` with the certificate. You end up with two files that both
> look right in `ls -l` and a key that is not a key, and the panel then crash-loops with
> `CryptographicException: … the key does not match the certificate`. If that happens, re-run D2 to
> regenerate the pair; the overwritten key is not recoverable.

The **CA key stays on your machine.** Only the panel's own certificate and key go to the server.

### D4 · Permissions and restart — [server]

```bash
chgrp homehub /etc/homehub/certs/homehub-panel.crt /etc/homehub/certs/homehub-panel.key
chmod 644 /etc/homehub/certs/homehub-panel.crt
chmod 640 /etc/homehub/certs/homehub-panel.key
ls -l /etc/homehub/certs/
sudo systemctl restart homehub
```

**The `chgrp` is the important line.** `scp` creates files with *your* primary group, not the
directory's — so the pair arrives as `you:you`, and a `640` key is then unreadable by the `homehub`
service account even though `ls -l` looks perfectly reasonable. No `sudo` needed: you own the files
and belong to the group.

`ls -l` should show both files as `you homehub`:

```
-rw-r--r-- 1 simpson homehub 1298 ... homehub-panel.crt
-rw-r----- 1 simpson homehub 1704 ... homehub-panel.key
```

If the second column says anything other than `homehub`, the service cannot read the key. Confirm it
directly:

```bash
sudo -u homehub test -r /etc/homehub/certs/homehub-panel.key && echo "service can read the key" || echo "SERVICE CANNOT READ THE KEY"
```

Nothing needs configuring: `Server__CertPath` and `Server__KeyPath` were already set in A4, and
Kestrel binds HTTPS **by presence** — the moment those files exist, port 5081 comes up on restart.

### D5 · Verify on the server — [server]

```bash
curl -sk https://127.0.0.1:5081/api/health
```

`{"status":"ok",…}` means TLS is live. `-k` skips verification because the server does not trust its
own household CA — that is expected and not what you are testing here.

Check both ports are listening:

```bash
sudo ss -lntp | grep -i homehub
```

Two lines, one per port. This is also the definitive answer to "which ports is it actually on" if you
changed them.

If 5081 is missing, work down this list — the journal names the cause:

```bash
journalctl -u homehub -n 30 --no-pager | grep -i "https disabled\|certificate"
```

| What you find | Cause | Fix |
|---|---|---|
| `HTTPS disabled: could not load the certificate …` | The service cannot read the key — almost always the group left by `scp` | Redo the `chgrp` in D4, restart |
| No such message, and 5081 absent | The files are not where `Server__CertPath` points | `ls -l /etc/homehub/certs/`; compare with `grep Server__ /etc/homehub/homehub.env` |
| Service not running at all | Something else failed at startup | `journalctl -u homehub -n 40 --no-pager` |

A certificate problem **never takes the panel offline** — the app logs the reason and carries on
serving HTTP. So the HTTP port answering while the HTTPS one does not is exactly the symptom of an unreadable key,
not of a dead service.

### D6 · Trust the CA on each phone or tablet — [phone]

The panel is now serving HTTPS, but no device trusts the signer yet. **Each household device needs
`homehub-dev-ca.crt` installed once.** It is trusted for every certificate this CA ever signs, so
renewals (D2–D4) need no repeat.

**The panel serves its own CA certificate.** On the phone, browse to — using your HTTP port:

```
http://192.168.5.15:5080/homehub-dev-ca.crt
```

and download it. Plain HTTP on purpose: the phone does not trust the HTTPS side yet — that is the
whole errand.

> Safe to serve, deliberately. A CA *certificate* is public by design — it is the CA *key* that can
> mint trust, and that never leaves `certs/` on your dev machine. The file rides along because
> `make-dev-certs.sh` drops a copy into `client/public/`, which the SPA build ships; it is
> gitignored, so each household serves its own CA and nobody commits theirs.

<details><summary>404? The running release predates the CA. Two ways out.</summary>

Either deploy a fresh release (Part C — the build now includes the file), or serve it by hand for
a minute without touching the release:

```bash
scp certs/homehub-dev-ca.crt <you>@<server>:/tmp/     # [dev] — at the repo root
```

```bash
cd /tmp                                                # [server]
sudo ss -lntp | grep ':8099' || python3 -m http.server 8099
```

(If that prints a listener instead of starting, the port is taken — pick another; 8123 is Home
Assistant.) Browse to `http://192.168.5.15:8099/homehub-dev-ca.crt`, download, then **Ctrl-C**.

</details>

**Android**
1. Settings → search "CA certificate" — on recent Pixels: Security & privacy → More security &
   privacy → Encryption & credentials → Install a certificate.
2. Choose **CA certificate**, accept the "your data won't be private" warning, pick the file.
3. It appears under "User credentials". Chrome uses it immediately, no restart.

**iOS / iPadOS** — two steps, and the second is the one everybody misses:
1. Open the `.crt`; iOS offers to download a *profile*. Then Settings → General → VPN & Device
   Management → install it.
2. **Settings → General → About → Certificate Trust Settings → enable full trust for
   "HomeHub Dev CA".** Without this the certificate is installed but not trusted, and Safari refuses
   the origin with no useful message.

**Windows / macOS desktop** — only needed if you want a warning-free browser there:

```powershell
Import-Certificate -FilePath .\certs\homehub-dev-ca.crt -CertStoreLocation Cert:\CurrentUser\Root
```

### D7 · Verify from a phone — [phone]

This is the step that proves the point. On a trusted phone, browse to the panel over **HTTPS**, using
**your** HTTPS port — `sudo ss -lntp | grep -i homehub` on the server if you are not sure:

```
https://<server>:<your-https-port>/

# e.g. https://192.168.5.15:5081/
#      https://192.168.5.15:5081/   if you moved off a taken port
```

> `ERR_CONNECTION_REFUSED` here almost always means the wrong port — nothing is listening where you
> knocked. A firewall gives a *timeout* instead, not a refusal.

- **No certificate warning** — if you get one, the name you typed is not in the SAN list (redo D2
  including it) or the CA is not trusted yet (redo D6; on iOS check step 2).
- Go to the pantry scan screen. It should ask for camera permission and show a live preview, not
  `NEEDS HTTPS FOR THE CAMERA`.

### What stays on HTTP

Port 5080 (HTTP) remains bound, on purpose:

- **The Pi kiosk** points at `http://<server>:5080` ([`pi-kiosk.md`](pi-kiosk.md)). The wall panel has
  no camera and needs no secure context, so leaving it on HTTP saves trusting the CA on the Pi. Move
  it to `https://…:5081` only if you want to, and trust the CA in the Pi's Chromium first.
- **Health checks** (`curl http://127.0.0.1:5080/api/health`) — step C7 uses this.

### Renewal

The certificate is valid for **397 days** — Apple rejects anything longer, and a certificate that
works everywhere except the iPhones is the worst outcome available. Check the expiry any time:

```bash
openssl x509 -in certs/homehub-panel.crt -noout -enddate
```

To renew, repeat **D2 → D3 → D4**. The CA is reused, so **no device needs touching again**. Re-run
D2 as well whenever the server's IP changes or you add a name devices will use.

---

# Part E — Roll back

The previous release is still on disk, so rolling back is switching the symlink the other way —
**[server]**:

```bash
ls -1 /opt/homehub/releases | sort     # find the one before the current
readlink /opt/homehub/current          # what you are on now

ln -sfn /opt/homehub/releases/<previous-stamp> /opt/homehub/current.tmp
mv -Tf /opt/homehub/current.tmp /opt/homehub/current
sudo systemctl restart homehub
curl -s "http://127.0.0.1:5080/api/health?deep=true"
```

No rebuild, no upload.

---

# Part F — The AI lineup (optional)

The assistant's local model, the cloud tier, speech-to-text and the house voice are installed in
their own guide: **[`ai-stack.md`](ai-stack.md)**. It is kept separate because the four pieces are
one lineup that gets set up together, and because none of them is needed to have a running panel.

Skip it entirely and the panel still works: with nothing configured the assistant falls back to a
built-in simulated provider, and the actions-first layer — timers, lists, climate — runs *before*
any model regardless, so the things people actually ask for keep working either way.

Do it, any time after Part C, and Barnaby answers from a real model and speaks in the house voice.

**The models run on this server, not the Pi.** The Pi stays thin glass.

---

## Everyday commands — [server]

| Command | What it does |
|---|---|
| `systemctl is-active homehub` | Is it running? |
| `systemctl status homehub` | Status and recent output |
| `journalctl -u homehub -n 100 -f` | Tail the log (no sudo needed) |
| `sudo systemctl restart homehub` | Restart, e.g. after editing settings |
| `readlink /opt/homehub/current` | Which release is live |
| `ls -1 /opt/homehub/releases` | What is available to roll back to |

After editing `/etc/homehub/homehub.env`, restart for it to take effect.

---

## Troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| `tar … Cannot open: No such file or directory` | `STAMP` is wrong, or C4's upload never ran | `ls -1 /tmp/homehub-*.tar.gz` and re-derive it (C5). If nothing is listed, redo C4 |
| `'STAMP=…' is not recognized as a name of a cmdlet` | Unix syntax typed into PowerShell | Use `$STAMP = Get-Date -Format "yyyyMMdd-HHmmss"` (Part C) |
| `A parameter cannot be found that matches parameter name 'rf'` | `rm -rf` in PowerShell | Use `Remove-Item -Recurse -Force` (C2) |
| A `.sh` script cannot find `certs/` or writes it somewhere odd | `bash` in PowerShell is WSL | Run it from Git Bash (Part D) |
| `Permission denied` unpacking into `/opt/homehub` | Group membership not applied | Log out and back in (step A6) |
| `203/EXEC` in the journal | Executable bit missing | `chmod +x /opt/homehub/releases/$STAMP/HomeHub.Api` (C5) |
| `Globalization Invariant Mode is not supported` | `libicu-dev` missing | Step A1 |
| `"database":"not-configured"` | No connection string | Part B |
| `"database":"unreachable"` | Wrong credentials, or SQL Server unreachable **from the server** | Recheck Part B; confirm that instance accepts TCP from this host |
| `"pendingMigrations":` non-zero | A startup migration failed and was swallowed | `journalctl -u homehub -n 40 --no-pager` |
| Service keeps restarting | App crashing at startup | `journalctl -u homehub -n 40 --no-pager` |
| `Failed to start` / `no such file` | `current` points nowhere valid | `readlink /opt/homehub/current`, redo C6 |
| `https://…:5081` returns nothing, but `:5080` works | Service cannot read the key — `scp` left it in your group, not `homehub` | `chgrp homehub /etc/homehub/certs/homehub-panel.*` then restart (D4) |
| `CryptographicException: … the key does not match the certificate`, service crash-looping | The `.key` file is not a key — usually an `scp` run without its destination, which copies the cert over it | Re-run D2 (it now verifies the pair), then D3 **with** the destination |
| `IOException: Failed to bind to address http://[::]:<port>: address already in use` | Another service already owns the port — **and the address in the message is the port the app actually tried**, which is 5000 when `Server__HttpPort` is absent from the env file, not the port you meant | `sudo ss -lntp \| grep ':<port>'` to name the squatter, then confirm `grep Server__Http /etc/homehub/homehub.env` says 5080/5081 and matches `deploy/deploy.env`. This does not degrade: it crash-loops, because each restart races the dying process for the socket |
| Phone shows "no camera" | No certificate, or its name is not in the cert | Part D, listing every name/IP |
| Cat and Baby sections say "not connected"; climate has no zones — but all three work in dev | `HomeAssistant__BaseUrl` / `__Token` are not in the env file. In dev they come from user-secrets, which stay on that machine | Add both to `/etc/homehub/homehub.env` (A4) and restart |

**Are the real integrations actually live?** `status: ok` says nothing about them — each one falls
back silently by design. Ask them directly:

```bash
curl -s http://127.0.0.1:5080/api/cats/health    # "configured":true, "status":"Ok"
curl -s http://127.0.0.1:5080/api/baby/health    # same shape
curl -s http://127.0.0.1:5080/api/climate/zones  # a real HA setup lists zones, not []
```

`"configured":false` means the Home Assistant keys are missing from the env file; a `configured`
`true` with a failing `status` means the token or URL is wrong, or HA is not answering — and the
`detail` field says which.

---

# Reference

Background. Not needed to deploy.

## Why releases and a symlink

The switch is one atomic operation, the previous release stays on disk, and rollback is the same
switch backwards. Nothing is replaced until the new files are fully unpacked, so a failed upload
leaves the running service untouched.

## Why self-contained

The release carries its own .NET runtime, so there is nothing to install on the server and no
runtime version to keep matched against the SDK that built it. The cost is ~126 MB per release.

## The systemd unit

`Type=exec`, not `notify`. `notify` requires the app to call `sd_notify` (via `Host.UseSystemd()`),
which it does not — systemd would wait for a readiness message that never arrives and fail the start
as a timeout, while Kestrel served happily.

Hardened with `ProtectSystem=strict`, so `/opt` is read-only to the service and `/var/lib/homehub` is
the only writable path. **A new runtime cache must be added to `ReadWritePaths`** or it fails with a
permission error at first write.

## No passwordless sudo

Nothing in this guide installs a sudoers rule. A deploy needs root once — `systemctl restart` — and
that asks for your password.

Worth knowing if you are ever tempted to add a convenience rule: `systemctl status` and `journalctl`
page through `less`, and `less` spawns a shell on `!sh`, as whoever it runs as. A passwordless rule
for reading logs is a root shell on demand. Neither needs privilege anyway — querying unit state is
unprivileged, and the journal comes from the `systemd-journal` group in step A2.

## Ports and TLS

Kestrel binds by presence: HTTP on `Server__HttpPort` (5080) is always bound; HTTPS on
`Server__HttpsPort` (5081) is added only when `Server__CertPath` / `Server__KeyPath` point at real
files. A release with no certificate still serves.

Those two settings are the only place ports are declared — deliberately no `ASPNETCORE_URLS`.
Setting both made Kestrel log `Overriding address(es) …` on every start.

## Database and migrations

The app is offline-first, so **a database problem never stops it booting**: the shell serves, data
endpoints 500, and a migration failure at startup is logged but non-fatal. That is why step C7 checks
the database explicitly rather than trusting `status`:

```jsonc
{"status":"ok","service":"HomeHub.Api","version":"1.0.0.0","database":"ok","pendingMigrations":0}
// database: "ok" | "unreachable" | "not-configured"
```

`status` stays pure liveness — the kiosk boot check depends on that. `pendingMigrations` is computed
only for `?deep=true`; a non-zero count means a startup migration was swallowed and the schema is
behind the code.

Migrations apply on startup by default. To apply them by hand instead, set
`RunMigrationsOnStartup=false` and run from a dev machine:

```bash
ConnectionStrings__HomeHub='...' dotnet ef database update    # from src/HomeHub.Api
```

## Optional: nginx in front

Only worth it for a clean URL or a certificate from a real CA. Proxy `/` → `http://127.0.0.1:5080`
with `proxy_http_version 1.1` and the `Upgrade`/`Connection` headers set. The panel certificate in
Part D already gives phones a secure context, which was the only thing actually blocking a feature.

Two settings matter for Assist, because a streamed turn is a long-lived response rather than a
request/response pair:

```nginx
location /api/assist/chat/stream {
    proxy_pass http://127.0.0.1:5080;
    proxy_http_version 1.1;
    proxy_buffering off;      # or the whole reply arrives in one lump when it is over
    proxy_read_timeout 15m;   # a turn's ceiling; nginx defaults to 60s
}
```

HomeHub already sends `X-Accel-Buffering: no`, which nginx honours, so `proxy_buffering off` is
belt and braces. The read timeout is the one that bites: an agent thinking for four minutes writes
nothing in the meantime. HomeHub sends a keepalive comment every 15 seconds precisely so a default
proxy does not reap it, but a timeout shorter than a turn's own ceiling is still a second deadline
in a second place, and the one that fires first is the one nobody remembers setting.

## The scripts

`scripts/deploy.sh` and `deploy/bootstrap-server.sh` remain in the repo and automate exactly the
steps above — Part A is `--bootstrap`, Part C is the default, Part D is `--certs`, Part E is
`--rollback`. Nothing in this guide depends on them; they are there if you ever want the one-command
version back.
