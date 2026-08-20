#!/usr/bin/env bash
#
# Deploy the panel (SPA + API) to the Ubuntu server, from this machine, in one command.
#
# HOW IT WORKS
# ------------
# The build happens here, not on the server: `npm run build` puts the SPA in the API's wwwroot, then
# `dotnet publish` produces one self-contained folder containing both. That folder is tarred,
# uploaded, unpacked into a timestamped directory under /opt/homehub/releases, and the `current`
# symlink is flipped to it before the service restarts.
#
# Why releases + a symlink rather than overwriting in place: the switch is one atomic operation, the
# previous release is still on disk, and rollback is the same flip backwards (`--rollback`) instead
# of a rebuild of whatever the last good commit was. It also means a failed deploy leaves the
# running service untouched — nothing is replaced until the new files are already on disk.
#
# Self-contained publish means the server needs no .NET installed and no runtime version to match.
#
# USAGE
#   bash scripts/deploy.sh              # build, upload, flip, restart, verify
#   bash scripts/deploy.sh --bootstrap  # one-time: prepare a fresh server (asks for sudo)
#   bash scripts/deploy.sh --certs      # upload the panel HTTPS cert pair, then restart
#   bash scripts/deploy.sh --rollback   # flip back to the previous release
#   bash scripts/deploy.sh --releases   # list what is on the server
#   bash scripts/deploy.sh --logs       # tail the service log
#
# Configure it once by copying deploy/deploy.env.example to deploy/deploy.env.
#
# ANOTHER INSTANCE (the TEST environment)
#   DEPLOY_ENV=deploy/deploy-test.env bash scripts/deploy.sh
#
# Every sub-command above honours it, so `--releases`, `--rollback` and `--logs` all follow the same
# file to the same instance. **Which instance a deploy hits is decided entirely by that file** —
# `REMOTE_ROOT`, `SERVICE`, `SERVICE_GROUP` and the ports. Inline overrides are not a substitute:
# the file is sourced with `set -a`, so anything it names wins over what was in the environment, and
# `HTTP_PORT` in particular is named — a deploy carrying production's port would run its readiness
# probe against production and report *that* healthy while the release it just flipped went unchecked.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --help before anything else: asking what the script does must not require having configured it.
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  # Through the ANOTHER INSTANCE note, which is the one thing somebody deploying to test has to
  # know and the one thing they cannot discover by trying it — a bare run goes to production.
  sed -n '3,37p' "$0" | sed 's/^#\{1,\} \{0,1\}//'
  exit 0
fi

# --- Preflight: right bash, right tools -------------------------------------
# The classic failure is `bash scripts/deploy.sh` typed into PowerShell: `bash` there is WSL — a
# separate Linux with its own filesystem and (usually) no npm or dotnet — and the script dies
# mid-build with a bare "npm: command not found". Catch it at the door, by name.
case "$(uname -r)" in
  *[Mm]icrosoft*)
    echo "This is WSL, not Git Bash — npm/dotnet live on the Windows side." >&2
    echo "Run from a Git Bash window, or from PowerShell:" >&2
    echo '  & "C:\Program Files\Git\bin\bash.exe" scripts/deploy.sh' >&2
    exit 1;;
esac
for tool in npm dotnet tar scp ssh; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Required tool not found: $tool" >&2
    echo "(In PowerShell? Use Git Bash — see deploy/server-systemd.md, Part C.)" >&2
    exit 1
  }
done

