# Verification: Huckleberry → HomeHub care log import

**Date:** 2026-08-14
**Subject:** confirming the household's existing care history actually landed in HomeHub's database
**Built by:** Claude Code, this session
**Code:** `src/HomeHub.Api/Care/` — `CareImportService`, `HuckleberryCalendarParser`, `CareController`
**Migration:** `20260814090000_AddCareLog`

---

## What this is verifying, and what it is not

HomeHub now keeps its **own** care log. The Huckleberry HA integration exposes seventeen services and
no more — bottle, four diaper kinds, growth, and the nursing/sleep timer verbs — none of which takes
a timestamp, and six of the ten things a household logs have no service at all. So the panel writes
to `CareEntries` from here on, and Huckleberry becomes a **read-only source** to be drawn from until
the household has switched over.

This document verifies **that the pull worked**. It does not verify that the log is complete, because
it cannot be: see *Limits* at the end.

**The import only reads.** Nothing in this path writes to Huckleberry. A failed verification cannot
have damaged the household's own app.

---

## Gate 0 — the code and schema are actually deployed

Skip this and every later number is meaningless.

```bash
curl -sk "https://127.0.0.1:5181/api/health?deep=true"
```

| Field | Required value | If it differs |
|---|---|---|
| `migrationHead` | `20260814090000_AddCareLog` | The build predates the care log. **Stop** — deploy first. |
| `pendingMigrations` | `0` | The schema has not been applied. **Stop** — restart the service; it migrates on boot. |
| `database` | `ok` | Nothing can be imported into a database that is not there. |

`:5181` is TEST. Production is `:5081` and should **not** be used for this until TEST passes.

---

## Gate 1 — there is something upstream to pull

The import reads `calendar.{childKey}_events` through Home Assistant. If that entity is empty or
unreachable, a clean run of zero is indistinguishable from a broken one, so establish the source
first.

```bash
# Token: HomeAssistant__Token in /etc/homehub/homehub.env
curl -s -H "Authorization: Bearer $HA_TOKEN" \
  "http://127.0.0.1:8123/api/calendars/calendar.conrad_events?start=$(date -d '30 days ago' +%Y-%m-%dT%H:%M:%S)&end=$(date +%Y-%m-%dT%H:%M:%S)" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(len(d),'events')"
```

**Expected: several hundred.** On 2026-08-13 this returned **426 events over 30 days** — roughly 218
bottles, 94 nursing, 85 diapers, 24 medication, 5 sleep.

Note the timestamp format: Home Assistant rejects offset-aware ISO here and answers `400`. Naive
`%Y-%m-%dT%H:%M:%S` is what it accepts.

---

## Gate 2 — run the import

```bash
curl -sk -X POST "https://127.0.0.1:5181/api/care/conrad/import?days=90"
```

The endpoint is authenticated like the rest of the API — use a session cookie or a configured
service token (`Auth:ServiceTokens:Tokens:*`). A `401` here is an auth problem, **not** an import
result.

Response shape:

```json
{ "read": 1243, "imported": 1243, "alreadyHad": 0, "skipped": 12 }
```

| Field | Means | Expected on a first run |
|---|---|---|
| `read` | calendar events the windows returned | several hundred to ~1,500 over 90 days |
| `imported` | rows written | on a first run, close to `read` minus `skipped` |
| `alreadyHad` | events already in the log | **0** on a first run |
| `skipped` | events the parser would not classify | small, non-zero is normal — see below |

**`skipped` is not a failure.** It counts events the parser refuses to guess at — a `🩺 Health` entry
that is not medication, or anything with no start time. The parser is deliberately built to
under-claim: a mystery row in a child's medical log is worse than a visible gap.

---

## Gate 3 — the import is idempotent

**Run the exact same command a second time.**

```json
{ "read": 1243, "imported": 0, "alreadyHad": 1231, "skipped": 12 }
```

**`imported` must be 0 and `alreadyHad` must be non-zero.** Anything else means the dedupe key is not
holding and the log is accumulating duplicates.

This matters more than it looks. Huckleberry's calendar events carry a `uid` field and it is **null
on every single one**, so there is no vendor identifier — the key is synthesised from child, type and
the instant, and enforced by a filtered unique index. If this gate fails, do not run the import
again; report it.

---

## Gate 4 — the rows are really in the database

Read it from SQL, not from the API that just wrote it.

```sql
-- Connection string: ConnectionStrings__HomeHub in the service's environment file.
SELECT Type, Source, COUNT(*) AS Rows, MIN(AtUtc) AS Earliest, MAX(AtUtc) AS Latest
FROM CareEntries
WHERE ChildKey = 'conrad'
GROUP BY Type, Source
ORDER BY Type;
```

`Type` and `Source` are stored as integers:

| Type | 0 Bottle · 1 Nursing · 2 Pump · 3 Diaper · 4 Solids · 5 Sleep · 6 Medicine · 7 Bath · 8 TummyTime · 9 Temperature · 10 Growth |
|---|---|
| **Source** | **0 Panel · 1 HuckleberryImport** |

### What a correct result looks like

**Five types should have imported rows, and five should have none.**

