#!/bin/sh
set -eu

target_dir=$1

# The lab starts only the daemon selected by the node's native boot request.
# Running FRR's default service in every image would race config injection and
# conflict with BIRD nodes, since the image deliberately contains both suites.
if [ -f "$target_dir/etc/init.d/S50frr" ]; then
  cp "$target_dir/etc/init.d/S50frr" "$target_dir/usr/libexec/anycastlab-frr"
  chmod 0755 "$target_dir/usr/libexec/anycastlab-frr"
  rm -f "$target_dir/etc/init.d/S50frr"
fi

chmod 0755 \
  "$target_dir/etc/init.d/S20anycastlab" \
  "$target_dir/usr/libexec/anycastlab-agent" \
  "$target_dir/usr/libexec/anycastlab-shell"

# Buildroot's serial getty normally execs /bin/sh directly. Route it through a
# tiny marker-emitting wrapper so the browser never accepts terminal input
# before getty is actually ready.
sed -i 's|-l /bin/sh |-l /usr/libexec/anycastlab-shell |' "$target_dir/etc/inittab"
