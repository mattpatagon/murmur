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
readonly image_name="${image_prefix%:}"
readonly package_name="projects/$PROJECT_ID/locations/$REGION/repositories/$ARTIFACT_REPOSITORY/packages/$SERVICE"

resolve_digest_source() {
  local digest="$1" metadata source binding
  if ! metadata="$(
    bounded_command gcloud artifacts tags list \
      --package "$SERVICE" --repository "$ARTIFACT_REPOSITORY" \
      --location "$REGION" --project "$PROJECT_ID" \
      --filter "version=\"$package_name/versions/$digest\"" \
      --limit 1001 --format 'json(name,version)' --quiet |
      bounded_command head --bytes=1048577 || exit 1
    printf '.'
  )"; then
    fail 'Revision preservation preflight could not inspect image source tags'
  fi
  metadata="${metadata%.}"
  if [ "${#metadata}" -gt 1048576 ] || ! bounded_command jq --exit-status --slurp \
    --arg prefix "$package_name/tags/" --arg version "$package_name/versions/$digest" '
    length == 1 and (.[0] |
      type == "array" and length <= 1000 and
      (map(.name) | length == (unique | length)) and all(.[];
        type == "object" and keys == ["name", "version"] and
        (.name | type) == "string" and (.name | startswith($prefix)) and
        (.name | length) <= 512 and
        (.name | ltrimstr($prefix) | length > 0 and (test("[^a-zA-Z0-9._-]") | not)) and
        .version == $version
      )
    )
  ' <<< "$metadata" >/dev/null; then
    fail 'Revision preservation preflight received unsupported or excessive source metadata'
  fi
  if ! source="$(bounded_command jq --raw-output --exit-status --arg prefix "$package_name/tags/" '
    [.[].name | ltrimstr($prefix) | select(length == 40 and test("^[0-9a-f]+$"))] |
    if length == 1 then .[0] else error("unsupported source tags") end
  ' <<< "$metadata")"; then
    fail 'An existing revision lacks one unambiguous supported source tag'
  fi
  if ! binding="$(
    bounded_command gcloud artifacts tags list \
      --package "$SERVICE" --repository "$ARTIFACT_REPOSITORY" \
      --location "$REGION" --project "$PROJECT_ID" \
      --filter "name=\"$package_name/tags/$source\"" \
      --limit 2 --format 'json(name,version)' --quiet |
      bounded_command head --bytes=1048577 || exit 1
    printf '.'
  )"; then
    fail 'Revision preservation preflight could not verify image source binding'
  fi
  binding="${binding%.}"
  if [ "${#binding}" -gt 1048576 ] || ! bounded_command jq --exit-status --slurp \
    --arg name "$package_name/tags/$source" --arg version "$package_name/versions/$digest" '
    length == 1 and (.[0] |
      type == "array" and length == 1 and (.[0] |
        type == "object" and keys == ["name", "version"] and
        .name == $name and .version == $version
      )
    )
  ' <<< "$binding" >/dev/null; then
    fail 'An existing revision source tag does not match its deployed digest'
  fi
  printf '%s' "$source"
}

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
declare -A verified_images=()
revision_count=0
while IFS= read -r declared_image; do
  if [ -z "$declared_image" ]; then
    continue
  fi
  revision_count=$((revision_count + 1))
  if [ "${verified_images[$declared_image]:-}" = 'true' ]; then
    continue
  fi
  if [[ "$declared_image" == "$image_name@sha256:"* ]]; then
    digest="${declared_image#"$image_name@"}"
    if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      fail 'An existing revision lacks an exact supported source tag'
    fi
    source_commit="$(resolve_digest_source "$digest")" || exit 1
  elif [[ "$declared_image" == "$image_prefix"* ]]; then
    source_tag="${declared_image#"$image_prefix"}"
    if [[ ! "$source_tag" =~ ^[0-9a-f]{40}(@sha256:[0-9a-f]{64})?$ ]]; then
      fail 'An existing revision lacks an exact supported source tag'
    fi
    source_commit="${source_tag%%@*}"
  else
    fail 'An existing revision has untrusted declared image provenance'
  fi
  verified_images[$declared_image]='true'
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
