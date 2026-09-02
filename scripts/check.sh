#!/usr/bin/env bash
#
# Verification in one command, so it costs one round trip instead of eight.
#
# The checks themselves are cheap — the client suite is 872 tests in under four seconds, because it
# is pure logic in a node environment with nothing rendered. What was expensive was the *shape* of
# running them: typecheck, then lint, then tests, then build, each as its own invocation, each
# waiting on a human to approve it, and the whole ladder restarted from the top every time the first
# rung failed. A font-size change was costing ten minutes of a session to verify four seconds of
# work.
#
# Two things follow from that, and they are the whole design here:
#
# <b>Nothing stops early.</b> Every check runs even after one fails, and the failures are reported
# together at the end. `tsc` failing does not make the test results uninteresting — vitest
# transpiles without consulting it, so the tests were always going to tell you something true. The
# `&&`-chain that seems natural here is what turns one lap into three: fix the type error, rerun,
# discover the lint error, rerun, discover the test failure. All of it was knowable on the first
# pass.
#
# <b>The command string never varies.</b> Permission allowlists match on the literal text, so
# `--nologo` or a `| tail` or a `time` prefix is a new command that has to be approved again. That is
# not hypothetical: `.claude/settings.local.json` had accumulated four separate entries that all mean
# "run the backend tests", differing only in flags. Every flag this needs lives in this file, so
# `scripts/check.sh` stays one string that can be approved once.
#
# Usage:
#   scripts/check.sh              # client only — the right default, most changes are client-side
#   scripts/check.sh backend      # backend only
#   scripts/check.sh all          # everything, for API-contract changes and before a hand-off to Hermes
#   scripts/check.sh bridge       # the Python voice bridge only
#   scripts/check.sh client build # add the production build (slow, and only pre-deploy matters)
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT=$PWD

SCOPE=${1:-client}
WITH_BUILD=${2:-}

declare -a RESULTS=()
declare -i FAILURES=0

# Run one check, keep its output, and say something useful about it either way.
#
# On success only the extracted detail line survives, which keeps a green run to a handful of lines
# — this output is read by an agent with a context window, and forty-five progress dots are forty-five
# tokens of nothing. On failure the full output is printed, because that is the entire reason to run.
run() {
  local name=$1 detail_pattern=$2 cmd=$3
  local out rc started elapsed

  started=$SECONDS
  out=$(eval "$cmd" 2>&1)
  rc=$?
  elapsed=$((SECONDS - started))

  local detail=''
  if [ -n "$detail_pattern" ]; then
    detail=$(printf '%s\n' "$out" | grep -oE "$detail_pattern" | tail -1)
  fi

  if [ $rc -eq 0 ]; then
    RESULTS+=("  ok    $(printf '%-18s' "$name") ${elapsed}s  ${detail}")
  else
    RESULTS+=("  FAIL  $(printf '%-18s' "$name") ${elapsed}s  ${detail}")
    FAILURES+=1
    printf '\n===== %s failed =====\n%s\n' "$name" "$out"
  fi
}

if [ "$SCOPE" = client ] || [ "$SCOPE" = all ]; then
  # `tsc -b` is incremental and warm at about six seconds; it is the slowest thing here by an order
  # of magnitude over the tests, which is worth knowing before blaming the suite for being large.
  run typecheck '' "cd '$ROOT/client' && npx tsc -b"
  run lint '' "cd '$ROOT/client' && npx oxlint src/"

  # <b>Watch the file count, not just the test count.</b> vitest counts an unreadable or
  # unresolvable test file as a failed *file* while the summary still reads `N passed` — that is
  # documented in brain/ENVIRONMENT.md because it once hid 61 missing tests for seven hours. Pulling
  # the file line into the summary is what makes a silent drop visible without reading the log.
  run tests 'Test Files.*' "cd '$ROOT/client' && npx vitest run --reporter=dot"

  if [ "$WITH_BUILD" = build ]; then
    run build '' "cd '$ROOT/client' && npm run build"
  fi
fi

if [ "$SCOPE" = backend ] || [ "$SCOPE" = all ]; then
  # Both environment variables are load-bearing, and the failure without them looks nothing like the
  # cause — a bare `dotnet test` reports several hundred failures spread across unrelated suites.
  # `fs.inotify.max_user_instances` is 128 and every WebApplicationFactory opens config watchers; an
  # exported connection string is inherited by the test process and breaks the production-startup
  # tests specifically. brain/ENVIRONMENT.md has the long version of both.
  run backend-tests 'Failed:.*Total: *[0-9]*' \
    "cd '$ROOT' && env -u ConnectionStrings__HomeHub DOTNET_hostBuilder__reloadConfigOnChange=false dotnet test HomeHub.slnx --nologo"
fi

if [ "$SCOPE" = bridge ] || [ "$SCOPE" = all ]; then
  # The voice bridge is Python and has no test dependency beyond `requests`, which it already needs —
  # `unittest` is stdlib. Two of its tests stand up real listeners, because the failure they cover is
  # a redirect being followed and only the second server can say whether it heard the household.
  #
  # In `all` rather than only on demand: it is the one component that runs on the kitchen counter with
  # no screen, so nothing about it going wrong is visible until somebody notices the house is quiet.
  run bridge-tests 'Ran [0-9]* tests' \
    "cd '$ROOT/voice-bridge' && python3 -m unittest discover -s tests"
fi

printf '\n--- check: %s ---\n' "$SCOPE"
printf '%s\n' "${RESULTS[@]}"

if [ $FAILURES -gt 0 ]; then
  printf '\n%d check(s) failed.\n' "$FAILURES"
  exit 1
fi
exit 0
