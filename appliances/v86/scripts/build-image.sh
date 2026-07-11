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

mkdir -p "$DOWNLOADS" "$BUILDROOT_DOWNLOADS" "$DIST"

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

export SOURCE_DATE_EPOCH
make -C "$BUILDROOT" O="$OUTPUT" BR2_EXTERNAL="$ROOT/buildroot" \
  BR2_DL_DIR="$BUILDROOT_DOWNLOADS" BR2_LOCALVERSION="$BUILDROOT_VERSION" \
  anycast_lab_v86_defconfig
make -C "$BUILDROOT" O="$OUTPUT" BR2_EXTERNAL="$ROOT/buildroot" \
  BR2_DL_DIR="$BUILDROOT_DOWNLOADS" BR2_LOCALVERSION="$BUILDROOT_VERSION" \
  -j"$JOBS"
make -C "$BUILDROOT" O="$OUTPUT" BR2_EXTERNAL="$ROOT/buildroot" \
  BR2_DL_DIR="$BUILDROOT_DOWNLOADS" BR2_LOCALVERSION="$BUILDROOT_VERSION" \
  ccache-stats

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

export IMAGE_BUILD_ID SOURCE_DATE_EPOCH BUILDROOT_VERSION BUILDROOT_SHA256
export V86_NPM_VERSION V86_COMMIT BIRD_VERSION FRR_VERSION
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
