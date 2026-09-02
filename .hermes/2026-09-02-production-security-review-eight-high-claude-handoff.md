# Production security review: eight High findings — Claude remediation handoff

**From:** Geist, independent production reviewer
**To:** Claude Code, application owner
**Date:** 2026-09-02
**Verdict:** **FAIL CLOSED — 0 Critical, 8 High**
**Production status:** unchanged; do not promote this candidate

This is the authoritative remediation handoff for the fresh complete-source review. It does not replace the historical review record in `2026-09-01-five-high-source-findings.md`; it distinguishes that earlier set from the new findings so the reused H-labels cannot be mistaken for closure.

## Preconditions — verify before edits; stop and report if any fails

- [ ] Work in `/srv/dev/homehub` on `main`.
- [ ] Expected starting repository state is commit `d6f1540db745617883d3a6cead87a2ce0a859415` or a clean descendant that explicitly carries this handoff.
- [ ] The reviewed application/deployment bytes remain those from commit `e11f74fafe62213226e14af7dfa38dcc0cc43ce3`. At handoff creation, `e11f74f` was an ancestor of `d6f1540`, and the only intervening paths were `brain/DEPLOYMENT.md` and `brain/STATE.md`; every cited code/config file was byte-identical.
- [ ] Inventory concurrent changes before editing. Do not reset, clean, blanket-stage, or disturb unrelated work.
- [ ] Preserve `.gitignore` and repository ownership/modes.
- [ ] Do not deploy. Claude owns remediation and development verification; Geist owns independent review and deployment.

If any precondition fails, return one evidence-backed discrepancy report rather than adapting this handoff to an unverified target.

## Exact reviewed candidate

| Item | Identity |
|---|---|
| TEST release | `20260902T041152Z-620d8f13f2ca` |
| Source commit | `e11f74fafe62213226e14af7dfa38dcc0cc43ce3` |
| Source-tree SHA-256 | `620d8f13f2ca863c0025f768f959a3fc8ccb04252f7a6fd5b10e3dc185347218` |
| Artifact SHA-256 | `e9e7b563c3cb3bc814bddd7c387609ca84f360c52cb885d12eb8d64057a18a6d` |
| Source coverage | 1,084 paths: 951 UTF-8 text, 133 inventoried binary, 0 decode failures |
| Artifact coverage | 475 members; no unsafe path, link, device, FIFO, setuid/setgid, or world-writable entry |
| Review mutation | None; source hash matched before and after review |

Independent baseline evidence on these exact bytes:

- Typecheck and lint passed.
- Client tests: 50/50 files passed.
- Backend tests: 1,157/1,157 passed.
- npm production audit: 0 vulnerabilities.
- NuGet vulnerable-package scan: no vulnerable packages reported.
- TEST service, HTTPS, database deep health, and migration state passed; pending migrations: 0.
- Anonymous picker returned exactly `id`, `name`, `initial`, and `hasPin`.

These results are valuable regression baselines; they do not clear the source findings below.

## Why “H1–H5 remediated” did not clear this review

Two different sets reused H-style labels:

1. **Original five-source-finding set** in `2026-09-01-five-high-source-findings.md`:
   - original H1: tool-capable image extractor;
   - original H2: stale authorization after profile demotion/deletion;
   - original H3: lock/provider execution boundary;
   - original H4: HomeHub HTTPS SAN/trust-chain validation;
   - original H5: legacy broad MCP credential.
2. **Later private-network-boundary implementation labels** in `2026-09-01-private-network-boundary-claude-handoff.md`: H1 device-only Care subtree, H2 request subject/epoch/drain, H4 centralized 401 handling, and H5 minimal picker. Those labels are not the original H1–H5 finding IDs.

The fresh review accepted real progress. Original H1, H2, H4, and H5 have no matching reopened source finding here. The structural portion of original H3 and the later device-only/minimal-picker work also passed. The review nevertheless found narrower races and persistence boundaries not proved by that work, plus two unrelated production/privacy defaults.

### Reconciliation table

| Fresh finding | Relationship to original H1–H5 | Relationship to later private-boundary labels | Classification |
|---|---|---|---|
| HH-01 | Follow-on within original H3’s identity-transition intent | Later H2 drain is incomplete at response headers | Incomplete boundary |
| HH-02 | Follow-on within original H3’s identity-transition intent | Later H2 lacks stale-refresh invalidation | Incomplete boundary |
| HH-03 | Follow-on within original H3’s revocation/transition intent | Later H4 misses raw queue and over-exempts PIN routes | Incomplete boundary |
| HH-04 | No direct original mapping; adjacent to original H3 offline ownership | Not addressed | New finding |
| HH-05 | No direct original mapping; adjacent to original H3 offline ownership | Not addressed | New finding |
| HH-06 | No direct original mapping; adjacent to original H3 local lock | Not addressed | New finding |
| HH-07 | Not original H4: this is **SQL Server TLS**, not HomeHub HTTPS | No mapping | New finding |
| HH-08 | No prior mapping | No mapping | New finding |

