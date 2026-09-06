# HTTP JSON structure limits

HTTP JSON bodies have two fixed limits in addition to their existing byte limits:

- At most 32 nested objects or arrays. A root container has depth 1; a root scalar has depth 0.
- At most 16,384 structural units across the complete request, including its MCP envelope.

These limits apply before `JSON.parse`, SDK request validation, or domain validation. They are
not configurable, even when `MURMUR_MAX_REQUEST_BYTES` is increased. A byte cap alone permits
many tiny containers or deeply nested metadata. The metadata schema's depth-5 refinement runs
after recursive JSON-value validation, so it cannot protect that earlier work.

## Routes and errors

| Route | Byte limit | JSON reader | Structural-limit response |
| --- | --- | --- | --- |
| Authenticated MCP | 1 MiB by default, configurable | `parseRequestBody` | HTTP 400: `The MCP request body must be valid JSON` |
| Tenant registration | Smaller of 4 KiB and configured MCP limit | `parseRequestBody` | HTTP 400: `Tenant registration body must be valid JSON` |
| Anonymous setup | 8 KiB | `readPublicSetupBody` | HTTP 400: `Setup body must be valid JSON within 8192 bytes and its deadline` |

Both readers use `src/http/bounded-json.ts`. Their existing byte checks, UTF-8 decoding policy,
body deadlines, abort behavior, safe error mapping, and request-capacity cleanup are unchanged.
Structural rejection does not dispatch a tool or call the registration service. Registration
still holds request capacity until its error response is consumed or canceled.

OAuth token requests use bounded URL-encoded forms, not JSON; their parsing is unchanged.
Local stdio input, stored JSON, response JSON, and distribution manifests do not use this guard.

## Accounting

The guard scans the decoded text once, without recursion or a second object tree. It tracks
whether it is inside a quoted string and whether the preceding backslash escapes the current
character. Punctuation and Unicode escapes inside strings do not count as structure.

Structural units are `1 + opening containers + commas + colons`, outside quoted strings.
For valid JSON, this conservatively bounds value nodes plus object keys. Empty containers
consume an extra unit; repeated object keys count even if native parsing would overwrite them.
A flat array containing 16,383 scalar values therefore exactly meets the unit limit.
Native `JSON.parse` still validates JSON grammar; the guard is not a replacement JSON parser.

The scan takes linear time in the bounded text length and constant auxiliary space. It does
not measure actual heap use, include string bytes in its node allowance, impose a separate
MCP batch-operation count, or establish an end-to-end memory or latency guarantee. Existing
byte, concurrency, application-data, and response limits remain necessary. Previously accepted
deep extension fields or unusually wide request batches can now receive the fixed HTTP 400.

## Compatibility and regression evidence

`test/http-json-structure.test.ts` checks both readers with 40 nested arrays in valid MCP JSON
below 300 bytes.
Both rejected-promise assertions failed against the original readers because parsing succeeded;
with the guard, spies verify rejection occurs before native parsing. No stack exhaustion is
required to reproduce the missing boundary.

Compatibility checks validate full tool requests using the actual domain and E2EE input schemas:

- Exact 16 KiB metadata containing 8,000 numeric values or 5,200 empty arrays, with legal
  per-container counts, plus a separate maximum-depth metadata case.
- An agent bundle containing 100 unique one-time prekeys and 100 sorted revocations, including
  maximum-length revocation reasons.
- Direct and staged broadcast requests with a 512 KiB padded envelope plus the 16-byte cipher
  overhead, still below the default HTTP byte cap.

These fixtures pass the fixed structural bounds. E2EE fixtures exercise wire schemas and
existing envelope fixtures, not cryptographic signature verification or a live upload.
Other tests cover exact depth/unit boundaries, quoted punctuation, escape sequences, invalid
grammar, public setup recovery, and registration service/rate/capacity isolation. Existing body
tests continue to cover streamed bytes, deadlines, aborts, and cleanup.
