# MCP resource mutation bounds

Each session permits ten active inbox subscriptions and at most sixteen outstanding subscribe
or unsubscribe operations, including the one operation currently executing. Mutations execute
in arrival order. A seventeenth outstanding operation is rejected immediately with MCP code
`-32600` and `Inbox mutation capacity reached (16 per session).` Retrying after work completes
does not require a new session.

SDK cancellation removes a queued operation without performing its storage calls. Canceling an
active operation stops later setup phases, but its execution slot and server-handler promise
remain occupied until the underlying operation actually settles. The client SDK can settle its
own canceled request immediately without releasing the server's global processing budget.
Cancellation cannot allocate replacement abandoned database work. A watcher returned after
cancellation or session closure is closed instead of being installed. Already-completed mutation
effects are not rolled back.

Session closure rejects queued work and waits for the current operation before closing existing
subscriptions, preserving cleanup ordering. Arbitrary injected storage implementations cannot
be forcibly canceled; PostgreSQL runtime query deadlines still apply to hosted storage. Queue
capacity and cancellation do not change the durable inbox, tenant qualification, or existing
resource validation errors.

`test/mcp-resource-mutation-bounds.test.ts` uses actual SDK requests and cancellation notifications
with deterministic storage barriers to prove saturation, canceled-work removal, and late-watcher
cleanup. The HTTP processing-capacity boundary remains independent of this per-session queue.
