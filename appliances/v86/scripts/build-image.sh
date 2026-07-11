#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/versions.env"

WORK=${WORK_DIR:-"$ROOT/.work"}
DIST=${DIST_DIR:-"$ROOT/dist"}
JOBS=${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf '2')}
DOWNLOADS="$WORK/downloads"
BUILDROOT_DOWNLOADS=${BUILDROOT_DL_DIR:-"$WORK/buildroot-downloads"}
BUILDROOT="$WORK/buildroot-$BUILDROOT_VERSION"
OUTPUT="$WORK/output"
V86_PACKAGE="$WORK/v86-package"
PGO_WORK="$WORK/pgo"
PGO_MODE=${ANYCAST_PGO_MODE:-none}
PGO_PROFILE_DIR=${ANYCAST_PGO_PROFILE_DIR:-}
BIRD_PROFILE=
FRR_PROFILE=

mkdir -p "$DOWNLOADS" "$BUILDROOT_DOWNLOADS" "$DIST" "$PGO_WORK"

case "$PGO_MODE" in
  none|generate|use) ;;
  *)
    printf 'ANYCAST_PGO_MODE must be none, generate or use; received %s\n' "$PGO_MODE" >&2
    exit 2
    ;;
esac

export ANYCAST_PGO_MODE="$PGO_MODE"

fetch() {
  destination=$1
  url=$2
  [ -f "$destination" ] || curl --fail --location --retry 3 --output "$destination" "$url"
}

verify_sha256() {
  expected=$1
  file=$2
  printf '%s  %s\n' "$expected" "$file" | sha256sum --check --status
}

BUILDROOT_ARCHIVE="$DOWNLOADS/buildroot-$BUILDROOT_VERSION.tar.xz"
fetch "$BUILDROOT_ARCHIVE" "https://buildroot.org/downloads/buildroot-$BUILDROOT_VERSION.tar.xz"
verify_sha256 "$BUILDROOT_SHA256" "$BUILDROOT_ARCHIVE"
if [ ! -d "$BUILDROOT" ]; then
  tar -xJf "$BUILDROOT_ARCHIVE" -C "$WORK"
fi

grep -q "^BIRD_VERSION = $BIRD_VERSION\$" "$BUILDROOT/package/bird/bird.mk"
grep -q "^FRR_VERSION = $FRR_VERSION\$" "$BUILDROOT/package/frr/frr.mk"
LLVM_VERSION_SUFFIX=${LLVM_VERSION#*.}
grep -q "^LLVM_PROJECT_VERSION_MAJOR = ${LLVM_VERSION%%.*}\$" \
  "$BUILDROOT/package/llvm-project/llvm-project.mk"
grep -q "^LLVM_PROJECT_VERSION = \$(LLVM_PROJECT_VERSION_MAJOR).$LLVM_VERSION_SUFFIX\$" \
  "$BUILDROOT/package/llvm-project/llvm-project.mk"
grep -Fq "sha256  $LLVM_SOURCE_SHA256  llvm-$LLVM_VERSION.src.tar.xz" \
  "$BUILDROOT/package/llvm-project/llvm/llvm.hash"
grep -Fq "sha256  $LLVM_THIRD_PARTY_SHA256  third-party-$LLVM_VERSION.src.tar.xz" \
  "$BUILDROOT/package/llvm-project/llvm/llvm.hash"
grep -Fq "sha256  $LLVM_CMAKE_SOURCE_SHA256  cmake-$LLVM_VERSION.src.tar.xz" \
  "$BUILDROOT/package/llvm-project/llvm-cmake/llvm-cmake.hash"
grep -Fq "sha256  $CLANG_SOURCE_SHA256  clang-$LLVM_VERSION.src.tar.xz" \
  "$BUILDROOT/package/llvm-project/clang/clang.hash"
grep -Fq "sha256  $LLD_SOURCE_SHA256  lld-$LLVM_VERSION.src.tar.xz" \
  "$BUILDROOT/package/llvm-project/lld/lld.hash"
grep -Fq "sha256  $COMPILER_RT_SOURCE_SHA256  compiler-rt-$LLVM_VERSION.src.tar.xz" \
  "$ROOT/buildroot/package/anycast-clang-toolchain/anycast-clang-toolchain.hash"

PGO_CONTEXT_SHA=$(node "$ROOT/scripts/pgo-profile-set.mjs" context \
  --root "$ROOT" --output "$PGO_WORK/profile-context.json")
case "$PGO_MODE" in
  use)
    if [ -z "$PGO_PROFILE_DIR" ]; then
      echo 'ANYCAST_PGO_PROFILE_DIR is required when ANYCAST_PGO_MODE=use' >&2
      exit 2
    fi
    PGO_PROFILE_DIR=$(CDPATH= cd -- "$PGO_PROFILE_DIR" && pwd)
    PGO_BUILD_KEY=$(node "$ROOT/scripts/pgo-profile-set.mjs" validate \
      --root "$ROOT" --profile-dir "$PGO_PROFILE_DIR")
    VALIDATED_PROFILE_DIR="$PGO_WORK/validated-$PGO_BUILD_KEY"
    rm -rf "$VALIDATED_PROFILE_DIR"
    install -d -m 0755 "$VALIDATED_PROFILE_DIR"
    install -m 0644 "$PGO_PROFILE_DIR/bird.profdata" "$VALIDATED_PROFILE_DIR/bird.profdata"
    install -m 0644 "$PGO_PROFILE_DIR/frr.profdata" "$VALIDATED_PROFILE_DIR/frr.profdata"
    BIRD_PROFILE="$VALIDATED_PROFILE_DIR/bird.profdata"
    FRR_PROFILE="$VALIDATED_PROFILE_DIR/frr.profdata"
    ;;
  none|generate)
    PGO_BUILD_KEY=$(printf '%s\n%s\n' "$PGO_CONTEXT_SHA" "$PGO_MODE" | sha256sum | cut -d' ' -f1)
    ;;
