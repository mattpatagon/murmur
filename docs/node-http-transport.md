# HTTP transport and native buffering

Hosted HTTP uses Bun's `node:http` compatibility transport around the unchanged Web
`Request -> Promise<Response>` router. Startup remains asynchronous. Stdio does not use this
transport or its admission limits. No additional package, sidecar, or runtime is required.

## Output backpressure and cancellation

The output pump writes at most 32 KiB at a time. A false `ServerResponse.write` result must be
followed by `drain` before another write, source read, or end. This keeps the JavaScript response
lifecycle connected to native output pressure. A finish event is not proof the remote client read
the response; kernel buffers and intermediary proxies remain separate.

Bun 1.3.14 automatically destroys completed request input and clears a native callback shared with
the unfinished response. A narrowly scoped IncomingMessage subclass defers successful automatic
input destruction until output settlement. Successful response cleanup does not forcibly destroy
unfinished input: on this Bun revision that resets the socket even after the local response end
callback and can discard an early 401/503 response. The already-required `Connection: close`
response owns native delivery and closure, without waiting for or parsing the remaining upload.
Explicit aborts and errors still destroy immediately. Peer disconnect aborts the Web Request and
cancels response readers and drain waits.
Underlying authentication and MCP handler reservations still last until actual work settles.

Application-response cancellation, fixed-error rejection delivery, and server shutdown have bounded
cleanup. A failure after headers are sent closes the response; it never appends internal exception
text. Before headers are sent, unexpected failures use a fixed internal-server-error response.

## Input staging

Request dispatch does not await the body or authentication. Opaque native chunks flow into one
shared 8 MiB staging budget, using coalesced 4 KiB blocks reserved before allocation. This bounds
both retained queue bytes and tiny-chunk object counts. Staging does not parse JSON or authenticate
credentials. Web-body delivery uses zero prefetch and begins only on application demand.

The listener activates the public native readable interface synchronously with `read(0)` after
attaching its byte listener. It does not rely on paused native buffering: Bun 1.3.14 intentionally
does not pause the Windows socket in that path. Direct cleartext native receive calls are bounded
to a shared 512 KiB buffer in the pinned source. Staging owns copies, not views retaining arbitrary
larger callback backing buffers. The staging budget excludes transient native callbacks and bytes
already transferred to the separately bounded application reader; it is not an exact RSS cap.

Transport ingress ceilings match the existing route readers:

| Route | Maximum body bytes |
|---|---:|
| `/mcp` | `MURMUR_MAX_REQUEST_BYTES` (default 1 MiB) |
| `/v1/tenants` | Smaller of configured MCP limit and 4 KiB |
| `/setup/mcp`, `/oauth/token` | 8 KiB |
| Other routes | Smaller of configured MCP limit and 8 KiB |
| GET/HEAD | No request body |

Existing application deadlines remain: 10 seconds for MCP, registration and OAuth body readers;
5 seconds for setup. An outer 15-second input lifetime also bounds stalled uploads while
authentication or other application work is pending. This does not impose a 15-second response
timeout on legitimate long polls or SSE streams.

Malformed metadata or framing returns fixed HTTP 400; excessive bodies return 413 (OAuth token
forms preserve their existing HTTP 400 `invalid_request` contract); staging or
transport-task saturation returns retryable 503 (`Retry-After: 1`); the outer input deadline
returns 408. A request canceled during authentication returns fixed HTTP 408 after authentication
actually settles, without subsequently parsing its body. The already-sent transport rejection
remains authoritative. Early errors close the connection after bounded delivery (one second),
without waiting for the remaining upload. Response-reader and forced-server cleanup use two seconds.

MCP authentication and request admission still precede application body parsing. OAuth's bounded
form-before-authentication behavior remains unchanged. `Expect: 100-continue` is acknowledged only
when the application first consumes its Web body; authentication rejection does not invite upload.

## Listener and platform boundary

Native header parsing is capped at 16 KiB, requires Host, and uses strict method validation.
Metadata rejects duplicate security-sensitive headers and ambiguous body framing. Forwarded Host
and protocol headers never determine a trusted origin. OAuth uses `MURMUR_PUBLIC_ORIGIN` as before.

There are at most 256 active transport tasks and 256 observed connection wrappers. Closed wrappers
are reaped using their public address state because Bun can omit their close event after a completed
keep-alive response. These are **not** claims of a 256-socket limit before HTTP headers: Bun emits
its public connection event only after parsing a request or reporting a parser error.

The native idle timeout is explicitly 60 seconds, compatible with Murmur's one-second SSE
keep-alives. The pinned native timeout scheduler has coarse granularity; this is not an absolute
header deadline. Merely assigning Node `headersTimeout`, `requestTimeout`, or socket `setTimeout`
does not establish enforcement in this Bun revision. Direct self-hosting needs an upstream
connection/header boundary when exposure to untrusted raw TCP peers matters.

Production is a Cloud Run **service**, not a worker pool with direct TCP ingress. The checked
deployment workflow configures HTTP concurrency 80, one vCPU, 512 MiB, service and revision maximum
one instance, port 8080, and request timeout 3,600 seconds. Both deployment paths explicitly disable
end-to-end HTTP/2 with `--no-use-http2`, so an older service setting cannot select an incompatible
backend protocol. Public clients can still negotiate HTTP/2 with the managed frontend.

Cloud Run terminates public TLS and proxies HTTP requests to the container. Its security architecture
places a Google frontend and HTTP proxy before sandbox instances. Therefore internet TCP/TLS
connections are not directly Bun listener connections. The platform documents configured maximum
request concurrency, but not a numerical idle-backend-connection or backend-header-assembly limit.
This hosted design relies on that managed frontend boundary; it does not invent stronger guarantees.
Cloud Run's HTTP/1 request limit is 32 MiB and its HTTP/1 inbound request-rate limit is 800 requests
per second per instance. The documented 50,000 open-connection limit is for egress, not an inbound cap.

Primary references:

- [Cloud Run container contract](https://docs.cloud.google.com/run/docs/container-contract)
- [Cloud Run security architecture](https://docs.cloud.google.com/run/docs/securing/security)
- [Cloud Run concurrency](https://docs.cloud.google.com/run/docs/about-concurrency)
- [Cloud Run quotas](https://docs.cloud.google.com/run/quotas)
- [Pinned Bun receive buffer](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/packages/bun-usockets/src/libusockets.h)
- [Pinned Bun receive loop](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/packages/bun-usockets/src/loop.c)
- [Pinned Bun HTTP compatibility layer](https://github.com/oven-sh/bun/blob/0d9b296af33f2b851fcbf4df3e9ec89751734ba4/src/js/node/_http_server.ts)

Every Bun upgrade must recheck the native callback, pause, drain, and disconnect assumptions using
the transport regressions and the bounded slow-reader memory gate on the release build. Linux
native-memory measurements are not Windows execution evidence; the portability matrix remains
required for the application and HTTP behavior on Linux, macOS, and Windows.
