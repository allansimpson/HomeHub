#!/usr/bin/env bash
#
# One-time setup of a fresh Ubuntu server to host the panel. Run once; after this every update is
# `bash scripts/deploy.sh` from the dev machine.
#
# WHAT IT DOES NOT DO
# -------------------
# It does not install a .NET runtime, because it does not need one: `deploy.sh` publishes
# self-contained, so a release carries its own runtime. That is the deliberate trade — ~100 MB per
# release in exchange for never matching a server runtime version against the SDK that built it,
# and for this script working on any Ubuntu without Microsoft's package repository.
#
# It does not install or configure SQL Server. The app boots without a database (the shell serves
# and shows a reconnecting state), so the panel comes up either way; add the connection string to
# /etc/homehub/homehub.env when a database exists.
#
# USAGE (from the dev machine — uploads this script and the unit, then runs it)
#   bash scripts/deploy.sh --bootstrap
#
# USAGE (on the server, if you would rather do it by hand)
#   sudo bash bootstrap-server.sh [deploy-user]
#
# `deploy-user` is the account deploy.sh logs in as; it defaults to whoever invoked sudo. It gets
# write access to /opt/homehub and permission to restart the service, and nothing else.

set -euo pipefail

SERVICE_USER=homehub
DEPLOY_USER="${1:-${SUDO_USER:-}}"
ROOT=/opt/homehub
STATE=/var/lib/homehub
CONF=/etc/homehub
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash bootstrap-server.sh" >&2
  exit 1
fi

if [ -z "$DEPLOY_USER" ]; then
  echo "Cannot tell which account will deploy. Pass it: sudo bash bootstrap-server.sh <user>" >&2
  exit 64
fi

if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "No such user: $DEPLOY_USER" >&2
  exit 64
fi

if [ ! -f "$HERE/homehub.service" ]; then
  echo "homehub.service not found next to this script (looked in $HERE)." >&2
  exit 1
fi

echo "==> Deploy user : $DEPLOY_USER"
echo "==> Service user: $SERVICE_USER"
echo

# --- Packages ---------------------------------------------------------------
# libicu even though the publish is self-contained: the app runs with globalization ON
# (InvariantGlobalization=false in Directory.Build.props) because Microsoft.Data.SqlClient needs it,
# and without libicu the process dies on the first DB connect with "Globalization Invariant Mode is
# not supported". curl is used by the deploy health check.
echo "==> Installing packages (libicu, curl)"
export DEBIAN_FRONTEND=noninteractive

# `|| true` because this script runs under `set -e` and a home server usually carries third-party
# apt sources that have nothing to do with the panel — a Home Assistant addon repo, a PPA, anything
# whose host stops resolving. One of those failing makes `apt-get update` noisy and, depending on
# the apt version, non-zero, which would abort the bootstrap before it created a single directory
# and blame apt for it.
#
# Nothing is being papered over: the install below is the step that must succeed, and it fails
# loudly if the two packages genuinely cannot be found.
apt-get update -qq || echo "    (some apt sources failed — continuing; only libicu and curl matter)" >&2
apt-get install -y -qq libicu-dev curl >/dev/null

# --- Service account --------------------------------------------------------
# A system account with no login shell and no home: it exists to own a process, and nothing about
# serving a wall panel requires the ability to log in as it.
if id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "==> Service user $SERVICE_USER already exists"
else
  echo "==> Creating service user $SERVICE_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
fi

# The deploy user writes releases; the service user reads them. Group membership is what bridges
# the two without giving either more than it needs.
usermod -a -G "$SERVICE_USER" "$DEPLOY_USER"

# systemd-journal so the deploy script can read this service's log without sudo. When a deploy's
# health check fails, the journal is the only thing that says why — and printing "permission denied"
# at exactly that moment is the least useful behaviour available.
usermod -a -G systemd-journal "$DEPLOY_USER"

# --- Directories ------------------------------------------------------------
echo "==> Creating $ROOT, $STATE, $CONF"
mkdir -p "$ROOT/releases" "$STATE/recipe-images" "$STATE/event-photos" "$STATE/voice-cache" "$STATE/keys" "$CONF/certs"