esac

PGO_PROFILE_SET_BUILD_KEY_JSON=null
BIRD_PROFILE_SHA256_JSON=null
FRR_PROFILE_SHA256_JSON=null
if [ "$PGO_MODE" = use ]; then
  PGO_PROFILE_SET_BUILD_KEY_JSON=\"$PGO_BUILD_KEY\"
  BIRD_PROFILE_SHA256_JSON=\"$(sha256sum "$BIRD_PROFILE" | cut -d' ' -f1)\"
  FRR_PROFILE_SHA256_JSON=\"$(sha256sum "$FRR_PROFILE" | cut -d' ' -f1)\"
fi

buildroot_make() {
  make -C "$BUILDROOT" O="$OUTPUT" BR2_EXTERNAL="$ROOT/buildroot" \
    BR2_DL_DIR="$BUILDROOT_DOWNLOADS" BR2_LOCALVERSION="$BUILDROOT_VERSION" \
    ANYCAST_PGO_MODE="$PGO_MODE" \
    ANYCAST_BIRD_PROFILE="$BIRD_PROFILE" \
    ANYCAST_FRR_PROFILE="$FRR_PROFILE" \
    "$@"
}

export SOURCE_DATE_EPOCH
buildroot_make anycast_lab_v86_defconfig

LLVM_JOBS=${LLVM_JOBS:-$JOBS}
case "$LLVM_JOBS" in
  ''|*[!0-9]*) echo 'LLVM_JOBS must be a positive integer' >&2; exit 2 ;;
esac
if [ "$LLVM_JOBS" -lt 1 ]; then
  echo 'LLVM_JOBS must be a positive integer' >&2
  exit 2
fi
if [ "$LLVM_JOBS" -gt 4 ]; then LLVM_JOBS=4; fi
buildroot_make -j"$LLVM_JOBS" \
  BR2_JLEVEL="$LLVM_JOBS" \
  ANYCAST_LLVM_JOBS="$LLVM_JOBS" \
  anycast-clang-toolchain

CLANG="$OUTPUT/host/bin/clang"
LLD="$OUTPUT/host/bin/ld.lld"
LLVM_PROFDATA="$OUTPUT/host/bin/llvm-profdata"
LLVM_NM="$OUTPUT/host/bin/llvm-nm"
for tool in "$CLANG" "$LLD" "$LLVM_PROFDATA" "$LLVM_NM" \
  "$OUTPUT/host/bin/llvm-ar" "$OUTPUT/host/bin/llvm-ranlib"; do
  test -x "$tool"
