#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
BIRD_PORT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

# shellcheck disable=SC1091
. "$BIRD_PORT_ROOT/UPSTREAM.env"

WORK_ROOT=${BIRD_WORK_ROOT:-"$BIRD_PORT_ROOT/.work"}
DIST_ROOT=${BIRD_DIST_ROOT:-"$BIRD_PORT_ROOT/dist"}
ARCHIVE_PATH="$WORK_ROOT/downloads/bird-$BIRD_VERSION.tar.gz"
SOURCE_PATH="$WORK_ROOT/source/bird-$BIRD_VERSION"
BUILD_PATH="$WORK_ROOT/build/bird-$BIRD_VERSION"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf '%s\n' "required command not found: $1" >&2
    exit 127
  fi
}
