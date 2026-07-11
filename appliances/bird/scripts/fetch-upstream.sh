#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

require_command curl
require_command sha256sum
mkdir -p "$(dirname -- "$ARCHIVE_PATH")"

if [ -f "$ARCHIVE_PATH" ] && printf '%s  %s\n' "$BIRD_ARCHIVE_SHA256" "$ARCHIVE_PATH" | sha256sum -c - >/dev/null 2>&1; then
  printf '%s\n' "verified cached BIRD $BIRD_VERSION archive: $ARCHIVE_PATH"
  exit 0
fi

temporary="$ARCHIVE_PATH.part"
trap 'rm -f "$temporary"' EXIT HUP INT TERM
curl --fail --location --proto '=https' --tlsv1.2 "$BIRD_ARCHIVE_URL" --output "$temporary"
printf '%s  %s\n' "$BIRD_ARCHIVE_SHA256" "$temporary" | sha256sum -c -
mv "$temporary" "$ARCHIVE_PATH"
trap - EXIT HUP INT TERM
printf '%s\n' "downloaded and verified BIRD $BIRD_VERSION: $ARCHIVE_PATH"