done
"$CLANG" --version | grep -Fq "clang version $LLVM_VERSION"
"$LLD" --version | grep -Fq "LLD $LLVM_VERSION"
"$LLVM_PROFDATA" --version | grep -Fq "LLVM version $LLVM_VERSION"
"$OUTPUT/host/bin/llvm-ar" --version | grep -Fq "LLVM version $LLVM_VERSION"
CLANG_RUNTIME_DIR=$("$CLANG" --target=i686-buildroot-linux-gnu --print-runtime-dir)
case "$CLANG_RUNTIME_DIR" in
  "$OUTPUT/host"/*) ;;
  *) printf 'Unsafe Clang runtime directory: %s\n' "$CLANG_RUNTIME_DIR" >&2; exit 1 ;;
esac
PROFILE_RUNTIME=$("$CLANG" --target=i686-buildroot-linux-gnu --print-file-name=libclang_rt.profile.a)
test "$PROFILE_RUNTIME" = "$CLANG_RUNTIME_DIR/libclang_rt.profile.a"
test -s "$PROFILE_RUNTIME"

if [ "$PGO_MODE" = use ]; then
  for profile in "$BIRD_PROFILE" "$FRR_PROFILE"; do
    if ! "$LLVM_PROFDATA" show "$profile" | grep -Eq 'Total functions: [1-9][0-9]*'; then
      printf 'PGO profile is not a non-empty LLVM %s indexed profile: %s\n' \
        "$LLVM_VERSION" "$profile" >&2
      exit 1
    fi
  done
fi

OPTIMIZATION_STAMP="$OUTPUT/.anycast-daemon-optimization"
PREVIOUS_OPTIMIZATION=
if [ -f "$OPTIMIZATION_STAMP" ]; then PREVIOUS_OPTIMIZATION=$(cat "$OPTIMIZATION_STAMP"); fi
if [ "$PREVIOUS_OPTIMIZATION" != "$PGO_MODE:$PGO_BUILD_KEY" ]; then
  buildroot_make bird-dirclean frr-dirclean
fi

buildroot_make -j"$JOBS" BR2_JLEVEL="$JOBS"
buildroot_make ccache-stats

# Guard the integration seams that Buildroot package/layout changes could
# otherwise turn into silent no-ops in post-build.sh.
grep -Fq 'ttyS0::respawn:/sbin/getty -L -n -l /usr/libexec/anycastlab-shell' "$OUTPUT/target/etc/inittab"
for required_executable in \
  "$OUTPUT/target/usr/libexec/anycastlab-agent" \
  "$OUTPUT/target/usr/libexec/anycastlab-shell" \
  "$OUTPUT/target/usr/libexec/anycastlab-frr" \
  "$OUTPUT/target/usr/sbin/bird" \
  "$OUTPUT/target/usr/sbin/bgpd" \
  "$OUTPUT/target/usr/sbin/zebra" \
  "$OUTPUT/target/usr/bin/vtysh"; do
  if [ ! -x "$required_executable" ]; then
    printf 'Required native appliance executable is missing: %s\n' "$required_executable" >&2
    exit 1
  fi
done

"$ROOT/scripts/verify-optimized-daemons.sh" \
  "$OUTPUT" "$BIRD_VERSION" "$FRR_VERSION" "$LLVM_VERSION" "$PGO_MODE" \
  "$BIRD_PROFILE" "$FRR_PROFILE"

printf '%s\n' "$PGO_MODE:$PGO_BUILD_KEY" >"$OPTIMIZATION_STAMP.tmp"
mv "$OPTIMIZATION_STAMP.tmp" "$OPTIMIZATION_STAMP"
cp "$OUTPUT/images/bzImage" "$DIST/router-bzimage.bin"

V86_ARCHIVE="$DOWNLOADS/v86-$V86_NPM_VERSION.tgz"
fetch "$V86_ARCHIVE" "https://registry.npmjs.org/v86/-/v86-$V86_NPM_VERSION.tgz"
printf '%s  %s\n' "$V86_NPM_SHA512" "$V86_ARCHIVE" | sha512sum --check --status
rm -rf "$V86_PACKAGE"
mkdir -p "$V86_PACKAGE"
tar -xzf "$V86_ARCHIVE" --strip-components=1 -C "$V86_PACKAGE"
verify_sha256 "$V86_WASM_SHA256" "$V86_PACKAGE/build/v86.wasm"
cp "$V86_PACKAGE/build/v86.wasm" "$DIST/v86.wasm"

fetch "$DIST/seabios.bin" "https://raw.githubusercontent.com/copy/v86/$V86_COMMIT/bios/seabios.bin"
fetch "$DIST/vgabios.bin" "https://raw.githubusercontent.com/copy/v86/$V86_COMMIT/bios/vgabios.bin"
verify_sha256 "$SEABIOS_SHA256" "$DIST/seabios.bin"
verify_sha256 "$VGABIOS_SHA256" "$DIST/vgabios.bin"

V86_WASM_SIZE=$(wc -c <"$DIST/v86.wasm" | tr -d ' ')
SEABIOS_SIZE=$(wc -c <"$DIST/seabios.bin" | tr -d ' ')
VGABIOS_SIZE=$(wc -c <"$DIST/vgabios.bin" | tr -d ' ')
BZIMAGE_SIZE=$(wc -c <"$DIST/router-bzimage.bin" | tr -d ' ')
V86_WASM_OUTPUT_SHA256=$(sha256sum "$DIST/v86.wasm" | cut -d' ' -f1)
SEABIOS_OUTPUT_SHA256=$(sha256sum "$DIST/seabios.bin" | cut -d' ' -f1)
VGABIOS_OUTPUT_SHA256=$(sha256sum "$DIST/vgabios.bin" | cut -d' ' -f1)
BZIMAGE_SHA256=$(sha256sum "$DIST/router-bzimage.bin" | cut -d' ' -f1)

# Native images are published to dedicated object storage rather than Workers
# Static Assets. Keep a generous browser-safety ceiling to catch accidental
# multi-gigabyte outputs while allowing the appliance to grow past 25 MiB.
MAX_RELEASE_ARTIFACT_BYTES=${MAX_RELEASE_ARTIFACT_BYTES:-536870912}
for artifact_size in "$V86_WASM_SIZE" "$SEABIOS_SIZE" "$VGABIOS_SIZE" "$BZIMAGE_SIZE"; do
  if [ "$artifact_size" -gt "$MAX_RELEASE_ARTIFACT_BYTES" ]; then
    printf 'Native artifact is %s bytes; release safety limit is %s bytes\n' "$artifact_size" "$MAX_RELEASE_ARTIFACT_BYTES" >&2
    exit 1
  fi
done

export IMAGE_BUILD_ID SOURCE_DATE_EPOCH BUILDROOT_VERSION BUILDROOT_SHA256 LLVM_VERSION
export V86_NPM_VERSION V86_COMMIT BIRD_VERSION FRR_VERSION
export PGO_MODE PGO_CONTEXT_SHA PGO_PROFILE_SET_BUILD_KEY_JSON
export BIRD_PROFILE_SHA256_JSON FRR_PROFILE_SHA256_JSON
export V86_WASM_SIZE SEABIOS_SIZE VGABIOS_SIZE BZIMAGE_SIZE
export V86_WASM_OUTPUT_SHA256 SEABIOS_OUTPUT_SHA256 VGABIOS_OUTPUT_SHA256 BZIMAGE_SHA256

sed \
  -e "s/@IMAGE_BUILD_ID@/$IMAGE_BUILD_ID/g" \
  -e "s/@SOURCE_DATE_EPOCH@/$SOURCE_DATE_EPOCH/g" \
  -e "s/@BUILDROOT_VERSION@/$BUILDROOT_VERSION/g" \
  -e "s/@BUILDROOT_SHA256@/$BUILDROOT_SHA256/g" \
  -e "s/@V86_NPM_VERSION@/$V86_NPM_VERSION/g" \
  -e "s/@V86_COMMIT@/$V86_COMMIT/g" \
  -e "s/@BIRD_VERSION@/$BIRD_VERSION/g" \
  -e "s/@FRR_VERSION@/$FRR_VERSION/g" \
  -e "s/@LLVM_VERSION@/$LLVM_VERSION/g" \
  -e "s/@PGO_MODE@/$PGO_MODE/g" \
  -e "s/@PGO_CONTEXT_SHA@/$PGO_CONTEXT_SHA/g" \
  -e "s/@PGO_PROFILE_SET_BUILD_KEY_JSON@/$PGO_PROFILE_SET_BUILD_KEY_JSON/g" \
  -e "s/@BIRD_PROFILE_SHA256_JSON@/$BIRD_PROFILE_SHA256_JSON/g" \
  -e "s/@FRR_PROFILE_SHA256_JSON@/$FRR_PROFILE_SHA256_JSON/g" \
  -e "s/@V86_WASM_SIZE@/$V86_WASM_SIZE/g" \
  -e "s/@SEABIOS_SIZE@/$SEABIOS_SIZE/g" \
  -e "s/@VGABIOS_SIZE@/$VGABIOS_SIZE/g" \
  -e "s/@BZIMAGE_SIZE@/$BZIMAGE_SIZE/g" \
  -e "s/@V86_WASM_OUTPUT_SHA256@/$V86_WASM_OUTPUT_SHA256/g" \
  -e "s/@SEABIOS_OUTPUT_SHA256@/$SEABIOS_OUTPUT_SHA256/g" \
  -e "s/@VGABIOS_OUTPUT_SHA256@/$VGABIOS_OUTPUT_SHA256/g" \
  -e "s/@BZIMAGE_SHA256@/$BZIMAGE_SHA256/g" \
  "$ROOT/artifact-manifest.template.json" >"$DIST/manifest.json"

node "$ROOT/scripts/verify-manifest.mjs" "$DIST/manifest.json" >"$DIST/manifest.sha256"
printf 'Built %s in %s\n' "$IMAGE_BUILD_ID" "$DIST"
