#!/usr/bin/env bash
#
# Issue the HTTPS certificate for the *deployed* panel, signed by the same local CA that
# `make-dev-certs.sh` created.
#
# WHY THIS EXISTS
# ---------------
# `make-dev-certs.sh` covers the dev machine and detects its own addresses. The server is a
# different host that this machine cannot introspect, so its names are passed in. Everything else
# is deliberately identical — above all the CA, because that is the whole point: the household's
# phones were told once to trust `homehub-dev-ca.crt`, and a leaf signed by it is trusted with no
# further per-device work. A fresh self-signed cert for the server would mean walking every phone
# through installation again.
#
# The leaf produced here is the pair the systemd service points `Server:CertPath` / `Server:KeyPath`
# at, and `scripts/deploy.sh` uploads it. Kestrel picks it up by presence (see Program.cs).
#
# USAGE
#   bash scripts/make-panel-cert.sh homehub.local 192.168.5.20
#   bash scripts/make-panel-cert.sh "$PANEL_HOST" "$PANEL_IP"     # any mix of names and IPs
#
# Arguments are sorted into DNS or IP SANs automatically. List every address a phone might use —
# a name not in the SAN list is a mismatch warning, and on iOS a mismatch means no camera.
#
# Run from the repo root. Requires openssl (ships with Git for Windows).

set -euo pipefail

# See make-dev-certs.sh: Git Bash rewrites arguments that look like absolute POSIX paths, which
# turns `-subj /CN=...` into a path under the Git install and produces an error about subject
# format rather than about paths. Exclude only the DN-shaped arguments.
export MSYS2_ARG_CONV_EXCL='/CN=;/O='

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERTS="$ROOT/certs"

CA_KEY="$CERTS/homehub-dev-ca.key"
CA_CRT="$CERTS/homehub-dev-ca.crt"
LEAF_KEY="$CERTS/homehub-panel.key"
LEAF_CRT="$CERTS/homehub-panel.crt"
LEAF_CSR="$CERTS/homehub-panel.csr"

if [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/make-panel-cert.sh <hostname-or-ip> [more...]" >&2
  echo "   eg: bash scripts/make-panel-cert.sh homehub.local 192.168.5.20" >&2
  exit 64
fi

# Reused, never re-created. If the CA is missing, creating one here would silently invalidate every
# device that already trusts the existing one — so this stops instead.
if [ ! -f "$CA_KEY" ] || [ ! -f "$CA_CRT" ]; then
  echo "No local CA found at $CA_CRT" >&2
  echo "Run 'bash scripts/make-dev-certs.sh' first — it creates the CA this script signs with." >&2
  exit 1
fi

# Sort the arguments into IP: and DNS: SANs. openssl rejects an IP literal given as a DNS SAN with a
# confusing message, and a browser will not match it either.
SAN="DNS:localhost,IP:127.0.0.1"
PRIMARY=""
for name in "$@"; do
  [ -n "$name" ] || continue
  [ -n "$PRIMARY" ] || PRIMARY="$name"
  if printf '%s' "$name" | grep -qE '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
    SAN="$SAN,IP:$name"
  else
    SAN="$SAN,DNS:$name"
    # A bare hostname and its mDNS form are different names to a browser, and the kiosk and the
    # phones do not necessarily use the same one. Cover both rather than debug it later.
    case "$name" in
      *.*) ;;
      *) SAN="$SAN,DNS:$name.local" ;;
    esac
  fi
done

echo "Panel     : $PRIMARY"
echo "CA        : $CA_CRT (reused)"
echo

openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$LEAF_KEY" -out "$LEAF_CSR" \
  -subj "/CN=$PRIMARY/O=HomeHub"

# A real file, not process substitution: `<(...)` hands over `/dev/fd/63`, which a native Windows
# openssl cannot open.
EXT="$CERTS/.panel.ext"
printf 'subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n' "$SAN" > "$EXT"

# 397 days, matching the dev leaf: Apple rejects TLS server certificates valid for longer than 398,
# and a cert that works everywhere except the iPhones is the worst outcome available.
openssl x509 -req -in "$LEAF_CSR" \
  -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$LEAF_CRT" -days 397 -sha256 \
  -extfile "$EXT"

rm -f "$LEAF_CSR" "$EXT"

# --- Prove the pair actually matches before anyone ships it ------------------
#
# Kestrel loads these two files together, and a mismatch is not caught until startup — where it
# surfaces as `CryptographicException: The key contents do not contain a PEM, the content is
# malformed, or the key does not match the certificate`, in a crash loop, on the panel, at the point
# where it is hardest to investigate.
#
# It is easier to get here than it looks. `scp a b` with the destination left off is a *local* copy,
# so a fumbled upload command silently overwrites the key with the certificate — two files, both
# present, both plausible in `ls -l`, one of them useless. Two seconds of checking here beats
# discovering it from a journal on another machine.
CRT_PUB="$(openssl x509 -in "$LEAF_CRT" -noout -pubkey 2>/dev/null | openssl sha256)"
KEY_PUB="$(openssl pkey -in "$LEAF_KEY" -pubout 2>/dev/null | openssl sha256)"

if [ -z "$CRT_PUB" ] || [ "$CRT_PUB" != "$KEY_PUB" ]; then
  echo >&2
  echo "ERROR: the certificate and key just written do not match (or did not parse)." >&2
  echo "  cert: ${CRT_PUB:-<unreadable>}" >&2
  echo "  key : ${KEY_PUB:-<unreadable>}" >&2
  echo "Delete certs/homehub-panel.* and run this script again." >&2
  exit 1
fi

echo
echo "Verified: the certificate and key match."
echo
echo "Wrote:"
echo "  $LEAF_CRT"
echo "  $LEAF_KEY"
echo
echo "SANs: $SAN"
echo
echo "Next: bash scripts/deploy.sh --certs   (uploads the pair, then restarts the service)"
echo "Expires: $(openssl x509 -enddate -noout -in "$LEAF_CRT" | cut -d= -f2) — re-run this script and redeploy before then."
