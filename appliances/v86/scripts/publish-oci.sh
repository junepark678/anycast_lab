#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ARTIFACT_DIR=${ARTIFACT_DIR:-"$ROOT/dist"}
RELEASE_STATUS_PATH=${RELEASE_STATUS_PATH:-}
RELEASE_CHANNEL=${RELEASE_CHANNEL:-stable}
OCI_OBJECT_PREFIX=${OCI_OBJECT_PREFIX:-anycast-lab/native-v86}
OCI_CORS_ORIGIN=${OCI_CORS_ORIGIN:-https://anycast.guide}
OCI_PAR_BASE_URL=${OCI_PAR_BASE_URL:-}
OCI_PUBLIC_BASE_URL=${OCI_PUBLIC_BASE_URL:-}

required=(
  OCI_PAR_BASE_URL
  OCI_PUBLIC_BASE_URL
  RELEASE_STATUS_PATH
  SOURCE_REVISION
)
for variable in "${required[@]}"; do
  if [[ -z ${!variable:-} ]]; then
    printf 'Required OCI publish configuration is missing: %s\n' "$variable" >&2
    exit 1
  fi
done
if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required to publish OCI Object Storage artifacts\n' >&2
  exit 1
fi
if [[ ! $RELEASE_CHANNEL =~ ^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$ ]]; then
  printf 'Invalid release channel: %s\n' "$RELEASE_CHANNEL" >&2
  exit 1
fi
if [[ ! $OCI_OBJECT_PREFIX =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]]; then
  printf 'Invalid OCI object prefix\n' >&2
  exit 1
fi
IFS='/' read -r -a prefix_segments <<< "$OCI_OBJECT_PREFIX"
for segment in "${prefix_segments[@]}"; do
  if [[ $segment == '.' || $segment == '..' ]]; then
    printf 'Invalid OCI object prefix\n' >&2
    exit 1
  fi
done
if [[ ! $OCI_PAR_BASE_URL =~ ^https://[^/?#@]+/p/[A-Za-z0-9_-]+/n/[A-Za-z0-9._-]+/b/[A-Za-z0-9._-]+/o/?$ ]]; then
  printf 'OCI_PAR_BASE_URL must be an HTTPS Object Storage pre-authenticated object URL\n' >&2
  exit 1
fi
if [[ ! $OCI_PUBLIC_BASE_URL =~ ^https://[^/?#@]+/n/[A-Za-z0-9._-]+/b/[A-Za-z0-9._-]+/o/?$ ]]; then
  printf 'OCI_PUBLIC_BASE_URL must be an HTTPS native Object Storage object URL\n' >&2
  exit 1
fi
if [[ ! $OCI_CORS_ORIGIN =~ ^https://[^/?#]+$ ]]; then
  printf 'OCI_CORS_ORIGIN must be an HTTPS origin without a path\n' >&2
  exit 1
fi

OCI_PAR_BASE_URL=${OCI_PAR_BASE_URL%/}
OCI_PUBLIC_BASE_URL=${OCI_PUBLIC_BASE_URL%/}
MANIFEST_PATH="$ARTIFACT_DIR/manifest.json"
MANIFEST_SHA256_PATH="$ARTIFACT_DIR/manifest.sha256"
recorded_digest=$(awk 'NR == 1 && $2 == "manifest.json" { print $1 }' "$MANIFEST_SHA256_PATH")
if [[ ! $recorded_digest =~ ^[a-f0-9]{64}$ ]]; then
  printf 'Invalid appliance manifest digest\n' >&2
  exit 1
fi
verified_line=$(node "$ROOT/scripts/verify-manifest.mjs" \
  "$MANIFEST_PATH" --require-pgo-use --require-filesystem)
if [[ "$verified_line" != "$recorded_digest  manifest.json" ]]; then
  printf 'Appliance manifest.sha256 does not match the verified bundle\n' >&2
  exit 1
fi

object_root="$OCI_OBJECT_PREFIX/objects/sha256/$recorded_digest"
manifest_url="$OCI_PUBLIC_BASE_URL/$object_root/manifest.json"
node "$ROOT/scripts/release-status.mjs" validate \
  --status "$RELEASE_STATUS_PATH" \
  --manifest "$MANIFEST_PATH" \
  --manifest-sha256 "$MANIFEST_SHA256_PATH" \
  --manifest-url "$manifest_url" \
  --channel "$RELEASE_CHANNEL" \
  --source-revision "$SOURCE_REVISION"

temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT

authenticated_get() {
  local key=$1
  local destination=$2
  curl --silent --show-error \
    --retry 5 \
    --retry-delay 2 \
    --retry-all-errors \
    --output "$destination" \
    --write-out '%{http_code}' \
    "$OCI_PAR_BASE_URL/$key"
}

authenticated_put() {
  local source=$1
  local key=$2
  local content_type=$3
  local cache_control=$4
  shift 4
  curl --silent --show-error \
    --retry 5 \
    --retry-delay 2 \
    --retry-all-errors \
    --request PUT \
    --upload-file "$source" \
    --header "Content-Type: $content_type" \
    --header "Cache-Control: $cache_control" \
    "$@" \
    --output "$temporary_directory/put-response" \
    --write-out '%{http_code}' \
    "$OCI_PAR_BASE_URL/$key"
}

verify_authenticated_bytes() {
  local source=$1
  local key=$2
  local existing_file="$temporary_directory/existing"
  local status
  status=$(authenticated_get "$key" "$existing_file")
  if [[ $status != 200 ]] || ! cmp -s "$source" "$existing_file"; then
    printf 'OCI object verification failed after upload: %s (HTTP %s)\n' "$key" "$status" >&2
    exit 1
  fi
}

publish_immutable() {
  local source=$1
  local key=$2
  local content_type=$3
  local existing_file="$temporary_directory/existing"
  local status

  status=$(authenticated_get "$key" "$existing_file")
  if [[ $status == 200 ]]; then
    if ! cmp -s "$source" "$existing_file"; then
      printf 'Refusing to replace immutable OCI object with different bytes: %s\n' "$key" >&2
      exit 1
    fi
    printf 'Immutable object already exists with identical bytes: %s\n' "$key"
    return
  fi
  if [[ $status != 404 ]]; then
    printf 'Unable to inspect OCI object %s: HTTP %s\n' "$key" "$status" >&2
    exit 1
  fi

  status=$(authenticated_put \
    "$source" \
    "$key" \
    "$content_type" \
    'public, max-age=31536000, immutable' \
    --header 'If-None-Match: *')
  if [[ $status == 412 ]]; then
    verify_authenticated_bytes "$source" "$key"
    printf 'Immutable object won an upload race with identical bytes: %s\n' "$key"
    return
  fi
  if [[ $status != 200 && $status != 201 ]]; then
    printf 'Unable to publish immutable OCI object %s: HTTP %s\n' "$key" "$status" >&2
    exit 1
  fi
  verify_authenticated_bytes "$source" "$key"
  printf 'Published immutable object: %s\n' "$key"
}

verify_public_object() {
  local source=$1
  local key=$2
  local expected_content_type=$3
  local headers="$temporary_directory/public-headers"
  local object="$temporary_directory/public-object"

  curl --fail --silent --show-error \
    --retry 5 \
    --retry-delay 2 \
    --retry-all-errors \
    --dump-header "$headers" \
    --header "Origin: $OCI_CORS_ORIGIN" \
    --output "$object" \
    "$OCI_PUBLIC_BASE_URL/$key"
  if ! cmp -s "$source" "$object"; then
    printf 'Public OCI object does not match the uploaded release: %s\n' "$key" >&2
    exit 1
  fi
  local cors_origin
  cors_origin=$(tr -d '\r' < "$headers" | awk '
    tolower($1) ~ /^http\// { origin = "" }
    tolower($1) == "access-control-allow-origin:" { origin = $2 }
    END { print origin }
  ')
  if [[ $cors_origin != "$OCI_CORS_ORIGIN" && $cors_origin != '*' ]]; then
    printf 'Public OCI origin does not allow browser requests from %s\n' "$OCI_CORS_ORIGIN" >&2
    exit 1
  fi
  local content_type
  content_type=$(tr -d '\r' < "$headers" | awk '
    tolower($1) ~ /^http\// { content_type = "" }
    tolower($1) == "content-type:" { content_type = $2 }
    END { print content_type }
  ')
  if [[ $content_type != "$expected_content_type" ]]; then
    printf 'Public OCI object has unexpected Content-Type %s; expected %s\n' \
      "${content_type:-<missing>}" "$expected_content_type" >&2
    exit 1
  fi
}

publish_immutable "$MANIFEST_PATH" "$object_root/manifest.json" application/json
publish_immutable "$MANIFEST_SHA256_PATH" "$object_root/manifest.sha256" text/plain
publish_immutable "$ARTIFACT_DIR/router-bzimage.bin" "$object_root/router-bzimage.bin" application/octet-stream
publish_immutable "$ARTIFACT_DIR/seabios.bin" "$object_root/seabios.bin" application/octet-stream
publish_immutable "$ARTIFACT_DIR/vgabios.bin" "$object_root/vgabios.bin" application/octet-stream
publish_immutable "$ARTIFACT_DIR/v86.wasm" "$object_root/v86.wasm" application/wasm

# Filesystem blobs are addressed by their own digest instead of the enclosing
# manifest digest. Unchanged base/routing/tool layers are therefore reused
# across releases, PGO rebuilds and channel publications.
while IFS=$'\t' read -r layer_file layer_object; do
  if [[ -z $layer_file || -z $layer_object ]]; then
    printf 'Verified filesystem manifest produced an invalid publish entry\n' >&2
    exit 1
  fi
  publish_immutable \
    "$ARTIFACT_DIR/$layer_file" \
    "$OCI_OBJECT_PREFIX/$layer_object" \
    application/octet-stream
done < <(node -e '
  const { readFileSync } = require("node:fs");
  const manifest = JSON.parse(readFileSync(process.argv[1], "utf8"));
  for (const layer of manifest.filesystem.layers) {
    process.stdout.write(`${layer.file}\t${layer.object}\n`);
  }
' "$MANIFEST_PATH")

# Make the immutable bundle discoverable only after the anonymous browser path
# returns the exact manifest bytes with a usable CORS response.
verify_public_object "$MANIFEST_PATH" "$object_root/manifest.json" application/json
printf 'Verified public OCI manifest bytes and CORS\n'

# This small mutable channel document is the final write. OCI Object Storage is
# strongly consistent, and workflow concurrency serializes writers per channel.
status_key="$OCI_OBJECT_PREFIX/channels/$RELEASE_CHANNEL/status.json"
current_generation=$(node -e '
  const { readFileSync } = require("node:fs");
  process.stdout.write(String(JSON.parse(readFileSync(process.argv[1], "utf8")).generation));
' "$RELEASE_STATUS_PATH")
existing_status="$temporary_directory/existing-status.json"
existing_status_code=$(authenticated_get "$status_key" "$existing_status")
if [[ $existing_status_code == 200 ]]; then
  node "$ROOT/scripts/release-status.mjs" validate --status "$existing_status"
  existing_generation=$(node -e '
    const { readFileSync } = require("node:fs");
    process.stdout.write(String(JSON.parse(readFileSync(process.argv[1], "utf8")).generation));
  ' "$existing_status")
  if [[ $existing_generation -gt $current_generation ]]; then
    printf 'Refusing to replace OCI channel generation %s with older generation %s\n' \
      "$existing_generation" "$current_generation" >&2
    exit 1
  fi
elif [[ $existing_status_code != 404 ]]; then
  printf 'Unable to inspect OCI channel status: HTTP %s\n' "$existing_status_code" >&2
  exit 1
fi
status=$(authenticated_put \
  "$RELEASE_STATUS_PATH" \
  "$status_key" \
  application/json \
  'no-store, max-age=0')
if [[ $status != 200 && $status != 201 ]]; then
  printf 'Unable to advance OCI channel status: HTTP %s\n' "$status" >&2
  exit 1
fi
verify_authenticated_bytes "$RELEASE_STATUS_PATH" "$status_key"
verify_public_object "$RELEASE_STATUS_PATH" "$status_key" application/json
printf 'Published and publicly verified channel status last: %s\n' "$status_key"
