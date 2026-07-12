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
FILESYSTEM_WORK="$WORK/filesystem-layers"
FILESYSTEM_OUTPUT="$FILESYSTEM_WORK/output"
PGO_MODE=${ANYCAST_PGO_MODE:-none}
PGO_PROFILE_DIR=${ANYCAST_PGO_PROFILE_DIR:-}
BIRD_PROFILE=
FRR_LIBFRR_PROFILE=
FRR_LIBMGMT_BE_NB_PROFILE=
FRR_BGPD_PROFILE=
FRR_ZEBRA_PROFILE=
FRR_OSPFD_PROFILE=

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
    if [ -d "$VALIDATED_PROFILE_DIR" ]; then
      chmod -R u+w "$VALIDATED_PROFILE_DIR"
    fi
    rm -rf "$VALIDATED_PROFILE_DIR"
    install -d -m 0755 "$VALIDATED_PROFILE_DIR"
    for profile_file in \
      bird.profdata \
      frr-libfrr.profdata \
      frr-libmgmt-be-nb.profdata \
      frr-bgpd.profdata \
      frr-zebra.profdata \
      frr-ospfd.profdata \
      profile-set.json; do
      install -m 0644 "$PGO_PROFILE_DIR/$profile_file" "$VALIDATED_PROFILE_DIR/$profile_file"
    done
    install -m 0600 \
      "$PGO_PROFILE_DIR/training-evidence.json" \
      "$VALIDATED_PROFILE_DIR/training-evidence.json"
    SNAPSHOT_BUILD_KEY=$(node "$ROOT/scripts/pgo-profile-set.mjs" validate \
      --root "$ROOT" --profile-dir "$VALIDATED_PROFILE_DIR")
    if [ "$SNAPSHOT_BUILD_KEY" != "$PGO_BUILD_KEY" ]; then
      echo 'PGO profile set changed while creating the validated build snapshot' >&2
      exit 1
    fi
    chmod 0444 "$VALIDATED_PROFILE_DIR"/*.profdata "$VALIDATED_PROFILE_DIR/profile-set.json"
    chmod 0400 "$VALIDATED_PROFILE_DIR/training-evidence.json"
    chmod 0555 "$VALIDATED_PROFILE_DIR"
    PGO_PROFILE_DIR="$VALIDATED_PROFILE_DIR"
    BIRD_PROFILE="$VALIDATED_PROFILE_DIR/bird.profdata"
    FRR_LIBFRR_PROFILE="$VALIDATED_PROFILE_DIR/frr-libfrr.profdata"
    FRR_LIBMGMT_BE_NB_PROFILE="$VALIDATED_PROFILE_DIR/frr-libmgmt-be-nb.profdata"
    FRR_BGPD_PROFILE="$VALIDATED_PROFILE_DIR/frr-bgpd.profdata"
    FRR_ZEBRA_PROFILE="$VALIDATED_PROFILE_DIR/frr-zebra.profdata"
    FRR_OSPFD_PROFILE="$VALIDATED_PROFILE_DIR/frr-ospfd.profdata"
    ;;
  none|generate)
    PGO_BUILD_KEY=$(printf '%s\n%s\n' "$PGO_CONTEXT_SHA" "$PGO_MODE" | sha256sum | cut -d' ' -f1)
    ;;
esac

# PGO profile provenance intentionally covers the browser training corpus, but
# those inputs do not change the daemon machine code in none/generate mode.
# Use a narrower source/toolchain key for the expensive BIRD/FRR rebuild stamp;
# optimized builds additionally commit to the validated profile set.
DAEMON_INPUT_SHA=$(node "$ROOT/scripts/appliance-cache-key.mjs" --daemons)
DAEMON_PROFILE_KEY=
if [ "$PGO_MODE" = use ]; then DAEMON_PROFILE_KEY=$PGO_BUILD_KEY; fi
DAEMON_OPTIMIZATION_KEY=$(printf '%s\n%s\n%s\n' \
  "$DAEMON_INPUT_SHA" "$PGO_MODE" "$DAEMON_PROFILE_KEY" | sha256sum | cut -d' ' -f1)

PGO_PROFILE_SET_BUILD_KEY_JSON=null
BIRD_PROFILE_SHA256_JSON=null
FRR_PROFILE_SHA256_JSON=null
GUEST_MEMORY_BYTES=134217728
if [ "$PGO_MODE" = use ]; then
  PGO_PROFILE_SET_BUILD_KEY_JSON=\"$PGO_BUILD_KEY\"
elif [ "$PGO_MODE" = generate ]; then
  # LLVM instrumentation and its in-memory counter/profile buffers need more
  # headroom than the stripped production daemons during browser-side training.
  GUEST_MEMORY_BYTES=268435456
fi

buildroot_make() {
  make -C "$BUILDROOT" O="$OUTPUT" BR2_EXTERNAL="$ROOT/buildroot" \
    BR2_DL_DIR="$BUILDROOT_DOWNLOADS" BR2_LOCALVERSION="$BUILDROOT_VERSION" \
    ANYCAST_PGO_MODE="$PGO_MODE" \
    ANYCAST_BIRD_PROFILE="$BIRD_PROFILE" \
    ANYCAST_FRR_LIBFRR_PROFILE="$FRR_LIBFRR_PROFILE" \
    ANYCAST_FRR_LIBMGMT_BE_NB_PROFILE="$FRR_LIBMGMT_BE_NB_PROFILE" \
    ANYCAST_FRR_BGPD_PROFILE="$FRR_BGPD_PROFILE" \
    ANYCAST_FRR_ZEBRA_PROFILE="$FRR_ZEBRA_PROFILE" \
    ANYCAST_FRR_OSPFD_PROFILE="$FRR_OSPFD_PROFILE" \
    "$@"
}

export SOURCE_DATE_EPOCH
buildroot_make anycast_lab_v86_defconfig

# Buildroot deliberately preserves images emitted by a backend that was later
# disabled.  This appliance used to build an initramfs, so an incremental tree
# can otherwise retain an obsolete rootfs.cpio (including its old permission
# table) even though the current external-root configuration builds no CPIO or
# tar filesystem.  Remove only those disabled monolithic image families; the
# kernel image and independently verified SquashFS layers are produced below.
for stale_rootfs_image in \
  "$OUTPUT/images/rootfs.cpio" \
  "$OUTPUT/images/rootfs.cpio".* \
  "$OUTPUT/images/rootfs.tar" \
  "$OUTPUT/images/rootfs.tar".*; do
  if [ -e "$stale_rootfs_image" ] || [ -L "$stale_rootfs_image" ]; then
    rm -f -- "$stale_rootfs_image"
  fi
done

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
  for profile in \
    "$BIRD_PROFILE" \
    "$FRR_LIBFRR_PROFILE" \
    "$FRR_LIBMGMT_BE_NB_PROFILE" \
    "$FRR_BGPD_PROFILE" \
    "$FRR_ZEBRA_PROFILE" \
    "$FRR_OSPFD_PROFILE"; do
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
if [ "$PREVIOUS_OPTIMIZATION" != "$PGO_MODE:$DAEMON_OPTIMIZATION_KEY" ]; then
  buildroot_make bird-dirclean frr-dirclean
fi
# Buildroot intentionally stamps local-source packages after their first rsync,
# so source edits alone do not invalidate an incremental output tree. The
# supervisor is tiny; rebuild it unconditionally to prevent a stale guest ABI.
buildroot_make anycast-labd-dirclean

buildroot_make -j"$JOBS" BR2_JLEVEL="$JOBS"
# The logical filesystem layers use Buildroot's own host tools and permission
# tables, but are emitted independently from its monolithic rootfs targets.
# Keeping rootfs-common explicit also supports configurations that no longer
# build an embedded initramfs.
buildroot_make -j"$JOBS" BR2_JLEVEL="$JOBS" rootfs-common host-squashfs

single_effective_config() {
  label=$1
  shift
  result=
  for candidate in "$@"; do
    [ -f "$candidate" ] || continue
    if [ -n "$result" ]; then
      printf 'Multiple effective %s configurations found: %s and %s\n' \
        "$label" "$result" "$candidate" >&2
      exit 1
    fi
    result=$candidate
  done
  if [ -z "$result" ]; then
    printf 'Effective %s configuration is missing\n' "$label" >&2
    exit 1
  fi
  printf '%s\n' "$result"
}
KERNEL_EFFECTIVE_CONFIG=$(single_effective_config linux \
  "$OUTPUT"/build/linux-[0-9]*/.config)
