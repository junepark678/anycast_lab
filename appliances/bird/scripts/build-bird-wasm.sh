#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$SCRIPT_DIR/common.sh"

if [ ! -d "$SOURCE_PATH" ]; then
  "$SCRIPT_DIR/prepare-source.sh"
fi

if [ ! -f "$SOURCE_PATH/sysdep/cf/anycast-wasm.h" ] || \
   [ ! -f "$SOURCE_PATH/sysdep/anycast-wasm/Makefile" ]; then
  printf '%s\n' \
    'native BIRD WASM port is not ready: the patch queue has no anycast-wasm sysdep backend' \
    'see patches/README.md and README.md; refusing to emit a misleading native artifact' >&2
  exit 3
fi

require_command emconfigure
require_command emmake
require_command emcc
require_command bison
require_command flex
require_command m4

rm -rf "$BUILD_PATH"
mkdir -p "$BUILD_PATH" "$DIST_ROOT"
cd "$BUILD_PATH"

export CC=emcc
export RANLIB=emranlib
export CFLAGS='-O2 -fno-exceptions'
export LDFLAGS='-O2 -sENVIRONMENT=worker -sALLOW_MEMORY_GROWTH=1 -sMODULARIZE=1 -sEXPORT_ES6=1 -sERROR_ON_UNDEFINED_SYMBOLS=1 -sEXPORTED_FUNCTIONS=["_anycast_appliance_host_abi_version","_anycast_appliance_runtime_api_version","_anycast_appliance_create","_anycast_appliance_step","_anycast_appliance_next_deadline_ns","_anycast_appliance_deliver_frame","_anycast_appliance_dispose"]'

emconfigure "$SOURCE_PATH/configure" \
  --host=wasm32-unknown-emscripten \
  --with-sysconfig=anycast-wasm \
  --with-protocols=bgp,pipe,static \
  --disable-client \
  --disable-pthreads \
  --disable-libssh \
  --disable-mpls-kernel \
  --sysconfdir=/etc/bird \
  --runstatedir=/run/bird

emmake make daemon

if [ ! -f "$BUILD_PATH/bird" ] || [ ! -f "$BUILD_PATH/bird.wasm" ]; then
  printf '%s\n' 'Emscripten build completed without the expected bird and bird.wasm outputs' >&2
  exit 4
fi

cp "$BUILD_PATH/bird" "$DIST_ROOT/bird-2.17.1.mjs"
cp "$BUILD_PATH/bird.wasm" "$DIST_ROOT/bird-2.17.1.wasm"
printf '%s\n' "built unverified native candidate in $DIST_ROOT"
printf '%s\n' 'do not register it until differential BGP and forwarding tests pass'
