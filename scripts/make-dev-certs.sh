#!/usr/bin/env bash
#
# Generate the local HTTPS certificates for development.
#
# WHY THIS EXISTS
# ---------------
# The phone-side scan screen (PANTRY_SCREEN §3) needs `navigator.mediaDevices.getUserMedia`, and
# every browser refuses that outside a **secure context** — HTTPS, or localhost. A phone reaching
# the dev server at `http://192.168.5.213:5173` is neither, so the camera is not merely blocked,
# it is `undefined`, and the scan screen falls back to "NO CAMERA HERE".
#
# WHY A LOCAL CA, NOT A BARE SELF-SIGNED CERT
# -------------------------------------------
# A phone has to be told to trust this. Android and iOS both install *CA* certificates, not leaf
# certificates — and iOS additionally requires the CA to be switched on afterwards under
# Settings › General › About › Certificate Trust Settings. Issuing a throwaway CA once and signing
# leaves from it means the phone is set up a single time, and every later re-issue (new IP, expiry)
# is trusted automatically. Clicking through a browser warning is not an alternative: it is
# per-origin, it resets, and on iOS it does not reliably grant a secure context at all.
#
# The CA private key is a real key that can sign for any name. It never leaves this folder, the
# folder is gitignored, and it is only ever trusted by devices in this house.
#
# USAGE
#   bash scripts/make-dev-certs.sh            # detect LAN IPs automatically
#   bash scripts/make-dev-certs.sh 192.168.5.213 192.168.5.104
#
# Run from the repo root. Requires openssl (ships with Git for Windows).

set -euo pipefail

# Git Bash rewrites arguments that look like absolute POSIX paths into Windows ones. That turns
# openssl's `-subj /CN=HomeHub Dev CA` into `C:/Program Files/Git/CN=HomeHub Dev CA`, and the error
# it produces talks about subject format rather than paths, so it reads as a syntax mistake.
#
# The blunt fix (`MSYS_NO_PATHCONV=1`) is wrong here: it also stops converting the *real* paths, so
# openssl is then handed `/c/CODE/...`, which a native Windows binary cannot open — and it fails
# silently, writing nothing. Exclude only the arguments that begin like a DN.
export MSYS2_ARG_CONV_EXCL='/CN=;/O='

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERTS="$ROOT/certs"
mkdir -p "$CERTS"

CA_KEY="$CERTS/homehub-dev-ca.key"
CA_CRT="$CERTS/homehub-dev-ca.crt"
LEAF_KEY="$CERTS/homehub-dev.key"
LEAF_CRT="$CERTS/homehub-dev.crt"
LEAF_CSR="$CERTS/homehub-dev.csr"

HOST="$(hostname)"

# Addresses to cover. Anything not listed here produces a name-mismatch warning on that device,
# which on iOS means no camera — so it is worth being generous.
if [ "$#" -gt 0 ]; then
  IPS=("$@")
else
  # Every IPv4 that isn't loopback or link-local. WSL's 172.x and a VPN's 10.x are harmless to
  # include and cost nothing; leaving out the one address the phone actually uses costs a
  # name-mismatch warning, which on iOS means no camera.
  #
  # `Get-NetIPAddress` rather than `ipconfig`: on this machine ipconfig omitted the Wi-Fi address
  # entirely while PowerShell reported it, and Wi-Fi is precisely the interface a phone reaches.
  mapfile -t IPS < <(
    powershell -NoProfile -Command \
      "Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress" 2>/dev/null \
      | tr -d '\r' \
      | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' \
      | grep -vE '^(127\.|169\.254\.)' \
      | sort -u
  )
  # Non-Windows fallback, so the script is not silently Windows-only.
  if [ "${#IPS[@]}" -eq 0 ] && command -v ip >/dev/null 2>&1; then
    mapfile -t IPS < <(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | sort -u)
  fi
fi

echo "Host      : $HOST"
echo "Addresses : ${IPS[*]:-none found}"
echo

# ---- The CA. Reused if it already exists, so trusting it on a phone is a one-time job. ----
if [ -f "$CA_KEY" ] && [ -f "$CA_CRT" ]; then
  echo "CA        : reusing $CA_CRT (delete it to start over — every device must re-trust)"
else
  echo "CA        : creating"
  openssl req -x509 -newkey rsa:4096 -sha256 -nodes \
    -keyout "$CA_KEY" -out "$CA_CRT" \
    -days 3650 \
    -subj "/CN=HomeHub Dev CA/O=HomeHub" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
fi

# ---- Publish the CA certificate through the panel itself. ----
# Everything in client/public ships inside the SPA build, so this copy is served at
# /homehub-dev-ca.crt by dev Vite and every deployed release alike — which is how a new phone gets
# the file without anyone standing up a throwaway http.server (deploy/server-systemd.md D6). Safe
# to publish: a CA *certificate* is public by design; the key never leaves certs/. The copy is
# gitignored like the rest — each household serves its own CA, no one commits theirs to the repo.
cp -f "$CA_CRT" "$ROOT/client/public/homehub-dev-ca.crt"

# ---- The leaf, re-issued every run so a new address is picked up. ----
SAN="DNS:localhost,DNS:$HOST,DNS:$HOST.local,IP:127.0.0.1,IP:::1"
for ip in "${IPS[@]:-}"; do
  [ -n "$ip" ] && SAN="$SAN,IP:$ip"
done

openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$LEAF_KEY" -out "$LEAF_CSR" \
  -subj "/CN=$HOST/O=HomeHub"

# A real file, not process substitution: `<(...)` hands over `/dev/fd/63`, which a native Windows
# openssl cannot open.
EXT="$CERTS/.leaf.ext"
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n' "$SAN" > "$EXT"

# 397 days, deliberately. Apple rejects TLS server certificates valid for more than 398 days, and a
# cert that works everywhere except the iPhones is the worst outcome available here.
openssl x509 -req -in "$LEAF_CSR" \
  -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$LEAF_CRT" -days 397 -sha256 \
  -extfile "$EXT"

rm -f "$LEAF_CSR" "$EXT"

echo
echo "Wrote:"
echo "  $CA_CRT      <- install this on the phone/tablet"
echo "  $LEAF_CRT"
echo "  $LEAF_KEY"
echo
echo "SANs: $SAN"
echo
echo "Next:"
echo "  1. Trust the CA on this machine (so the desktop browser is happy):"
echo "       powershell -Command \"Import-Certificate -FilePath '$CA_CRT' -CertStoreLocation Cert:\\\\CurrentUser\\\\Root\""
echo "  2. Trust it on the phone — see deploy/dev-https.md."
echo "  3. Restart the API and 'npm run dev'. Both pick the cert up automatically."