BUSYBOX_EFFECTIVE_CONFIG=$(single_effective_config busybox \
  "$OUTPUT"/build/busybox-*/.config)
node "$ROOT/scripts/verify-effective-config.mjs" \
  --buildroot "$OUTPUT/.config" \
  --busybox "$BUSYBOX_EFFECTIVE_CONFIG" \
  --kernel "$KERNEL_EFFECTIVE_CONFIG"
if [ "$PGO_MODE" = use ]; then
  POST_BUILD_PROFILE_KEY=$(node "$ROOT/scripts/pgo-profile-set.mjs" validate \
    --root "$ROOT" --profile-dir "$PGO_PROFILE_DIR")
  if [ "$POST_BUILD_PROFILE_KEY" != "$PGO_BUILD_KEY" ]; then
    echo 'Validated PGO profile snapshot changed during the optimized build' >&2
    exit 1
  fi
  BIRD_PROFILE_SHA256_JSON=\"$(sha256sum "$BIRD_PROFILE" | cut -d' ' -f1)\"
  # frrProfileSha256 commits to the named, ordered component-shard digests
  # without incorporating machine-specific absolute profile paths.
  FRR_PROFILE_SHA256_JSON=\"$(node "$ROOT/scripts/pgo-profile-set.mjs" frr-digest \
    --root "$ROOT" --profile-dir "$PGO_PROFILE_DIR")\"
fi
buildroot_make ccache-stats

