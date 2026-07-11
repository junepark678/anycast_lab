#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
ARTIFACT_DIR=${ARTIFACT_DIR:-"$ROOT/dist"}
RELEASE_STATUS_PATH=${RELEASE_STATUS_PATH:-}
RELEASE_CHANNEL=${RELEASE_CHANNEL:-stable}
R2_PREFIX=${R2_PREFIX:-anycast-lab/native-v86}
R2_CORS_ORIGIN=${R2_CORS_ORIGIN:-https://anycast.guide}

required=(
  AWS_ACCESS_KEY_ID
  AWS_SECRET_ACCESS_KEY
  R2_ACCOUNT_ID
  R2_BUCKET
  R2_PUBLIC_BASE_URL
  RELEASE_STATUS_PATH
  SOURCE_REVISION
)
for variable in "${required[@]}"; do
  if [[ -z ${!variable:-} ]]; then
    printf 'Required R2 publish configuration is missing: %s\n' "$variable" >&2
    exit 1
  fi
done
if ! command -v aws >/dev/null 2>&1; then
  printf 'The AWS CLI is required to publish through the R2 S3 API\n' >&2
  exit 1
fi
if ! command -v curl >/dev/null 2>&1; then
  printf 'curl is required to verify the public R2 origin\n' >&2
  exit 1
fi
if [[ ! $RELEASE_CHANNEL =~ ^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$ ]]; then
  printf 'Invalid release channel: %s\n' "$RELEASE_CHANNEL" >&2
  exit 1
fi
if [[ ! $R2_PUBLIC_BASE_URL =~ ^https://[^/?#]+/?$ ]]; then
  printf 'R2_PUBLIC_BASE_URL must be an HTTPS origin\n' >&2
  exit 1
fi
if [[ ! $R2_CORS_ORIGIN =~ ^https://[^/?#]+$ ]]; then
  printf 'R2_CORS_ORIGIN must be an HTTPS origin without a path\n' >&2
  exit 1
fi
if [[ ! $R2_PREFIX =~ ^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$ ]]; then
  printf 'Invalid R2 object prefix\n' >&2
  exit 1
fi
IFS='/' read -r -a prefix_segments <<< "$R2_PREFIX"
for segment in "${prefix_segments[@]}"; do
  if [[ $segment == '.' || $segment == '..' ]]; then
    printf 'Invalid R2 object prefix\n' >&2
    exit 1
  fi
done

MANIFEST_PATH="$ARTIFACT_DIR/manifest.json"
MANIFEST_SHA256_PATH="$ARTIFACT_DIR/manifest.sha256"
recorded_digest=$(awk 'NR == 1 && $2 == "manifest.json" { print $1 }' "$MANIFEST_SHA256_PATH")
if [[ ! $recorded_digest =~ ^[a-f0-9]{64}$ ]]; then
  printf 'Invalid appliance manifest digest\n' >&2
  exit 1
fi
verified_line=$(node "$ROOT/scripts/verify-manifest.mjs" "$MANIFEST_PATH")
if [[ "$verified_line" != "$recorded_digest  manifest.json" ]]; then
  printf 'Appliance manifest.sha256 does not match the verified bundle\n' >&2
  exit 1
fi

object_root="$R2_PREFIX/objects/sha256/$recorded_digest"
manifest_url="${R2_PUBLIC_BASE_URL%/}/$object_root/manifest.json"
node "$ROOT/scripts/release-status.mjs" validate \
  --status "$RELEASE_STATUS_PATH" \
  --manifest "$MANIFEST_PATH" \
  --manifest-sha256 "$MANIFEST_SHA256_PATH" \
  --manifest-url "$manifest_url" \
  --channel "$RELEASE_CHANNEL" \
  --source-revision "$SOURCE_REVISION"

endpoint="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT

s3api() {
  aws s3api --endpoint-url "$endpoint" --region auto "$@"
}

publish_immutable() {
  local source=$1
  local key=$2
  local content_type=$3
  local error_file="$temporary_directory/head-error"
  local existing_file="$temporary_directory/existing"

  if s3api head-object --bucket "$R2_BUCKET" --key "$key" >/dev/null 2>"$error_file"; then
    s3api get-object --bucket "$R2_BUCKET" --key "$key" "$existing_file" >/dev/null
    if ! cmp -s "$source" "$existing_file"; then
      printf 'Refusing to replace immutable R2 object with different bytes: %s\n' "$key" >&2
      exit 1
    fi
    printf 'Immutable object already exists with identical bytes: %s\n' "$key"
    return
  fi
  if ! grep -Eqi '(404|Not Found|NoSuchKey)' "$error_file"; then
    printf 'Unable to inspect R2 object %s:\n' "$key" >&2
    cat "$error_file" >&2
    exit 1
  fi

  s3api put-object \
    --bucket "$R2_BUCKET" \
    --key "$key" \
    --body "$source" \
    --content-type "$content_type" \
    --cache-control 'public, max-age=31536000, immutable' >/dev/null
  s3api get-object --bucket "$R2_BUCKET" --key "$key" "$existing_file" >/dev/null
  if ! cmp -s "$source" "$existing_file"; then
    printf 'R2 object verification failed after upload: %s\n' "$key" >&2
    exit 1
  fi
  printf 'Published immutable object: %s\n' "$key"
}

publish_immutable "$MANIFEST_PATH" "$object_root/manifest.json" application/json
publish_immutable "$MANIFEST_SHA256_PATH" "$object_root/manifest.sha256" text/plain
publish_immutable "$ARTIFACT_DIR/router-bzimage.bin" "$object_root/router-bzimage.bin" application/octet-stream
publish_immutable "$ARTIFACT_DIR/seabios.bin" "$object_root/seabios.bin" application/octet-stream
publish_immutable "$ARTIFACT_DIR/vgabios.bin" "$object_root/vgabios.bin" application/octet-stream
publish_immutable "$ARTIFACT_DIR/v86.wasm" "$object_root/v86.wasm" application/wasm

# Verify the public URL and browser CORS contract before making this bundle
# discoverable through the mutable channel. The retries allow a custom-domain
# cache/configuration edge a short convergence window after the S3 write.
public_headers="$temporary_directory/public-headers"
public_manifest="$temporary_directory/public-manifest.json"
curl --fail --silent --show-error \
  --retry 5 \
  --retry-delay 2 \
  --retry-all-errors \
  --dump-header "$public_headers" \
  --header "Origin: $R2_CORS_ORIGIN" \
  --output "$public_manifest" \
  "$manifest_url"
if ! cmp -s "$MANIFEST_PATH" "$public_manifest"; then
  printf 'Public R2 manifest does not match the uploaded release: %s\n' "$manifest_url" >&2
  exit 1
fi
cors_origin=$(tr -d '\r' < "$public_headers" | awk '
  tolower($1) ~ /^http\// { origin = "" }
  tolower($1) == "access-control-allow-origin:" { origin = $2 }
  END { print origin }
')
if [[ $cors_origin != "$R2_CORS_ORIGIN" && $cors_origin != '*' ]]; then
  printf 'Public R2 origin does not allow browser requests from %s\n' "$R2_CORS_ORIGIN" >&2
  exit 1
fi
printf 'Verified public manifest bytes and CORS: %s\n' "$manifest_url"

# A PutObject replacement is atomic in R2. This mutable channel pointer is the
# final R2 write so readers can never observe a status that references a
# partially published immutable bundle.
status_key="$R2_PREFIX/channels/$RELEASE_CHANNEL/status.json"
s3api put-object \
  --bucket "$R2_BUCKET" \
  --key "$status_key" \
  --body "$RELEASE_STATUS_PATH" \
  --content-type application/json \
  --cache-control 'no-store, max-age=0' >/dev/null
s3api get-object --bucket "$R2_BUCKET" --key "$status_key" "$temporary_directory/status.json" >/dev/null
if ! cmp -s "$RELEASE_STATUS_PATH" "$temporary_directory/status.json"; then
  printf 'R2 channel status verification failed after upload\n' >&2
  exit 1
fi
printf 'Published channel status last: %s\n' "$status_key"
