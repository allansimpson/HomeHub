#!/usr/bin/env bash
#
# Verify a DEPLOYED panel — run this on the server, after a deploy.
#
# Companion to hermes-smoke.sh, and deliberately the other side of the seam. That one asks whether
# the Hermes gateways are healthy; this asks whether *the panel HomeHub actually installed* is
# talking to them correctly. Both have passed while the thing in between was broken.
#
# Everything here is READ-ONLY except one disposable chat turn, which is the only way to observe
# streaming at all. It creates one short conversation and tells you its id so you can delete it.
#
#   bash scripts/panel-smoke.sh
#   PORT=5080 bash scripts/panel-smoke.sh
#
set -uo pipefail

PORT="${PORT:-5080}"
BASE="http://127.0.0.1:$PORT"
HOMEHUB_ENV="${HOMEHUB_ENV:-/etc/homehub/homehub.env}"

pass=0; fail=0; warn=0
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
bad()   { printf '  \033[31m✗\033[0m %s\n' "$1"; fail=$((fail+1)); }
note()  { printf '  \033[33m!\033[0m %s\n' "$1"; warn=$((warn+1)); }
info()  { printf '    %s\n' "$1"; }
section() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Read a setting exactly where the running service reads it, so this tests the live configuration
# rather than a copy that has drifted.
setting() {
  [ -r "$HOMEHUB_ENV" ] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]]\+\)\?${1}=//p" "$HOMEHUB_ENV" \
    | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" -e 's/[[:space:]]*$//'
}

# A check that cannot run must say so, never return a verdict. Suppressing the interpreter's own
# error once turned "python3 is not installed" into "the reply was buffered, not streamed" — a
# confident regression report about 23 frames that had arrived perfectly.
PY=""
for c in python3 python; do
  # Not `command -v`: Windows ships a `python` shim on PATH whose only behaviour is to print
  # "Python was not found" and fail. Presence is not capability, so make it prove it runs.
  if "$c" -c 'import json,sys' >/dev/null 2>&1; then PY="$c"; break; fi
done
[ -z "$PY" ] && printf '[33m![0m no python found — JSON checks will be skipped, not guessed
'

jq_get() { [ -n "$PY" ] || return 1; "$PY" -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

# --- 1. the build and the schema --------------------------------------------
section "Build and schema"

health="$(curl -fsS --max-time 5 "$BASE/api/health?deep=true" 2>/dev/null)"
if [ -z "$health" ]; then
  bad "no answer on $BASE — is the service up, and is PORT right?"
  echo; echo "Checked $BASE. Set PORT= if Server__HttpPort differs."; exit 1
fi
ok "panel answering on $PORT"

# Read without an interpreter: this is the one answer worth having even on a bare box.
pending="$(printf '%s' "$health" | sed -n 's/.*"pendingMigrations":\([0-9][0-9]*\).*/\1/p')"
case "$pending" in
  0)  ok "migrations applied (0 pending)";;
  "") note "health did not report pendingMigrations — old build, or ?deep=true ignored";;
  *)  bad "$pending migration(s) pending — the schema is behind the code";;
esac

code="$(curl -fsS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/api/assist/lineage/report" 2>/dev/null)"
if [ "$code" = "200" ]; then
  ok "lineage endpoint present — this is the current build"
else
  bad "lineage endpoint returned $code — an older build is deployed; nothing below is meaningful"
fi

# --- 2. the agents ----------------------------------------------------------
section "Agents"

agents="$(curl -fsS --max-time 5 "$BASE/api/assist/agents" 2>/dev/null)"
for a in barnaby geist; do
  conf="$(printf '%s' "$agents" | jq_get "next((x['configured'] for x in d if x['key']=='$a'), None)")"
  case "$conf" in
    True)  ok "$a configured";;
    False) note "$a has no ApiKey — it will answer with the canned line";;
    *)     note "$a not in the default member's roster — an assignment, not a configuration, problem";;
  esac
done

# --- 3. house access, per credential ----------------------------------------
#
# The one that matters most. HomeHub is the authority on what each agent may call, and the failure
# this catches is not a broken tool — it is a read-only agent quietly holding a write-capable token,
# which looks exactly like everything working.
section "MCP scope"

# Unreadable and absent are not the same answer, and only one of them is good news. The env file is
# root:homehub 640, so a user outside that group reads nothing — and every check below would then
# report "no credentials configured" about a correctly configured panel.
if [ ! -e "$HOMEHUB_ENV" ]; then
  note "$HOMEHUB_ENV does not exist — running against a dev box? MCP checks skipped, not judged."
  SKIP_MCP=1
elif [ ! -r "$HOMEHUB_ENV" ]; then
  note "cannot read $HOMEHUB_ENV (it is root:homehub 640) — MCP checks skipped, not judged."
  info "add yourself to the group:  sudo usermod -a -G homehub \$USER   then log out and back in"
  SKIP_MCP=1
else
  SKIP_MCP=0
fi

legacy="$(setting 'Mcp__ApiKey')"
[ -n "$legacy" ] && note "Mcp__ApiKey is still set — a six-method key valid for anyone holding it. Comment it out once per-agent credentials are in."

tools_for() { # $1 = bearer
  curl -fsS --max-time 10 "$BASE/mcp" \
    -H "Authorization: Bearer $1" \
    -H 'Accept: application/json, text/event-stream' \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' 2>/dev/null \
  | sed -e 's/^data: //' | tr -d '\r' | grep -v '^event:' | grep '{' | tail -1 \
  | jq_get "','.join(sorted(t['name'] for t in d['result']['tools']))"
}

