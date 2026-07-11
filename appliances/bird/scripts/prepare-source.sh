#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

require_command patch
require_command tar
"$SCRIPT_DIR/fetch-upstream.sh"

rm -rf "$SOURCE_PATH"
mkdir -p "$(dirname -- "$SOURCE_PATH")"
tar -xzf "$ARCHIVE_PATH" -C "$(dirname -- "$SOURCE_PATH")"

while IFS= read -r patch_name || [ -n "$patch_name" ]; do
  case "$patch_name" in
    ''|'#'*) continue ;;
  esac
  patch_file="$BIRD_PORT_ROOT/patches/$patch_name"
  if [ ! -f "$patch_file" ]; then
    printf '%s\n' "patch listed in series does not exist: $patch_file" >&2
    exit 2
  fi
  patch -d "$SOURCE_PATH" -p1 < "$patch_file"
done < "$BIRD_PORT_ROOT/patches/series"

printf '%s\n' "prepared BIRD source: $SOURCE_PATH"