Do not “fix H1–H5 again.” Preserve the portions already satisfied and resolve the eight exact findings below.

## Required remediation

### HH-01 — Authenticated responses leave transition tracking before bodies are consumed

**Severity:** High
**Owner/status:** Claude Code — open; Geist — re-review required

**Verified evidence**

- `client/src/api/privateNetwork.ts:241-289`: `authorizedFetch` removes the request from `inFlight` and settles its drain promise when `fetch()` returns response headers.
- `client/src/api/client.ts:237-252`: ordinary response bodies are read and parsed only after `authorizedFetch` has returned.
- `client/src/api/client.ts:362-424`: the Assist response stream is consumed after transport tracking has ended.

**Exploit/failure sequence**

1. Profile A begins an authenticated JSON response or Assist stream.
2. Headers arrive, so the request is declared settled.
3. Lock, sign-out, revocation, or switch to profile B drains successfully and changes identity.
4. Profile A’s body/stream continues to be consumed and can settle into new-session state.

**Security consequence:** old-identity private data or effects can outlive the transition that was supposed to revoke them.

**Required behavior**

- Track the full authenticated operation through body/stream consumption and all consequential settlement, not merely the header fetch.
- A transition must abort and await that complete lifetime before cookie/identity replacement.
- Revalidate subject and epoch at the last point before data becomes observable or persistent.
- Preserve caller cancellation and deadlines.

**Automated acceptance**

- Suspend an ordinary body after headers; begin profile switch; prove the switch cannot finish and the old result cannot settle.
- Repeat for Assist streaming and cancellation.
- Prove abort rejection unwinds fully, with zero tracked operations, before the new identity opens.

**Manual/fail-closed validation:** instrument a delayed body/stream in a browser, switch profiles while suspended, and demonstrate no old-profile content, event, or persistence appears after the transition.

---

### HH-02 — Stale session refreshes can reopen a closed identity boundary

**Severity:** High
**Owner/status:** Claude Code — open; Geist — re-review required

**Verified evidence**

- `client/src/app/SessionProvider.tsx:235-305`: `refresh` captures `locked`, awaits session reads, then calls `confirmIdentity(locked, session.profileId)` without binding completion to a transition epoch.
- `client/src/app/SessionProvider.tsx:307-344`: locking closes the request boundary but does not invalidate an already-running refresh completion.

**Exploit/failure sequence:** a refresh starts while unlocked, lock/sign-out/switch closes the boundary, then the stale refresh resumes and reopens it from obsolete state.

**Security consequence:** private requests can resume under a session the panel has already revoked.

**Required behavior**

- Bind every refresh/confirmation to the current transition generation and expected subject.
- Invalidate outstanding refreshes synchronously at transition start.
- Reject obsolete completions after lock, sign-out, session loss, profile switch, and unmount.
- Do not solve this with closure timing assumptions.

**Automated acceptance:** suspend `getSession`, trigger each transition, release the stale response, and prove the boundary remains closed, the old subject cannot be confirmed, and no private request starts. Use pure coordination logic/injected promises if the existing Node Vitest harness cannot render the provider.

**Manual/fail-closed validation:** delayed session response during lock and profile switch; boundary instrumentation must show no reopen until a fresh post-transition confirmation succeeds.

---

### HH-03 — Not every authenticated 401 closes the session boundary

**Severity:** High
**Owner/status:** Claude Code — open; Geist — re-review required

**Verified evidence**

- `client/src/app/writeQueue.ts:303-330,476-480`: raw authenticated replay treats 401 as an error/break without announcing session loss.
- `client/src/api/privateNetwork.ts:45-71`: all 401 responses from profile PIN PUT/DELETE operations are exempted as authentication attempts.

**Exploit/failure sequence:** an expired/revoked cookie is first discovered by queued replay or a PIN-management route; the transport does not emit session loss, leaving private state mounted.

**Security consequence:** the panel can remain unlocked after server-side authentication is gone.

**Required behavior**

- Put every authenticated HomeHub transport under one session-loss decision.
- Distinguish expected wrong-credential rejection from lost-session rejection by a sound server/client contract; do not broadly exempt authenticated PIN-management routes by path and method alone.
- Preserve queued operations on refusal and stop replay under the rejected identity.

**Automated acceptance**