| Type | Expect after import | Why |
|---|---|---|
| Bottle (0) | hundreds | `Bottle feeding: 4 oz` + `Type: Breast Milk` |
| Nursing (1) | ~100 | `Feeding - Total: 7 min 22 sec` + `Left:` |
| Diaper (3) | ~250 | kind, and colour/consistency on poo |
| Sleep (5) | a handful | `Sleep duration: 56m` |
| Medicine (6) | tens | `Health entry: medication` |
| **Pump (2), Solids (4), Bath (7), TummyTime (8), Temperature (9)** | **zero** | **Correct.** The integration has no service and no sensor for these, so there is nothing upstream to import. They fill only as the household logs them on the panel. |

**Five empty types is a pass, not a failure.** If they are non-zero, something has invented data.

### Spot-check the parsing, not just the counts

```sql
SELECT TOP 5 AtUtc, Amount, Unit, Kind FROM CareEntries
WHERE ChildKey='conrad' AND Type=0 ORDER BY AtUtc DESC;   -- bottles

SELECT TOP 5 AtUtc, DurationMinutes, Side FROM CareEntries
WHERE ChildKey='conrad' AND Type=1 ORDER BY AtUtc DESC;   -- nursing

SELECT TOP 5 AtUtc, Kind, Color, Consistency FROM CareEntries
WHERE ChildKey='conrad' AND Type=3 AND Kind='poo' ORDER BY AtUtc DESC;
```

Pass conditions:

- **Bottles** carry a real `Amount` (2.0–4.0 typical), `Unit = 'oz'`, `Kind = 'breast_milk'` — the
  enum spelling, not the display form `Breast Milk`.
- **Nursing** carries `DurationMinutes` as a decimal (`7.37`, not `7`) and `Side` of `left`/`right`.
- **Poo diapers** carry `Color` and `Consistency` where the description had them.
- **Medicine** carries `Kind = NULL` and `Amount = NULL`, with the raw line in `Notes`. **This is
  correct** — the calendar records that a dose was given and nothing else. Inventing a medicine name
  in a child's medical record would be worse than a blank.
- **No row** has `Amount = 0` where nothing was measured. Null and zero are different facts here.

### Cross-check against the source

```sql
SELECT COUNT(*) FROM CareEntries WHERE ChildKey='conrad' AND Source=1
  AND AtUtc >= DATEADD(day,-30,GETUTCDATE());
```

Compare with Gate 1's 30-day count. Imported rows should be **Gate 1 minus the skipped health
entries** — roughly 400 against 426. A large shortfall means the parser is rejecting things it
should be reading; report the summaries it skipped.

---

## Gate 5 — the panel reads it back

```bash
curl -sk "https://127.0.0.1:5181/api/care/conrad/summary"
```

`lastByType` should carry the newest entry for each of the five imported types. This is what fills
the tile captions and every sheet's pre-fill, so if the rows are in SQL but absent here, the problem
is the read path rather than the import.

On the panel: **Care → Conrad**. The SINCE rows should show real elapsed times and the tiles should
show real values rather than `No record`.

---

## Failure modes, and what each one means

| Symptom | Meaning | Action |
|---|---|---|
| `401` on the import | authentication, not import | supply a session or service token |
| `read: 0`, no error | Home Assistant unreachable, or the entity name is wrong | check Gate 1; the entity is `calendar.{childKey}_events` |
| `read: 0` and the log says *"no Home Assistant to read from"* | the panel has no HA configured | expected on a panel without it; not a fault |
| `imported` = 0 on a **first** run with `read` > 0 | everything was skipped | report the calendar summaries; the parser is refusing to classify |
| `imported` > 0 on a **second** run | **dedupe is broken** | stop; do not re-run |
| Rows in types 2, 4, 7, 8, 9 | data has been invented | stop and report |
| `skipped` roughly equals `read` | classification is failing wholesale | report sample summaries |

Server-side detail is logged at Information:

```bash
journalctl -u homehub-test | grep -i "Care import"
# Care import for conrad: read 1243, imported 1231, already had 0, skipped 12.
```

---

## Limits — what a pass does *not* prove

Stated plainly so a green run is not over-read:

1. **90 days is the ceiling, and it is not ours.** Home Assistant's recorder retention
   (`purge_keep_days`) is 90. Anything older is not in the calendar and this route cannot reach it.
   Asking for `days=400` returns nothing older; it does not fail, it simply finds nothing.
2. **Medicine arrives without name or dose.** The calendar does not carry them.
3. **Parsing vendor prose is lossy.** The raw summary and description are kept in `Notes` on every
   imported row, so a line read badly today can be re-read by a better parser later without another
   trip upstream.
4. **Five types genuinely start empty** and will stay empty until logged on the panel.
5. **This proves the pull, not the completeness of the household's records.** Whatever they logged in
   a different app, on paper, or not at all, is not here — and never was.

---

## If it passes

The import can be re-run at any time, as often as wanted; it is designed to be. The honest way to use
it is to press **Pull from Huckleberry** on the panel whenever the household wants to catch up,
rather than tracking what was fetched last time.

Nothing further is required upstream. The panel writes to HomeHub from here on.
