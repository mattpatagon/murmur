@AGENTS.md

# Project notes

Follow `AGENTS.md` as the authoritative repository contract. Before editing, inspect the working
tree and use Murmur to coordinate overlapping work. Do not weaken the strict type, lint, coverage,
500-line, dependency, security, portability, or redaction gates.

## Deploy Configuration (configured by /setup-deploy)

- Platform: Google Cloud Run through GitHub Actions
- Production URL: https://api.usemurmur.dev
- Deploy workflow: `.github/workflows/deploy.yml` on every push to `main`
- Deploy status command: `gh run list --workflow "Deploy production" --limit 1`
- Merge method: squash
- Project type: MCP API service
- Post-deploy health check: https://api.usemurmur.dev/health
- CI migrations/tests use the IPv4 Supabase session-pooler secret
  `MURMUR_CI_DATABASE_URL`; Cloud Run uses `MURMUR_DATABASE_URL`.

### Custom deploy hooks

- Pre-merge: `bun run test && bun run build:http`
- Deploy trigger: automatic on push to `main`
- Deploy status: poll the `Deploy production` GitHub Actions workflow
- Health check: https://api.usemurmur.dev/health

## Design System

Read `DESIGN.md` before making visual or UI decisions. It defines the institutional website's
typography, colors, spacing, interaction, content, and accessibility contract. Check the rendered
site against it during QA. Update the design contract when an authorized product change requires it.
