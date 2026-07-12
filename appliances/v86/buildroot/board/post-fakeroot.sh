#!/bin/sh
set -eu

target_dir=$1

# Buildroot's monolithic BusyBox permission table requests mode 4755 even when
# no configured applet needs privilege escalation. Package permission tables
# are applied after post-build, so enforce the appliance's no-setuid policy in
# the fakeroot phase immediately before any filesystem image is generated.
find "$target_dir" -xdev -type f \( -perm -4000 -o -perm -2000 \) \
  -exec chmod a-s {} +

if find "$target_dir" -xdev -type f \( -perm -4000 -o -perm -2000 \) \
  -print -quit | grep -q .; then
  echo 'Setuid or setgid file survived appliance fakeroot hardening' >&2
  exit 1
fi