# Releases are written by the deploy user over ssh and read by the service — hence the shared group
# and 750 (nothing here is world-readable; wwwroot is served by the app, not by the filesystem).
chown -R "$DEPLOY_USER:$SERVICE_USER" "$ROOT"
chmod -R 750 "$ROOT"

# setgid, and this is load-bearing rather than tidiness.
#
# The chown above fixes ownership *now*. Everything created afterwards — `mkdir releases/<stamp>`,
# `tar -x` unpacking a release, `scp` dropping a certificate — is created with the deploy account's
# *primary* group (its own user-private group), not this directory's. A later `chmod -R g+rX` then
# grants read to a group the service account is not in, and the result is the worst kind of failure:
# `ls -l` looks entirely reasonable, the files are plainly there, and the service cannot read the
# application it is supposed to run or the key it is supposed to serve.
#
# setgid makes new entries inherit the directory's group instead, so the arrangement holds for every
# future deploy without anyone having to remember it.
chmod g+s "$ROOT" "$ROOT/releases"

# Runtime state is written by the service only.
chown -R "$SERVICE_USER:$SERVICE_USER" "$STATE"
chmod -R 750 "$STATE"
# The Data Protection key ring encrypts the stored Google/Microsoft refresh tokens (AUDIT A2).
# Nothing but the service account has any business reading it, so it is 700 rather than 750 —
# the group read the rest of the state directory grants is for humans inspecting a cache, and
# this is not a cache.
chmod 700 "$STATE/keys"

# --- Secrets ----------------------------------------------------------------
# Created only if absent — re-running this script must never clobber a filled-in connection string.
if [ -f "$CONF/homehub.env" ]; then
  echo "==> $CONF/homehub.env exists, leaving it alone"
else
  echo "==> Writing $CONF/homehub.env (template — fill in the connection string)"
  cat > "$CONF/homehub.env" <<'EOF'
ASPNETCORE_ENVIRONMENT=Production

# Ports. Program.cs is the only thing that binds, so these are the only place they are declared —
# deliberately no ASPNETCORE_URLS. Setting it as well made Kestrel log "Overriding address(es)" on
# every start: the two never disagreed, there were simply two of them. HTTP is always bound; HTTPS
# is added only when the certificate below is present.
# Must match HTTP_PORT/HTTPS_PORT in deploy/deploy.env — see deploy/server-systemd.md.
# Not 5000/5001: 5000 is a crowded default, and a busy port crash-loops rather than degrades.
Server__HttpPort=5080
Server__HttpsPort=5081

# HTTPS for the panel. Uploaded by `scripts/deploy.sh --certs`, signed by the household CA that the
# phones already trust. Without these the panel still serves over HTTP — but phones get no camera,
# so barcode scanning does not work.
Server__CertPath=/etc/homehub/certs/homehub-panel.crt
Server__KeyPath=/etc/homehub/certs/homehub-panel.key

# Runtime state, kept outside the release directory so it survives every deploy (releases are
# replaced wholesale, and the unit mounts /opt read-only).
Meals__ImagePath=/var/lib/homehub/recipe-images
Voice__Tts__CacheDirectory=/var/lib/homehub/voice-cache

# The photographs engagements were read off. REQUIRED in production, for the same reason as the
# line above it and with a worse failure mode: unset, EventPhotoStore falls back to
# `event-photos/` under the release directory, which ProtectSystem=strict mounts read-only. The
# write fails, the store treats that as "not kept" — an ordinary outcome it shares with an
# unrenderable format — and the engagement still lands. So nothing is broken on screen: the
# household has "Keep photos read into events" switched on, every flyer is read correctly, and
# every event detail says "read from a photo · not kept" for ever.
EventCapture__PhotoPath=/var/lib/homehub/event-photos

# Keys that encrypt stored OAuth refresh tokens (AUDIT A2). Must be here rather than the ASP.NET
# default: the unit sets ProtectHome=true, so $HOME/.aspnet/DataProtection-Keys is unwritable and
# Data Protection silently degrades to in-memory keys — which works until the first restart, then
# every linked Google/Microsoft account stops refreshing. Back this directory up with the database;
# losing it means every household member re-links their account.
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