- Raw queue replay returning 401 announces session loss exactly once and retains the operation.
- Expired-session 401 on PIN PUT/DELETE announces loss.
- A genuine wrong-PIN authentication attempt does not create a false session-loss transition.
- Assist, TTS, ordinary JSON, queue replay, and profile security operations share the same proven policy.

**Manual/fail-closed validation:** revoke the active cookie/server security version, make each transport the first failing call, and verify immediate lock with no continuing private activity.

---

### HH-04 — Generic durable write queue stores private care payloads in plaintext

**Severity:** High
**Owner/status:** Claude Code — open; Geist — re-review required

**Verified evidence**

- `client/src/app/writeQueue.ts:106-139`: complete queued operations are serialized directly into `localStorage`.
- Private Care operations use the generic durable queue and include household record bodies.

**Security consequence:** private care content remains directly readable from browser persistence after lock, sign-out, restart, or another profile’s use of the shared device.

**Required behavior**

- Encrypt and authenticate every persisted private operation with an owner-bound durable key.
- Partition records by confirmed owner and refuse decrypt/replay under another owner.
- Preserve write-ahead durability, replay ordering, conflict semantics, retry policy, and transition drain behavior.
- Define migration for existing plaintext entries: fail closed. Do not replay ambiguous/unowned plaintext as private writes.
- If non-private operations remain plaintext, enforce an explicit allowlist; private is the default.

**Automated acceptance**

- Persisted bytes contain none of the Care body’s distinctive plaintext fields/values.
- Wrong owner/key cannot read or replay and does not destroy the rightful owner’s data.
- Lock/restart/delayed reconnection retains authorized data and ordering.
- Legacy plaintext private entries are quarantined or safely discarded according to a documented migration, never silently replayed.

**Manual/fail-closed validation:** inspect browser storage after offline Care writes and prove only ciphertext plus non-sensitive routing metadata is visible.

---

### HH-05 — No-PIN profiles persist private care data in a plaintext vault

**Severity:** High
**Owner/status:** Claude Code — open; Geist — re-review required

**Verified evidence**

- `client/src/app/SessionProvider.tsx:500-514`: profiles without a PIN open the Care vault using `{ kind: 'plaintext' }`.

**Security consequence:** a no-PIN profile’s private offline Care record is directly readable from browser persistence and is not protected by the owner-bound encrypted-vault claim.

**Required behavior — Claude must document the selected policy**

Choose and implement one fail-closed design:

1. Encrypt with a per-profile device/OS-backed key that is not stored beside the ciphertext in trivially equivalent plaintext form; or
2. Make no-PIN private offline state memory-only and explicitly accept/document loss on restart.

Do not retain plaintext durable private records. Coordinate this design with HH-04 so queue and vault do not create contradictory protection levels.

**Automated acceptance:** no-PIN persisted bytes disclose no Care content; profile B cannot open profile A’s data; restart behavior matches the selected policy; migration of existing plaintext data is explicit and safe.

**Manual/fail-closed validation:** browser-storage inspection and cross-profile/restart exercise on the kiosk profile.

---

### HH-06 — Offline mode disables the configured idle privacy lock

**Severity:** High
**Owner/status:** Claude Code — open; Geist — re-review required

**Verified evidence**

- `client/src/app/SessionProvider.tsx:667-691`: `lockNow()` returns without locking whenever the server is offline.

**Security consequence:** loss of connectivity can leave decrypted private Care data visible indefinitely on a shared panel despite `requirePinWhenIdle`.

**Required behavior**

- Idle lock remains a local privacy boundary and must operate without server connectivity.
- Offline unlock may expose only the intended owner’s locally protected offline surface; it must not open authenticated networking until server confirmation.
- Reconnect must not silently promote device-only trust to server-confirmed trust.
- Define fail-closed behavior if no safe offline unlock proof is available.

**Automated acceptance:** configured timeout locks while offline; wrong profile/PIN cannot reopen owner data; restart and reconnect preserve the three-state boundary; stale refreshes cannot reopen it (coordinate HH-02).

**Manual/fail-closed validation:** disconnect network, wait through idle timeout, unlock through the supported local path, reconnect, and verify no private network call occurs before fresh confirmation.

---

### HH-07 — Production bootstrap disables SQL Server certificate identity validation

**Severity:** High
**Kind:** deployment/bootstrap source, not HomeHub HTTPS
**Owner/status:** Claude Code owns source/template remediation; Geist re-reviews production semantics

**Verified evidence**

- `deploy/bootstrap-server.sh:191-194`: the template supports a remote SQL host while emitting `TrustServerCertificate=True`.

**Security consequence:** a redirected/intercepted SQL endpoint can be accepted without certificate identity validation, exposing database credentials and traffic.

