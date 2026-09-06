#!/usr/bin/env bash

set -euo pipefail

readonly cutover_deadline=$((SECONDS + 90))

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

bounded_command() {
  local remaining=$((cutover_deadline - SECONDS - 1))
  if [ "$remaining" -le 0 ]; then return 124; fi
  if [ "$remaining" -gt 30 ]; then remaining=30; fi
  timeout --signal=TERM --kill-after=1s "${remaining}s" "$@" 2>/dev/null
}

for required_tool in gcloud curl timeout; do
  if ! command -v "$required_tool" >/dev/null 2>&1; then
    fail 'Revision preservation requires gcloud, curl, and timeout'
  fi
done
if [[ ! ${PROJECT_ID:-} =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] ||
  [[ ! ${REGION:-} =~ ^[a-z]+(-[a-z]+)+[0-9]+$ ]] ||
  [[ ! ${SERVICE:-} =~ ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
  [[ ! ${PRODUCTION_URL:-} =~ ^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?/?$ ]]; then
  fail 'Revision preservation has invalid deployment configuration'
fi
case "${TENANT_CONTRACT_FINALIZE_REQUIRED:-}" in
  true|false) ;;
  *) fail 'Revision preservation requires an explicit tenant contraction state' ;;
esac

if ! latest_revision="$(bounded_command gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format 'value(status.latestReadyRevisionName)')"; then
  fail 'Cloud Run ready revision lookup failed'
fi
if [[ ! "$latest_revision" =~ ^[a-z][a-z0-9-]{0,62}$ ]] ||
  [[ "$latest_revision" != "$SERVICE-"* ]]; then
  fail 'Cloud Run did not report a valid ready revision for this service'
fi
if ! bounded_command gcloud run services update-traffic "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --to-revisions "$latest_revision=100" \
  --clear-tags \
  --quiet >/dev/null; then
  fail 'Cloud Run traffic cutover failed; revision definitions were preserved'
fi
if [ "$TENANT_CONTRACT_FINALIZE_REQUIRED" = 'true' ]; then
  # The SDK applies --limit before its display filter; filtering can hide an older writer.
  if ! revision_inventory="$(bounded_command gcloud run revisions list \
      --project "$PROJECT_ID" \
      --region "$REGION" \
      --service "$SERVICE" \
      --limit 2 \
      --format 'value(metadata.name)' && printf '.')"; then
    fail 'Cloud Run retained revision lookup failed; tenant contraction cannot proceed'
  fi
  # Preserve trailing newlines so extra empty or malformed inventory rows cannot disappear.
  revision_inventory="${revision_inventory%.}"
  if [ "$revision_inventory" != "$latest_revision"$'\n' ]; then
    fail 'Tenant contraction requires independently verified writer drainage; retained revisions were not deleted'
  fi
fi
if ! bounded_command curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  "${PRODUCTION_URL%/}/health" >/dev/null; then
  fail 'Production health verification failed after traffic cutover'
fi
