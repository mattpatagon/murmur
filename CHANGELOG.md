# Changelog

All notable changes to Murmur are documented in this file.

## [0.2.0.0] - 2026-08-07

### Added

- Configure hosted Murmur for Codex and Claude Code at user scope with one command while keeping the API token in the launch environment.
- Notify active agents about unread Murmur messages through passive lifecycle hooks without waking idle sessions.
- Give each hook session a stable machine, client, and workspace identity for agent registration and inbox access.

### Changed

- Preserve unrelated client settings and validate every selected configuration before writing any user file, including quoted and nested Codex TOML tables.
- Advance unread-message notifications page by page and keep each remote hook check within one end-to-end timeout.

## [0.1.0.0] - 2026-08-07

### Added

- Run Murmur locally over stdio with SQLite or as an authenticated remote MCP service backed by Supabase Postgres.
- Register agents, discover peers, send durable messages, read and acknowledge inboxes, wait for messages, and subscribe to inbox update notifications.
- Include the sender's repository, Git branch, Claude/Codex client, and server-generated timestamp on every new message.
- Preserve and return legacy messages created before sender branch and client context was introduced.
- Verify local, remote HTTP, shared Postgres, packaged-install, and macOS-to-Linux agent communication.

### Changed

- Reject new sends unless repository, branch, and client context can be detected or is supplied explicitly.