# --- Configuration ----------------------------------------------------------
#
# One file per instance, chosen by `DEPLOY_ENV`. The default is production, so the bare command a
# household types a hundred times keeps meaning exactly what it always meant; a second environment
# is a file rather than a flag because *every* setting differs — root, service, group, both ports —
# and a flag would inevitably carry some of production's.
ENV_FILE="${DEPLOY_ENV:-$ROOT/deploy/deploy.env}"
# Relative paths are resolved against the repo, so `DEPLOY_ENV=deploy/deploy-test.env` works from
# wherever the command was typed.
case "$ENV_FILE" in /*) ;; *) ENV_FILE="$ROOT/$ENV_FILE" ;; esac
if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE" >&2
  if [ -n "${DEPLOY_ENV:-}" ]; then
    echo "DEPLOY_ENV names a file that is not there. For a second instance:" >&2
    echo "  cp deploy/deploy-test.env.example deploy/deploy-test.env   (then fill in root, service and ports)" >&2
  else
    echo "Create it:  cp deploy/deploy.env.example deploy/deploy.env   (then fill in the host and user)" >&2
  fi
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

: "${PANEL_HOST:?set PANEL_HOST in deploy/deploy.env}"
: "${PANEL_SSH_USER:?set PANEL_SSH_USER in deploy/deploy.env}"
PANEL_SSH_PORT="${PANEL_SSH_PORT:-22}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/homehub}"
SERVICE="${SERVICE:-homehub}"
# The group the service account runs under. Releases must carry it, or the service cannot read them.
SERVICE_GROUP="${SERVICE_GROUP:-homehub}"
HTTP_PORT="${HTTP_PORT:-5000}"
HTTPS_PORT="${HTTPS_PORT:-5001}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"

TARGET="$PANEL_SSH_USER@$PANEL_HOST"
SSH=(ssh -p "$PANEL_SSH_PORT" -o ConnectTimeout=10 "$TARGET")
SSH_TTY=(ssh -t -p "$PANEL_SSH_PORT" -o ConnectTimeout=10 "$TARGET")
SCP=(scp -P "$PANEL_SSH_PORT" -q)

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

# --- Sub-commands -----------------------------------------------------------

do_bootstrap() {
  say "Preparing $TARGET (one-time)"
  # `sed` strips CR: these files live on a Windows checkout, and a shell script with CRLF endings
  # fails on Linux with a "bad interpreter" error that names a line, not the real cause.
  "${SSH[@]}" "rm -rf /tmp/homehub-bootstrap && mkdir -p /tmp/homehub-bootstrap"
  "${SCP[@]}" deploy/bootstrap-server.sh deploy/homehub.service "$TARGET:/tmp/homehub-bootstrap/"
  "${SSH[@]}" "sed -i 's/\r\$//' /tmp/homehub-bootstrap/bootstrap-server.sh"
  # -t so the sudo password prompt is visible and answerable. This is the only step that needs it.
  "${SSH_TTY[@]}" "sudo bash /tmp/homehub-bootstrap/bootstrap-server.sh '$PANEL_SSH_USER'"
  echo
  echo "Now: bash scripts/deploy.sh"
}

do_certs() {
  local crt="$ROOT/certs/homehub-panel.crt" key="$ROOT/certs/homehub-panel.key"
  if [ ! -f "$crt" ] || [ ! -f "$key" ]; then
    echo "No panel certificate at certs/homehub-panel.{crt,key}" >&2
    echo "Create it:  bash scripts/make-panel-cert.sh $PANEL_HOST <server-lan-ip>" >&2
    exit 1
  fi
  say "Uploading the panel certificate"
  "${SCP[@]}" "$crt" "$key" "$TARGET:/etc/homehub/certs/"
  # The private key is group-readable so the service account can load it, and nothing wider.
  "${SSH[@]}" "chmod 640 /etc/homehub/certs/homehub-panel.key && chmod 644 /etc/homehub/certs/homehub-panel.crt"
  restart_and_verify
  echo
  echo "Panel HTTPS: https://$PANEL_HOST:$HTTPS_PORT/"
}

do_releases() {
  "${SSH[@]}" "ls -1 '$REMOTE_ROOT/releases' | sort && echo && echo -n 'current -> ' && readlink '$REMOTE_ROOT/current'"
}

do_logs() {
  # No sudo: bootstrap put this account in the systemd-journal group, which is what grants the read.
  # Reading logs as root would mean a passwordless sudo rule for journalctl, and journalctl pages
  # through `less`, which spawns a shell on `!sh` — a root shell, for a log tail.
  "${SSH_TTY[@]}" "journalctl -u '$SERVICE' -n 100 -f"
}

do_rollback() {
  say "Rolling back"
  "${SSH[@]}" "REMOTE_ROOT='$REMOTE_ROOT' bash -s" <<'REMOTE'
set -euo pipefail
cd "$REMOTE_ROOT/releases"
current="$(basename "$(readlink "$REMOTE_ROOT/current")")"
previous="$(ls -1 | sort | grep -B1 -x "$current" | head -1)"
if [ -z "$previous" ] || [ "$previous" = "$current" ]; then
  echo "No earlier release than $current to roll back to." >&2
  exit 1
fi
ln -sfn "$REMOTE_ROOT/releases/$previous" "$REMOTE_ROOT/current.tmp"
mv -Tf "$REMOTE_ROOT/current.tmp" "$REMOTE_ROOT/current"
echo "current -> $previous (was $current)"
REMOTE
  restart_and_verify
}

# Restart, then prove it actually serves. A service that is "active" is not the same as a service
# that answers — a bad connection string or a missing libicu produces a process that starts, throws,
# and gets restarted forever, which `systemctl is-active` reports as running.
#
# Deep health is readiness, not liveness: it returns 503 unless the database connects and the exact
# binary has zero pending migrations. A release that cannot prove that state must not be reported as
# deployed, even if systemd keeps the process active.
restart_and_verify() {
  say "Restarting $SERVICE — sudo will ask for your password on $PANEL_HOST"
  # -t allocates a terminal so sudo can prompt and read the password with echo off. Without it the
  # prompt has nowhere to appear and the restart fails with "no tty present".
  #
  # There is no passwordless sudoers rule for this by design (see bootstrap-server.sh): the one
  # privileged action a deploy takes is restarting the household's panel, and that is worth a
  # password. Exactly one prompt per deploy, here.
  "${SSH_TTY[@]}" "sudo systemctl restart '$SERVICE'"
  "${SSH[@]}" "SERVICE='$SERVICE' HTTP_PORT='$HTTP_PORT' bash -s" <<'REMOTE'
set -uo pipefail
for i in $(seq 1 30); do
  if body="$(curl -fsS --max-time 5 "http://127.0.0.1:$HTTP_PORT/api/health?deep=true" 2>/dev/null)"; then
    echo "health: $body"

    case "$body" in
      *'"database":"ok"'*'"pendingMigrations":0'*) exit 0 ;;
      *)
        echo "Readiness response did not prove database and migration state." >&2
        exit 1
        ;;
    esac
  fi
  if ! systemctl is-active --quiet "$SERVICE"; then
    echo "The service is not running. Last log lines:" >&2
    journalctl -u "$SERVICE" -n 25 --no-pager >&2
    exit 1
  fi
  sleep 1
done
echo "No healthy response after 30s. Last log lines:" >&2
journalctl -u "$SERVICE" -n 25 --no-pager >&2
exit 1
REMOTE
}

do_deploy() {
  local stamp; stamp="$(date +%Y%m%d-%H%M%S)"
  local tarball="$ROOT/artifacts/homehub-$stamp.tar.gz"

  # Fail before spending three minutes on a build if the server is unreachable.
  say "Checking $TARGET"
  "${SSH[@]}" "test -d '$REMOTE_ROOT/releases'" || {
    echo "Cannot reach $REMOTE_ROOT/releases on $TARGET." >&2
    echo "If this server has not been set up yet:  bash scripts/deploy.sh --bootstrap" >&2
    exit 1
  }

  say "Building the SPA"
  (cd client && npm ci && npm run build)

  say "Publishing the API (self-contained, linux-x64)"
  # Cleared first: -o merges into an existing folder, so a file that stopped being produced would
  # otherwise survive in every later release.
  rm -rf "$ROOT/artifacts/publish"
  dotnet publish src/HomeHub.Api/HomeHub.Api.csproj \
    -c Release -r linux-x64 --self-contained true \
    -o "$ROOT/artifacts/publish" \
    --nologo -v minimal

  say "Packaging"
  mkdir -p "$ROOT/artifacts"
  tar -czf "$tarball" -C "$ROOT/artifacts/publish" .
  echo "$(du -h "$tarball" | cut -f1)  $(basename "$tarball")"

  say "Uploading to $TARGET"
  "${SCP[@]}" "$tarball" "$TARGET:/tmp/"

  say "Unpacking release $stamp"
  "${SSH[@]}" "REMOTE_ROOT='$REMOTE_ROOT' STAMP='$stamp' KEEP='$KEEP_RELEASES' SERVICE_GROUP='$SERVICE_GROUP' bash -s" <<'REMOTE'
set -euo pipefail
rel="$REMOTE_ROOT/releases/$STAMP"
mkdir -p "$rel"
tar -xzf "/tmp/homehub-$STAMP.tar.gz" -C "$rel"
rm -f "/tmp/homehub-$STAMP.tar.gz"

# tar from a Windows filesystem carries no executable bit, so the apphost arrives unrunnable and
# systemd reports a bare 203/EXEC. Set it here rather than trusting the archive.
chmod +x "$rel/HomeHub.Api"

# The service account reads these; the deploy account owns them.
#
# chgrp explicitly rather than trusting inheritance: bootstrap sets setgid on releases/ so new
# directories carry the group, but a server prepared before that was added would leave this release
# in the deploy account's own primary group — and `g+rX` would then grant read to a group the
# service is not in, producing a release that looks correct and cannot be executed.
chgrp -R "$SERVICE_GROUP" "$rel" 2>/dev/null || true
chmod -R g+rX "$rel"

# Flip atomically. `ln -sfn` onto an existing symlink-to-a-directory would create a link *inside*
# the old target instead of replacing it; writing a temp link and mv -T over it is the version that
# is actually atomic and actually replaces.
ln -sfn "$rel" "$REMOTE_ROOT/current.tmp"
mv -Tf "$REMOTE_ROOT/current.tmp" "$REMOTE_ROOT/current"
echo "current -> $STAMP"

# Prune, keeping the newest $KEEP. Never touches the live one.
cd "$REMOTE_ROOT/releases"
current="$(basename "$(readlink "$REMOTE_ROOT/current")")"
ls -1 | sort -r | tail -n +$((KEEP + 1)) | while read -r old; do
  [ "$old" = "$current" ] && continue
  rm -rf "${REMOTE_ROOT:?}/releases/$old"
  echo "pruned $old"
done
REMOTE

  restart_and_verify

  # Local artifacts are regenerable; keeping every tarball fills the disk quietly.
  find "$ROOT/artifacts" -maxdepth 1 -name 'homehub-*.tar.gz' | sort -r | tail -n +4 | xargs -r rm -f

  say "Deployed"
  echo "  http://$PANEL_HOST:$HTTP_PORT/"
  "${SSH[@]}" "test -f /etc/homehub/certs/homehub-panel.crt" 2>/dev/null \
    && echo "  https://$PANEL_HOST:$HTTPS_PORT/   (phones: barcode scanning works here)" \
    || echo "  No panel certificate installed — phones will have no camera. See scripts/make-panel-cert.sh"
  echo
  # Found the hard way, 2026-08-06. The Hermes gateways register HomeHub's MCP tools when *they*
  # start. A deploy takes HomeHub down for a moment, and any gateway that tried to register during
  # that window got a 401 and came up healthy with **no house tools at all** — the agents answer
  # normally and simply cannot see the house. Nothing reports it, because nothing is broken.
  echo "  If the agents lost their house tools, restart the gateways — they register on start:"
  echo "    ssh <hermes-host> 'systemctl --user restart barnaby geist'"
  echo
  echo "  Verify the panel:  bash scripts/panel-smoke.sh    (on the server)"
  echo "  Roll back with:    bash scripts/deploy.sh --rollback"
}

case "${1:-}" in
  "")           do_deploy ;;
  --bootstrap)  do_bootstrap ;;
  --certs)      do_certs ;;
  --rollback)   do_rollback ;;
  --releases)   do_releases ;;
  --logs)       do_logs ;;
  *)            echo "Unknown option: $1  (try --help)" >&2; exit 64 ;;
esac