**Required behavior**

- Production defaults to encrypted, hostname-validated SQL with a trusted certificate chain.
- `TrustServerCertificate=True` may exist only behind an explicit, verified loopback-only mode if retained at all; arbitrary host input must never use it.
- Document SQL certificate/hostname prerequisites without embedding credentials.
- Keep DEV convenience separate from production safeguards.

**Automated acceptance:** production configuration rejects missing encryption, disabled validation, hostname mismatch, and a trust-server-certificate connection to a non-loopback host; valid trusted SQL configuration passes.

**Manual/fail-closed validation:** run bootstrap/config validation with representative valid and invalid host/certificate combinations without printing secrets.

---

### HH-08 — Local STT failure sends household voice audio to cloud by default

**Severity:** High
**Owner/status:** Claude Code — open; Geist — re-review and production-config verification required

**Verified evidence**

- `src/HomeHub.Api/appsettings.json:40-46`: `AllowCloudFallback` defaults to `true`.
- `src/HomeHub.Api/Ai/VoiceOptions.cs:109-126`: the options-class default is also `true`.
- `src/HomeHub.Api/Ai/SttRouter.cs:38-82`: after local failure, buffered household audio is replayed to the cloud provider when fallback is allowed.

**Security consequence:** an ordinary local STT outage silently changes the privacy boundary and exports household speech to a third party without explicit deployment opt-in.

**Required behavior**

- Default cloud STT fallback to off, including options-object defaults and shipped configuration.
- Under deployment safeguards, cloud audio egress requires an explicit protected opt-in; absence/invalid value must fail closed or remain local-only.
- Expose the active local/cloud boundary clearly to the operator and user; do not rely only on a post-response engine label.
- Preserve explicit cloud-first operation only when deliberately configured.

**Automated acceptance:** local failure with default/missing fallback setting never invokes cloud; explicit opt-in permits fallback and reports cloud use; invalid production configuration cannot enable fallback accidentally.

**Manual/fail-closed validation:** make local STT unavailable in TEST, submit non-sensitive sample audio, and prove there is no cloud request until explicit opt-in is supplied.

## Implementation order and coupling

1. **Settle the offline key/storage design first:** HH-04 and HH-05 must use one coherent owner-bound model; HH-06 depends on that model for safe offline unlock.
2. **Repair transition ownership atomically:** HH-01, HH-02, and HH-03 must share one lifecycle/session-loss contract. Do not land a queue-only or stream-only exception.
3. **Correct independent production defaults:** HH-07 and HH-08.
4. Run focused tests during each change, then the full existing gate.
5. Update this document with a remediation matrix: finding, changed files, commit, focused tests, and any settled policy decision. Do not mark Geist re-review complete.

## Required development evidence from Claude

For each finding, provide:

- exact changed files and commit(s);
- root-cause explanation and why the mechanism covers all callers;
- focused regression-test names and observed output;
- migration/backward-compatibility behavior where persistence changes;
- browser/manual evidence requested above;
- any intentionally retained risk, with an explicit request for a decision rather than an implicit waiver.

Then run from the repository owner account:

```text
./scripts/check.sh all
```

Expected baseline must not drop below 50 client test files or 1,157 backend tests. Increases are expected. Any count drop is a failed gate until reconciled by file-level inventory.

## Out of scope / preserve

- Preserve the minimal anonymous picker: `id`, `name`, `initial`, `hasPin` only.
- Preserve per-request profile security-version validation and deleted/demoted-profile revocation.
- Preserve production HomeHub HTTPS SAN/custom-root validation.
- Preserve named MCP credential/method restrictions in application source.
- Preserve isolated production image extraction safeguards.
- Do not relabel or mutate the immutable TEST manifest.
- Do not deploy, rotate production credentials, change production configuration, or render a production installer.

## Operational gates after remediation

The current archive remains `target_environment=test`, `test_only=true`, and `production_eligible=false`; this is an operational boundary, not a ninth source vulnerability. Source changes will produce new bytes, so Geist must:

1. inspect the resulting clean authoritative commit;
2. build/package it in isolation;
3. promote the exact new artifact to TEST;
4. verify TEST and production isolation;
5. independently re-review the immutable candidate, requiring 0 Critical and 0 High;
6. verify production MCP/SAN/CA and SQL/STT configuration without exposing secrets;
7. render and independently review a checksum-pinned installer for those exact bytes;
8. obtain Allan’s explicit production approval before any privileged production action.

## Closure rule

Claude may mark implementation and development tests complete. Only Geist may mark independent re-review complete. Production remains blocked until the newly built exact candidate has **zero unresolved Critical and zero unresolved High findings** and every operational gate passes.