# Guard the integration seams that Buildroot package/layout changes could
# otherwise turn into silent no-ops in post-build.sh.
if grep -Eq '^[[:space:]]*ttyS0:.*:respawn:' "$OUTPUT/target/etc/inittab"; then
  echo 'Host serial respawn survived namespace-supervisor pruning' >&2
  exit 1
fi
for required_executable in \
  "$OUTPUT/target/usr/libexec/anycastlab-frr" \
  "$OUTPUT/target/usr/sbin/anycast-labd" \
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
  "$PGO_PROFILE_DIR"
"$ROOT/scripts/verify-rootfs-policy.sh" "$OUTPUT"

rm -rf "$FILESYSTEM_WORK"
mkdir -p "$FILESYSTEM_OUTPUT" "$FILESYSTEM_WORK/staging"
BR2_CONFIG="$OUTPUT/.config" PATH="$OUTPUT/host/bin:$PATH" \
  "$BUILDROOT/support/scripts/mkusers" \
    "$OUTPUT/build/buildroot-fs/full_users_table.txt" \
    "$OUTPUT/target" >"$FILESYSTEM_WORK/mkusers.sh"
PATH="$OUTPUT/host/bin:$PATH" FAKEROOTDONTTRYCHOWN=1 \
  "$OUTPUT/host/bin/fakeroot" -- \
    "$ROOT/scripts/build-filesystem-layers.sh" \
      "$OUTPUT/target" \
      "$FILESYSTEM_OUTPUT" \
      "$FILESYSTEM_WORK/staging" \
      "$OUTPUT/build" \
      "$FILESYSTEM_WORK/mkusers.sh" \
      "$OUTPUT/host/bin/makedevs" \
      "$OUTPUT/build/buildroot-fs/full_devices_table.txt" \
      "$OUTPUT/host/bin/mksquashfs" \
      "$OUTPUT/host/bin/unsquashfs" \
      "$OUTPUT/host/bin/i686-buildroot-linux-gnu-readelf" \
      "$SOURCE_DATE_EPOCH" \
      "$(command -v node)"
for layer_file in \
  rootfs-complete.squashfs \
  rootfs-base.squashfs \
  rootfs-bird.squashfs \
  rootfs-frr.squashfs \
  rootfs-toolbox.squashfs; do
  install -m 0644 "$FILESYSTEM_OUTPUT/$layer_file" "$DIST/$layer_file"
done
FILESYSTEM_JSON=$(node -e '
  const { readFileSync } = require("node:fs");
  process.stdout.write(JSON.stringify(JSON.parse(readFileSync(process.argv[1], "utf8"))));
' "$FILESYSTEM_OUTPUT/filesystem.json")
FILESYSTEM_JSON_SED=$(printf '%s' "$FILESYSTEM_JSON" | sed 's/[&|]/\\&/g')
FILESYSTEM_LAYER_SIZES=$(node -e '
  const { readFileSync } = require("node:fs");
  const filesystem = JSON.parse(readFileSync(process.argv[1], "utf8"));
  process.stdout.write(filesystem.layers.map((layer) => layer.size).join(" "));
' "$FILESYSTEM_OUTPUT/filesystem.json")

printf '%s\n' "$PGO_MODE:$DAEMON_OPTIMIZATION_KEY" >"$OPTIMIZATION_STAMP.tmp"
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
for artifact_size in \
  "$V86_WASM_SIZE" \
  "$SEABIOS_SIZE" \
  "$VGABIOS_SIZE" \
  "$BZIMAGE_SIZE" \
  $FILESYSTEM_LAYER_SIZES; do
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
export GUEST_MEMORY_BYTES

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
  -e "s/@GUEST_MEMORY_BYTES@/$GUEST_MEMORY_BYTES/g" \
  -e "s/@V86_WASM_SIZE@/$V86_WASM_SIZE/g" \
  -e "s/@SEABIOS_SIZE@/$SEABIOS_SIZE/g" \
  -e "s/@VGABIOS_SIZE@/$VGABIOS_SIZE/g" \
  -e "s/@BZIMAGE_SIZE@/$BZIMAGE_SIZE/g" \
  -e "s/@V86_WASM_OUTPUT_SHA256@/$V86_WASM_OUTPUT_SHA256/g" \
  -e "s/@SEABIOS_OUTPUT_SHA256@/$SEABIOS_OUTPUT_SHA256/g" \
  -e "s/@VGABIOS_OUTPUT_SHA256@/$VGABIOS_OUTPUT_SHA256/g" \
  -e "s/@BZIMAGE_SHA256@/$BZIMAGE_SHA256/g" \
  -e "s|@FILESYSTEM_JSON@|$FILESYSTEM_JSON_SED|g" \
  "$ROOT/artifact-manifest.template.json" >"$DIST/manifest.json"

node "$ROOT/scripts/verify-manifest.mjs" \
  --require-filesystem "$DIST/manifest.json" >"$DIST/manifest.sha256"
printf 'Built %s in %s\n' "$IMAGE_BUILD_ID" "$DIST"
