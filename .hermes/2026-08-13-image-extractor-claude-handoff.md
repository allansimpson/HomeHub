# Claude Code handoff — HomeHub image-extractor pipeline

**Date:** 2026-08-13  
**Decision:** use the existing, now-qualified `image-extractor` Hermes profile as an internal actionless vision service. HomeHub orchestrates it directly; Barnaby does not delegate to it.

**Qualification report:** `/srv/dev/homehub/.hermes/2026-08-13-image-extractor-qualified-claude-report.md`

## Inputs

The complete live-profile requirements are in:

```text
/srv/dev/homehub/.hermes/2026-08-13-image-extractor-profile-requirements.md
```

The proposed extractor persona is in:

```text
/srv/dev/homehub/.hermes/image-extractor-SOUL.md
```

The earlier Hermes contract analysis remains in:

```text
/srv/dev/homehub/.hermes/2026-08-13_185724-event-capture-hermes-questions.md
```

## Required topology

```text
user attaches image in Barnaby-facing UI
                ↓
HomeHub chooses a closed analysis mode
                ↓
HomeHub calls loopback image-extractor gateway directly
                ↓
vision model returns one untrusted JSON proposal
                ↓
HomeHub parses, bounds, and semantically validates mode-specific DTO
                ↓
HomeHub shows result/approval UI or safe bounded summary
                ↓
HomeHub deterministic domain code performs an approved side effect
```

Do not implement Barnaby → agent delegation. Do not give Barnaby the extractor API key, profile discovery, cross-profile sessions, or generic delegation. The extractor is not added to the user-selectable agent roster.

## HomeHub configuration

Add a server-side internal extractor endpoint with its own base URL and API key, following the existing closed agent-endpoint pattern but not the public/user-facing agent roster. Suggested environment shape (adapt to established option naming):

```text
ImageExtractor__BaseUrl=http://127.0.0.1:8644
ImageExtractor__ApiKey=<profile-unique key>
ImageExtractor__TimeoutSeconds=<bounded>
ImageExtractor__MaxConcurrent=2
```

Keep the key only in the ASP.NET environment file. Never send it to the client. Do not include model/provider/route fields in requests.

## Client/API pipeline

1. Keep existing upload validation and image normalization, but treat the 1600px edge as provisional until real-photo testing compares a higher-resolution option.
2. Select mode from trusted HomeHub workflow state (`event`, `document`, `receipt`, `object`, or `scene`), never from image text.
3. Send one non-streaming multimodal Chat Completions request to `image-extractor` with:
   - a short mode-specific instruction;
   - an explicit allowed JSON shape in prompt text;
   - the image part;
   - no `X-Hermes-Session-Key`;
   - no concrete model/provider/route;
   - no reliance on `tools: []` or `response_format` (both are ineffective controls on Hermes v0.20.0).
4. Capture `X-Hermes-Session-Id` from every response.
5. Parse one JSON object. Existing fence/prose tolerance may remain only as transport recovery.
6. Deserialize into a closed mode-specific DTO, discard unknown fields, apply length/count limits, and perform semantic validation.
7. Treat every extracted string as untrusted data. Never reinterpret it as an instruction, authorization, tool request, URL to fetch, or agent prompt.
8. Delete the exact Hermes session after safely receiving the result, including invalid/rejected result paths. Retry/monitor cleanup failures.
9. For event mode, populate the existing confirmation sheet. Only existing deterministic calendar code writes after explicit approval and with idempotency/audit.
10. If Barnaby should discuss a result, inject only the validated inert DTO or bounded summary into the HomeHub conversation; do not forward raw image instructions or arbitrary extractor prose.

## Recommended interface boundary

Use a narrow application service, e.g.:

```csharp
public interface IImageExtractionClient
{
    Task<ImageExtractionResult<T>> ExtractAsync<T>(
        ImageAnalysisMode mode,
        NormalizedImage image,
        CancellationToken cancellationToken);
}
```

The client owns HTTP authentication, timeouts, concurrency, response/session headers, parse diagnostics, and transcript cleanup. Mode-specific validators own semantic rules. Controllers should not know Hermes request details.

A result should distinguish at least:

- successful validated proposal;
- insufficient/unreadable image;
- malformed model output;
- semantic validation failure;
- extractor busy/unavailable;
- timeout/cancellation;
- transcript cleanup pending/failed.

A cleanup failure must not convert invalid output into valid output or trigger a side effect. It is an operational/privacy condition to retry and report.

## Tests required before production

Unit/contract tests:

- exact request omits model/provider/route and session key;
- mode cannot be selected by image content;
- parser rejects extra prose when recovery cannot isolate exactly one object;
- unknown properties discarded/rejected per DTO policy;
- sizes, dates, ordering, confidence, and warning rules enforced;
- instruction-like extracted strings remain inert;
- no side effect occurs before approval;
- idempotent approved event write;
- session deletion called on success, parse failure, validation failure, timeout-after-response, and cancellation where an ID exists;
- cleanup failure is recorded and retryable;
- 429/503 map to truthful busy behavior.

Integration tests against live extractor:

- authenticated identity is `image-extractor`;
- known image extraction;
- adversarial printed instruction;
- real angled/glare/dense-print photographs;
- ambiguous/missing date components;
- multi-event flyer;
- irrelevant and illegible images;
- no tool availability or calls;
- returned session can be deleted.

## Acceptance decision

The live extractor runtime passed its service-boundary and synthetic behavioral qualification on 2026-08-13: authenticated identity, inline event-image extraction, hostile-image instruction isolation, bounded JSON, and exact session deletion all passed. The detailed verified report and current implementation guidance are in:

```text
/srv/dev/homehub/.hermes/2026-08-13-image-extractor-qualified-claude-report.md
```

It is GO for HomeHub DEV/TEST integration. Production remains conditional on HomeHub implementing the closed DTO/semantic-validation/approval/idempotency/cleanup controls and passing the representative real-photo corpus. This preserves the user experience—Barnaby appears to help with the attached image—while keeping untrusted pixels away from Barnaby's write-capable tool context and leaving all authority with HomeHub validation, approval, and deterministic domain code.
