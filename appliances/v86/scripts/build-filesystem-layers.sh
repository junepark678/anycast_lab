#!/usr/bin/env sh
set -eu

if [ "$#" -ne 12 ]; then
  echo 'usage: build-filesystem-layers.sh TARGET OUTPUT WORK BUILDROOT_BUILD MKUSERS_COMMANDS MAKEDEVS DEVICE_TABLE MKSQUASHFS UNSQUASHFS READELF SOURCE_DATE_EPOCH NODE' >&2
  exit 2
fi

TARGET=$1
OUTPUT=$2
WORK=$3
BUILDROOT_BUILD=$4
MKUSERS_COMMANDS=$5
MAKEDEVS=$6
DEVICE_TABLE=$7
MKSQUASHFS=$8
UNSQUASHFS=$9
READELF=${10}
SOURCE_DATE_EPOCH=${11}
NODE=${12}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

for required_file in "$MKUSERS_COMMANDS" "$DEVICE_TABLE"; do
  if [ ! -f "$required_file" ]; then
    printf 'Required Buildroot filesystem metadata is missing: %s\n' "$required_file" >&2
    exit 1
  fi
done
for required_executable in \
  "$MAKEDEVS" \
  "$MKSQUASHFS" \
  "$UNSQUASHFS" \
  "$READELF" \
  "$ROOT/buildroot/board/post-fakeroot.sh"; do
  if [ ! -x "$required_executable" ]; then
    printf 'Required filesystem build tool is unavailable: %s\n' "$required_executable" >&2
    exit 1
  fi
done

# Match Buildroot's fs/common.mk fakeroot preparation. These ownership changes
# are virtual when this script is run by host-fakeroot, but are visible to tar
# and mksquashfs along with package user/device-table permissions.
chown -h -R 0:0 "$TARGET"
sh "$MKUSERS_COMMANDS"
"$MAKEDEVS" -d "$DEVICE_TABLE" "$TARGET"
# Package permission tables are applied by makedevs after post-build. Run the
# board's final fakeroot policy here as Buildroot does for its own filesystem
# backends, otherwise BusyBox/iputils permissions can silently restore SUID.
"$ROOT/buildroot/board/post-fakeroot.sh" "$TARGET"

# Volatile runtime state must never leak into content-addressed layers. This is
# also what Buildroot's standard filesystem image rules do before serialization.
for volatile_directory in "$TARGET/run" "$TARGET/tmp"; do
  if [ -d "$volatile_directory" ]; then
    find "$volatile_directory" -mindepth 1 -prune -print0 | xargs -0r rm -rf --
  fi
done
find "$TARGET" -print0 | xargs -0r touch -h -d "@$SOURCE_DATE_EPOCH"

LC_ALL=C TZ=UTC SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH \
  "$NODE" "$ROOT/scripts/build-filesystem-layers.mjs" \
    --target "$TARGET" \
    --output "$OUTPUT" \
    --work "$WORK" \
    --buildroot-build "$BUILDROOT_BUILD" \
    --mksquashfs "$MKSQUASHFS" \
    --unsquashfs "$UNSQUASHFS" \
    --readelf "$READELF" \
    --source-date-epoch "$SOURCE_DATE_EPOCH"
