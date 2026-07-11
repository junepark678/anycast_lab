#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

require_command emcc
mkdir -p "$DIST_ROOT"

emcc -std=c11 -O2 \
  -I"$BIRD_PORT_ROOT/abi" \
  "$BIRD_PORT_ROOT/abi/anycast_host_abi.c" \
  "$BIRD_PORT_ROOT/abi/feasibility_harness.c" \
  --no-entry \
  -sSTANDALONE_WASM=1 \
  -sFILESYSTEM=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sERROR_ON_UNDEFINED_SYMBOLS=0 \
  -sWARN_ON_UNDEFINED_SYMBOLS=0 \
  -sEXPORTED_FUNCTIONS='["_anycast_appliance_host_abi_version","_anycast_appliance_runtime_api_version","_anycast_feasibility_probe"]' \
  -o "$DIST_ROOT/anycast-host-feasibility.wasm"

cp "$BIRD_PORT_ROOT/abi/feasibility-loader.mjs" "$DIST_ROOT/anycast-host-feasibility.mjs"

if command -v node >/dev/null 2>&1; then
  node "$BIRD_PORT_ROOT/abi/test-wasm-harness.mjs" "$DIST_ROOT/anycast-host-feasibility.wasm"
fi

printf '%s\n' "built ABI-only feasibility module: $DIST_ROOT/anycast-host-feasibility.mjs"
printf '%s\n' "this artifact does not contain BIRD"
