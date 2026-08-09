#!/usr/bin/env bash
#
# Hermes ↔ HomeHub live smoke test. Run this ON THE SERVER (192.168.5.15).
#
# The gateways bind to 127.0.0.1 deliberately — the API key has no route-level scoping, so they are
# not on the LAN. That means this cannot run from a development machine; HomeHub itself has to share
# the host network namespace with Hermes for the same reason.
#
# Reads the keys from HomeHub's own secret store, never from the command line, and prints none of
# them. Nothing here creates or deletes a real conversation: session ids are held and cleaned up.
#
#   bash scripts/hermes-smoke.sh
#
set -uo pipefail

BARNABY_URL="${BARNABY_URL:-http://127.0.0.1:8642}"
GEIST_URL="${GEIST_URL:-http://127.0.0.1:8643}"

pass=0; fail=0
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# --- credentials -------------------------------------------------------------
#
# Read from wherever HomeHub itself reads, so this tests the configuration the app will actually use
# rather than a copy that has drifted. Three places, in the order the app would find them:
#
#   1. /etc/homehub/homehub.env  — the deployed service (Production; `__` form)
#   2. the exported environment  — an operator who has sourced it
#   3. dotnet user-secrets       — development only; NOT read in Production
#
HOMEHUB_ENV="${HOMEHUB_ENV:-/etc/homehub/homehub.env}"

read_key() { # $1 = agent key
  local v envvar="Hermes__Agents__${1}__ApiKey"

  if [ -r "$HOMEHUB_ENV" ]; then
    # Trim an optional `export `, surrounding quotes and trailing whitespace.
    v="$(sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?${envvar}=//p" "$HOMEHUB_ENV" \
          | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" -e 's/[[:space:]]*$//')"
    [ -n "$v" ] && { printf '%s' "$v"; return; }
  fi

  [ -n "${!envvar:-}" ] && { printf '%s' "${!envvar}"; return; }

  printf '%s' "$(cd "$(dirname "$0")/../src/HomeHub.Api" 2>/dev/null \
        && dotnet user-secrets list 2>/dev/null | sed -n "s/^Hermes:Agents:$1:ApiKey = //p")"
}

BARNABY_KEY="$(read_key barnaby)"
GEIST_KEY="$(read_key geist)"

if [ -z "$BARNABY_KEY" ] || [ -z "$GEIST_KEY" ]; then
  echo "No Hermes API keys found."
  echo
  echo "On this server (Production, systemd) put them in $HOMEHUB_ENV:"
  echo "  Hermes__Agents__barnaby__ApiKey=<key>"
  echo "  Hermes__Agents__geist__ApiKey=<key>"
  echo "then: sudo systemctl restart homehub"
  echo
  echo "On a development machine instead:"
  echo "  cd src/HomeHub.Api"
  echo "  dotnet user-secrets set \"Hermes:Agents:barnaby:ApiKey\" \"<key>\""
  echo
  echo "The values are each profile's own API_SERVER_KEY:"
  echo "  grep API_SERVER_KEY /home/hermes/.hermes/profiles/barnaby/.env"
  echo "  grep API_SERVER_KEY /home/hermes/.hermes/profiles/geist/.env"
  exit 2
fi