b_key="$(setting 'Mcp__Credentials__barnaby__ApiKey')"
g_key="$(setting 'Mcp__Credentials__geist__ApiKey')"

if [ "$SKIP_MCP" = "1" ]; then
  : # already reported above; saying it twice would read as two problems
elif [ -z "$b_key" ] && [ -z "$g_key" ]; then
  note "no per-agent MCP credentials configured — house access is whatever holds Mcp__ApiKey"
else
  if [ -n "$b_key" ] && [ "$b_key" = "$g_key" ]; then
    bad "barnaby and geist share one MCP token — they cannot be told apart, so neither is scoped"
  fi

  if [ -n "$b_key" ]; then
    t="$(tools_for "$b_key")"
    [ -n "$t" ] && ok "barnaby: $t" || bad "barnaby's MCP credential was refused"
  fi

  if [ -n "$g_key" ]; then
    t="$(tools_for "$g_key")"
    if [ -z "$t" ]; then
      bad "geist's MCP credential was refused"
    elif printf '%s' "$t" | grep -qE 'set_climate|add_todo'; then
      bad "geist can WRITE to the house: $t"
      info "Geist is the research agent. It should hold reads only:"
      info "get_calendar, get_climate_zones, get_sensor_readings"
    else
      ok "geist (read-only): $t"
    fi
  fi
fi

# --- 4. streaming, as the panel experiences it ------------------------------
#
# The only check here that is not read-only, and the only one that can catch the regression that
# matters: an endpoint which buffers the whole reply and sends it as one frame satisfies every
# "the answer is correct" test and is exactly what streaming exists not to do.
section "Streaming"

tmp="$(mktemp)"; started="$(date +%s.%N)"
curl -N -fsS --max-time 90 -X POST "$BASE/api/assist/chat/stream" \
  -H 'Content-Type: application/json' \
  -d '{"agentKey":"barnaby","prompt":"Reply with one short sentence about the weather.","profileId":1}' \
  2>/dev/null | while IFS= read -r line; do printf '%s %s\n' "$(date +%s.%N)" "$line"; done > "$tmp"

if [ ! -s "$tmp" ]; then
  bad "the stream produced nothing"
else
  deltas="$(grep -c '"text"' "$tmp" || true)"
  first="$(grep -m1 '"text"' "$tmp" | cut -d' ' -f1)"
  last="$(grep '"text"' "$tmp" | tail -1 | cut -d' ' -f1)"

  spread="$(awk -v a="$first" -v b="$last" 'BEGIN{printf "%.2f", b-a}')"
  ttft="$(awk -v a="$started" -v b="$first" 'BEGIN{printf "%.2f", b-a}')"

  if [ "$deltas" -gt 1 ]; then
    ok "$deltas delta frames"
    if awk -v a="$first" -v b="$last" 'BEGIN{exit !(b-a > 0.05)}'; then
      ok "deltas spread over ${spread}s — genuinely incremental"
    else
      bad "all $deltas deltas arrived within ${spread}s — the reply was buffered, not streamed"
    fi
  else
    note "$deltas delta frame(s) — too short to judge, or buffered"
  fi

  info "server-side time to first delta: ${ttft}s (gateway alone was ~0.85s)"
  info "browser-submit-to-first-PAINTED-text is the number that matters:"
  info "  run window.__assistFirstPaint() in the panel's devtools after a few turns"

  finish="$(grep '"finishReason"' "$tmp" | tail -1 | sed -n 's/.*"finishReason":"\([^"]*\)".*/\1/p')"
  case "$finish" in
    stop)       ok "finishReason: stop";;
    incomplete) bad "finishReason: incomplete — the stream never framed a finished turn";;
    length)     note "finishReason: length — the reply was truncated at the token ceiling";;
    *)          note "finishReason: ${finish:-none}";;
  esac

  grep -q 'tool_describe' "$tmp" && bad "tool_describe leaked to the browser" \
    || ok "no tool_describe in the stream"

  cid="$(grep '"conversationId"' "$tmp" | tail -1 | sed -n 's/.*"conversationId":\([0-9]*\).*/\1/p')"
  # A POST with a body, not DELETE /{id}: deleting is a batch operation, and it drops the Hermes
  # transcripts alongside the household's rows rather than only the local copy.
  [ -n "$cid" ] && info "created conversation $cid — remove it and its Hermes transcript with:" \
    && info "  curl -X POST $BASE/api/assist/conversations/delete -H 'Content-Type: application/json' -d '{\"ids\":[$cid]}'"
fi
rm -f "$tmp"

# --- 5. lineage ------------------------------------------------------------
section "Lineage"

rep="$(curl -fsS --max-time 60 "$BASE/api/assist/lineage/report" 2>/dev/null)"
if [ -z "$rep" ]; then
  bad "the lineage report did not answer"
else
  clean="$(printf '%s' "$rep" | jq_get 'd["clean"]')"
  if [ "$clean" = "True" ]; then
    ok "lineage clean — the backfill and the stronger delete wording are unblocked"
  else
    note "lineage not clean (expected until the backfill runs). Blocking reasons:"
    if [ -n "$PY" ]; then
      printf '%s' "$rep" | "$PY" -c "
import sys,json
d=json.load(sys.stdin)
for r in d['blockingReasons']: print('     -', r)
for a in d['agents']:
    c={k:v for k,v in a['counts'].items() if v}
    print(f\"     [{a['agentKey']}] sessions={a['sessionsSeen']} sources={a['sourceBreakdown']} {c}\")
"
    fi
  fi
fi

section "Result"
printf '  %d passed, %d failed, %d to look at\n\n' "$pass" "$fail" "$warn"
[ "$fail" -eq 0 ]
