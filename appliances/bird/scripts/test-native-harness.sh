#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

CC=${CC:-cc}
require_command "$CC"
mkdir -p "$BUILD_PATH/abi"

"$CC" -std=c11 -Wall -Wextra -Werror -pedantic \
  -DANYCAST_NATIVE_HARNESS=1 \
  -I"$BIRD_PORT_ROOT/abi" \
  "$BIRD_PORT_ROOT/abi/anycast_host_abi.c" \
  "$BIRD_PORT_ROOT/abi/feasibility_harness.c" \
  -o "$BUILD_PATH/abi/native-feasibility-harness"

"$BUILD_PATH/abi/native-feasibility-harness"