# --- 1. health, unauthenticated ---------------------------------------------
section "1 · Health (unauthenticated) — expects the API-SERVER shape, not the dashboard's"
for pair in "barnaby $BARNABY_URL" "geist $GEIST_URL"; do
  set -- $pair
  body="$(curl -s --max-time 5 "$2/health")"
  # {status, platform, version} is the gateway. {ok, version, auth_required} is the dashboard —
  # a different service with different auth and different contracts.
  if grep -q '"platform"' <<<"$body" && grep -q '"status"' <<<"$body"; then
    ok "$1 $2 — api-server gateway, $(sed -n 's/.*"version"[: ]*"\([^"]*\)".*/\1/p' <<<"$body")"
  elif grep -q '"auth_required"' <<<"$body"; then
    bad "$1 $2 — this is the Hermes DASHBOARD, not the gateway. Wrong port."
  else
    bad "$1 $2 — no api-server health response"
  fi
done

# --- 2. authentication is enforced ------------------------------------------
section "2 · Authentication is enforced"
for pair in "barnaby $BARNABY_URL" "geist $GEIST_URL"; do
  set -- $pair
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$2/v1/models")"
  [ "$code" = "401" ] && ok "$1 — unauthenticated /v1/models is 401" \
                      || bad "$1 — unauthenticated /v1/models returned $code, expected 401"
done

# --- 3. advertised identity --------------------------------------------------
section "3 · Advertised identity matches the configured agent"
identity() { curl -s --max-time 5 -H "Authorization: Bearer $2" "$1/v1/models" \
             | sed -n 's/.*"id"[: ]*"\([^"]*\)".*/\1/p' | head -1; }
b_id="$(identity "$BARNABY_URL" "$BARNABY_KEY")"
g_id="$(identity "$GEIST_URL" "$GEIST_KEY")"
[ "$b_id" = "barnaby" ] && ok "barnaby advertises 'barnaby'" || bad "barnaby advertises '$b_id'"
[ "$g_id" = "geist" ]   && ok "geist advertises 'geist'"     || bad "geist advertises '$g_id'"
[ "$b_id" != "$g_id" ]  && ok "the two gateways are distinct profiles" \
                        || bad "both gateways advertise the same identity — check the ports"

# --- 4. a turn, and continuing it -------------------------------------------
section "4 · A disposable conversation on each gateway"
chat() { # $1 url  $2 key  $3 session-or-empty  $4 prompt
  local hdr=(); [ -n "$3" ] && hdr=(-H "X-Hermes-Session-Id: $3")
  curl -s -D /tmp/hermes-hdr.$$ --max-time 120 -X POST "$1/v1/chat/completions" \
    -H "Authorization: Bearer $2" -H 'Content-Type: application/json' "${hdr[@]}" \
    -d '{"messages":[{"role":"user","content":"'"$4"'"}],"stream":false}'
}
new_session() { # $1 url  $2 key
  curl -s --max-time 20 -X POST "$1/api/sessions" -H "Authorization: Bearer $2" \
    -H 'Content-Type: application/json' -d '{"title":"HomeHub smoke test","source":"homehub-smoke"}' \
    | sed -n 's/.*"id"[: ]*"\([^"]*\)".*/\1/p' | head -1
}

declare -A SESSIONS
for pair in "barnaby $BARNABY_URL $BARNABY_KEY" "geist $GEIST_URL $GEIST_KEY"; do
  set -- $pair
  sid="$(new_session "$2" "$3")"
  if [ -z "$sid" ]; then bad "$1 — could not open a session"; continue; fi
  SESSIONS[$1]="$sid"; ok "$1 — opened session"

  body="$(chat "$2" "$3" "$sid" "Reply with the single word: ok")"
  grep -q '"content"' <<<"$body" && ok "$1 — first turn answered" || bad "$1 — first turn produced no content"

  # The effective id, which may differ from what we sent once compression happens.
  eff="$(sed -n 's/.*[Xx]-[Hh]ermes-[Ss]ession-[Ii]d: *\([^ \r]*\).*/\1/p' /tmp/hermes-hdr.$$ | tr -d '\r')"
  [ -n "$eff" ] && ok "$1 — reports an effective session id on the response" \
                || bad "$1 — no X-Hermes-Session-Id header on the chat response"

  body="$(chat "$2" "$3" "${eff:-$sid}" "And reply again with: ok")"
  grep -q '"content"' <<<"$body" && ok "$1 — continued the same session" || bad "$1 — could not continue"
done
rm -f /tmp/hermes-hdr.$$

# --- 5. the two conversations stayed apart ----------------------------------
section "5 · Sessions are profile-local"
if [ -n "${SESSIONS[barnaby]:-}" ] && [ -n "${SESSIONS[geist]:-}" ]; then
  [ "${SESSIONS[barnaby]}" != "${SESSIONS[geist]}" ] \
    && ok "the two session ids differ" || bad "both gateways returned the same session id"
  # Barnaby's id must be meaningless to Geist.
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
          -H "Authorization: Bearer $GEIST_KEY" "$GEIST_URL/api/sessions/${SESSIONS[barnaby]}/messages")"
  [ "$code" = "404" ] && ok "geist does not know barnaby's session (404)" \
                      || bad "geist answered $code for a barnaby session id — profiles are not isolated"
fi

# --- 6. clean up -------------------------------------------------------------
section "6 · Removing the disposable sessions"
for pair in "barnaby $BARNABY_URL $BARNABY_KEY" "geist $GEIST_URL $GEIST_KEY"; do
  set -- $pair
  sid="${SESSIONS[$1]:-}"; [ -z "$sid" ] && continue
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X DELETE \
          -H "Authorization: Bearer $3" "$2/api/sessions/$sid")"
  case "$code" in
    2*|404) ok "$1 — smoke session removed ($code)" ;;
    *)      bad "$1 — delete returned $code; session $sid may remain" ;;
  esac
done

printf '\n\033[1m%d passed, %d failed\033[0m\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
