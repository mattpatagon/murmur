#!/usr/bin/env bash

set -euo pipefail

export LC_ALL=C
export GIT_NO_LAZY_FETCH=1
export GIT_NO_REPLACE_OBJECTS=1
export GIT_TERMINAL_PROMPT=0

readonly compatibility_floor='d89d405db3bc470bfe375abe7dfd474738b82607'
readonly preflight_deadline=$((SECONDS + 120))

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

bounded_command() {
  local remaining=$((preflight_deadline - SECONDS - 1))
  if [ "$remaining" -le 0 ]; then
    return 124
  fi
  if [ "$remaining" -gt 30 ]; then
    remaining=30
  fi
  timeout --signal=TERM --kill-after=1s "${remaining}s" "$@" 2>/dev/null
}

for required_tool in gcloud git head jq timeout; do
  if ! command -v "$required_tool" >/dev/null 2>&1; then
    fail 'Revision preservation preflight requires gcloud, git, head, jq, and timeout'
  fi
done

if [[ ! ${PROJECT_ID:-} =~ ^[a-z][a-z0-9-]{4,28}[a-z0-9]$ ]] ||
  [[ ! ${REGION:-} =~ ^[a-z]+(-[a-z]+)+[0-9]+$ ]] ||
  [[ ! ${ARTIFACT_REPOSITORY:-} =~ ^[a-z]([a-z0-9._-]{0,61}[a-z0-9])?$ ]] ||
  [[ ! ${SERVICE:-} =~ ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] ||
  [[ ! ${GITHUB_SHA:-} =~ ^[0-9a-f]{40}$ ]]; then
  fail 'Revision preservation preflight has invalid deployment configuration'
fi

readonly image_prefix="$REGION-docker.pkg.dev/$PROJECT_ID/$ARTIFACT_REPOSITORY/$SERVICE:"

if ! shallow_repository="$(bounded_command git rev-parse --is-shallow-repository)" ||
  [ "$shallow_repository" != 'false' ]; then
  fail 'Revision preservation preflight requires complete local Git history'
fi
for required_commit in "$compatibility_floor" "$GITHUB_SHA"; do
  if ! object_type="$(bounded_command git cat-file -t "$required_commit")" ||
    [ "$object_type" != 'commit' ]; then
    fail 'Revision preservation preflight cannot resolve its required source commits'
  fi
done

if ! revisions_json="$(
  bounded_command gcloud run revisions list \
    --project "$PROJECT_ID" \
    --region "$REGION" \
    --service "$SERVICE" \
    --limit 1001 \
    --format 'json(spec.containers[].image)' \
    --quiet | bounded_command head --bytes=1048577 || exit 1
  # Preserve trailing newlines so command substitution cannot hide oversized output.
  printf '.'
)"; then
  fail 'Revision preservation preflight could not inspect the configured service'
fi
revisions_json="${revisions_json%.}"
if [ "${#revisions_json}" -gt 1048576 ]; then
  fail 'Revision preservation preflight exceeded its metadata bound'
fi
if ! bounded_command jq --exit-status --slurp '
  length == 1 and (.[0] |
    type == "array" and length <= 1000 and all(.[];
      type == "object" and (.spec | type) == "object" and
      (.spec.containers | type) == "array" and (.spec.containers | length) == 1 and
      (.spec.containers[0] | type) == "object" and
      (.spec.containers[0].image | type) == "string" and
      (.spec.containers[0].image | length) > 0 and
      (.spec.containers[0].image | length) <= 512 and
      (.spec.containers[0].image | test("[^a-z0-9./:@_-]") | not)
    )
  )
' <<< "$revisions_json" >/dev/null; then
  fail 'Revision preservation preflight received unsupported or excessive revision metadata'
fi
if ! declared_images="$(bounded_command jq --raw-output \
  '.[].spec.containers[0].image' <<< "$revisions_json")"; then
  fail 'Revision preservation preflight could not read declared image provenance'
fi

declare -A verified_sources=()
revision_count=0
while IFS= read -r declared_image; do
  if [ -z "$declared_image" ]; then
    continue
  fi
  revision_count=$((revision_count + 1))
  if [[ "$declared_image" != "$image_prefix"* ]]; then
    fail 'An existing revision has untrusted declared image provenance'
  fi
  source_tag="${declared_image#"$image_prefix"}"
  if [[ ! "$source_tag" =~ ^[0-9a-f]{40}(@sha256:[0-9a-f]{64})?$ ]]; then
    fail 'An existing revision lacks an exact supported source tag'
  fi
  source_commit="${source_tag%%@*}"
  if [ "${verified_sources[$source_commit]:-}" = 'true' ]; then
    continue
  fi
  if ! object_type="$(bounded_command git cat-file -t "$source_commit")" ||
    [ "$object_type" != 'commit' ]; then
    fail 'An existing revision source is absent from complete local Git history'
  fi
  # This checks declared source-tag provenance under the trusted build identity,
  # not a cryptographic binding between a mutable registry tag and its contents.
  if ! bounded_command git merge-base --is-ancestor "$compatibility_floor" "$source_commit" >/dev/null ||
    ! bounded_command git merge-base --is-ancestor "$source_commit" "$GITHUB_SHA" >/dev/null; then
    fail 'An existing revision is outside the supported source ancestry'
  fi
  verified_sources[$source_commit]='true'
done <<< "$declared_images"

printf 'Verified source compatibility for %s preserved revisions\n' "$revision_count"
