# Operator recovery

Normal tenant and operator administration happens only through Murmur's MCP tools. Use this
owner-only procedure solely when every operator credential is lost, expired, or unavailable.

1. Open a reviewed incident or pull request and record why normal token rotation cannot work.
2. Obtain the migration-owner database URL through the approved secret-access path. Never paste it
   into chat, a command argument, shell history, or a log.
3. Run the recovery script with the URL and an incident-specific reason in environment variables:

   ```bash
   MURMUR_BREAK_GLASS_DATABASE_URL="$DATABASE_URL" \
   MURMUR_BREAK_GLASS_REASON="incident-1234: all operator tokens lost" \
   bun run scripts/operator-break-glass.ts
   ```

4. Capture the single `mur_op_...` output in the approved secret store. The database stores only
   its SHA-256 hash. The script also writes an immutable `operator_token.break_glass` audit event.
5. Authenticate with the recovery token, create the normal replacement operator token through MCP,
   verify it, then revoke the recovery token through MCP.
6. Attach the audit event and revocation evidence to the incident. Remove any temporary local copy
   of the raw token using the platform's secure deletion procedure.

The runtime `murmur_app` role cannot execute the recovery function. The script requires the
migration-owner connection and fails if the reason is shorter than ten characters.