# The database. REQUIRED for anything beyond the shell — without it the panel still serves, but
# every data endpoint 500s, so fill this in before the first deploy.
#
# Use a least-privilege login scoped to the HomeHub database — the app owns and migrates only its own.
#
# TLS, and why the line below is written the way it is
# ----------------------------------------------------
# This template used to emit `TrustServerCertificate=True` next to a `Server=` you are invited to
# point at another machine. Those two together mean the app accepts whatever certificate answers on
# 1433 without checking whose it is — so anything that can take up a position between this host and
# the database gets the login above and every row that follows it. That is a real hole on a house LAN,
# and it was shipped as a default because it is also what makes a *local* SQL Server work.
#
# So the two cases are separated, and the app enforces the separation at startup
# (`SqlConnectionPolicy`): a deployment will not boot with certificate validation disabled against
# anything but loopback.
#
#   SQL Server on this same box (the default below). The connection never leaves the machine, there is
#   no network position to take up, and the certificate would be one SQL Server signed for itself.
#   `TrustServerCertificate=True` is accepted here and only here.
#
#   SQL Server on another host. Install a certificate that host presents whose subject or SAN matches
#   the name you put in `Server=`, make sure this machine's trust store contains the issuing CA, and
#   drop `TrustServerCertificate` entirely:
#
#     ConnectionStrings__HomeHub=Server=sql.house.lan;Database=HomeHub;User Id=homehub_app;Password=REPLACE_ME;Encrypt=True
#
#   The `Server=` value must be the name on the certificate, not an IP address that happens to reach
#   it — validation compares the two, and an IP will not match a hostname SAN.
#
# `Encrypt=True` is stated rather than left to the driver default, so the intent survives a driver
# upgrade that changes it.
ConnectionStrings__HomeHub=Server=localhost;Database=HomeHub;User Id=homehub_app;Password=REPLACE_ME;Encrypt=True;TrustServerCertificate=True

# The schema is applied at startup, and a failure there is logged but deliberately non-fatal so the
# shell still loads. `deploy.sh` reports pending migrations for that reason. Set false to apply them
# by hand instead.
#RunMigrationsOnStartup=false

# Real-service credentials go here too, in the same __ form (see README's configuration reference).
EOF
fi

# Root-owned, group-readable by the service. The deploy user is in that group, so treat anything
# written here as visible to it.
chown root:"$SERVICE_USER" "$CONF/homehub.env"
chmod 640 "$CONF/homehub.env"

# The certificate directory: the deploy user writes the pair, the service reads it. setgid for the
# same reason as /opt/homehub above — scp creates files in the uploader's own group, which would
# leave the service unable to read a key that looks perfectly correct in `ls -l`.
chown -R "$DEPLOY_USER:$SERVICE_USER" "$CONF/certs"
chmod 2750 "$CONF/certs"

# --- systemd unit -----------------------------------------------------------
echo "==> Installing systemd unit"
install -m 644 "$HERE/homehub.service" /etc/systemd/system/homehub.service

# --- No passwordless sudo, by choice ---------------------------------------
#
# `deploy.sh` needs root for exactly one thing: `systemctl restart homehub`. That could be granted
# without a password via a sudoers drop-in, and this script used to do it. It does not any more —
# restarting the household's panel is a deliberate act, and typing a password once per deploy is a
# small price for there being no standing root grant on this account at all.
#
# The removal below matters as much as not creating it: a server bootstrapped by an earlier version
# of this script still has the drop-in, and re-running bootstrap is how that gets cleaned up.
if [ -f /etc/sudoers.d/homehub-deploy ]; then
  echo "==> Removing the old passwordless-sudo drop-in (deploys now prompt)"
  rm -f /etc/sudoers.d/homehub-deploy
fi

# Reading the journal still needs no sudo — that comes from the systemd-journal group above, which
# is why `deploy.sh --logs` never prompts.

systemctl daemon-reload

# Enabled but not started: there is no release yet. The first `deploy.sh` starts it.
systemctl enable homehub >/dev/null 2>&1 || true

echo
echo "Bootstrap complete."
echo
echo "  Releases : $ROOT/releases   (current -> the live one)"
echo "  State    : $STATE           (survives deploys)"
echo "  Secrets  : $CONF/homehub.env"
echo
echo "$DEPLOY_USER was added to the $SERVICE_USER group — that takes effect on the next login,"
echo "so if this was run over an existing ssh session, reconnect before deploying."
echo
echo "Next, from the dev machine:  bash scripts/deploy.sh"
