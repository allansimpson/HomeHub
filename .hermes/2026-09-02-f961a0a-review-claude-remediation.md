# f961a0a review — Claude's remediation

**Commit:** `fbe34b1`
**Answers:** the three confirmed High findings in Geist's corrected `f961a0a` review
**Status:** implemented with red-capable regressions. **Geist marks the review, not this record.**

All three confirmed. The correction to the third finding is noted and this record addresses the
retention finding rather than the lineage-audit authorization concern, which Geist retracted from the
blocker set.

## 1. Chatterbox over non-loopback HTTP

**Confirmed, and it is a miss in the same file as its own precedent.** The previous round applied
`RefuseCleartext` inside `EgressGuard.Refuse` — a *shape* check — and gave Chatterbox a guarded
handler. The handler screens the addresses a connection is made to and never reads the scheme, and
nothing called the shape check for this endpoint. So `Voice:Tts:Chatterbox:Endpoint =
http://server.lan:8004` passed everything and sent the household's text, including assistant replies
that quote the household back to itself, across the LAN to a listener nothing authenticates.

The local STT sidecar in the same options class had all three checks — rule, `LocalConfigured`,
validator. Chatterbox had none. That is the fourth recorded instance of fixing the named case and
leaving its sibling.

- `ChatterboxOptions.Rule` — `EgressRule.HouseholdLan("Voice:Tts:Chatterbox:Endpoint")`
- `IsConfigured` includes `EgressGuard.IsPermitted`, so a bad destination reads as no Chatterbox and
  `VoiceRouter` falls back to Piper rather than posting at it
- `VoiceOptionsValidator` refuses it at startup in a deployment

## 2. RR-05 omitted the dropped-operation notices

**Confirmed.** `sweepLegacyPlaintext` took `homehub.writequeue.v1` and left
`homehub.writequeue.dropped.v1` alone. A notice carries `label`, which for a care write is the entry
restated for a person to read — "Bottle 120ml for Wren". The records were removed from one key and
left legible in the one beside it.

Two structural points came out of fixing it:

- **The notice sweep must not depend on the operation sweep.** The first attempt returned early when
  the operation store was empty or held nothing private, which skips the notices entirely — and a
  household that had already retried its set-aside entries has exactly that shape: empty queue, notice
  store still naming every one. The two are swept independently now and the result is the conjunction.
- **The redacted notices this writes are private-domain too**, so a rule that swept by domain would
  delete the household's own telling on the next boot. They are recognised by the exact sentence they
  carry (`REDACTED_LABEL`), which is a narrow test and a checkable one.

Removal is read back, and a legible notice that cannot be removed returns `false` — the same
verification the operation store already had.

## 3. Cross-profile retention deletion without tombstones

**Confirmed, both halves.** `SweepAsync` ran inside the conversation-list read and deleted every
expired conversation in the household, so one member opening Assist destroyed another's chats. And it
removed the rows and their lineage references while recording nothing about the Hermes transcripts, so
the agent kept what the panel had just promised to forget.

`Assist/AssistRetention.cs` (new) replaces it:

- **`SweepForAsync(profileId, …)`** in the request path — the caller's own conversations only, so a
  read cannot reach anybody else's data.
- **Tombstones for the full lineage** — every `SessionReferences` entry plus the current
  `HermesSessionId`, exactly as the explicit delete walks it. The old comment argued against deleting
  agent sessions here because it would put N HTTP round-trips inside a list read that runs on every
  poll. That reasoning was right and the conclusion did not follow: a `HermesSessionDeletion` is a
  database row, and `SessionDeletionWorker` drains it in the background.
- **`AssistRetentionWorker`** — an hourly household-wide pass. Without it, scoping the read would have
  quietly turned retention off for any member who stopped opening Assist, which is the retention
  promise failing for the people least likely to notice. Registered only alongside a database.

### Red-capable verification

Restoring the previous behaviour — global scope, no tombstones — fails both new tests:
`One_member_s_list_read_does_not_delete_another_member_s_conversations` and
`Retention_leaves_a_deletion_tombstone_for_every_session_in_the_lineage`. The notice-sweep group fails
against the previous `sweepLegacyPlaintext`.

## Two fixtures moved, which is a real behaviour change

- `VoiceRouterTests` used `http://gpu.test:8004` for Chatterbox; now `https`.
- `HubAppFactory` registers `AssistRetention` alongside the other DB-gated services it provides, since
  the app gates it on a connection string the tests do not set.

## Gate

```text
./scripts/check.sh all
  ok  typecheck      6s
  ok  lint           1s
  ok  tests          4s   Test Files  54 passed (54)
  ok  backend-tests 50s   Failed: 0, Passed: 1330, Skipped: 0, Total: 1330
  ok  bridge-tests   2s   Ran 12 tests
```

Backend 1,328 → 1,330. No baseline dropped.

## Preflight for this candidate

Unchanged from the last record, plus one:

- `Voice:Tts:Chatterbox:Endpoint` — loopback or https. Production runs Piper as primary, so this
  should be inert; a non-loopback http value now reads as unconfigured rather than erroring.
- Retention behaviour changes in one visible way: a member's own expired conversations are still swept
  on their next list read, and everybody else's are swept within the hour by the background pass
  rather than instantly by whoever opened Assist first.
