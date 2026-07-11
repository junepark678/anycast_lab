#!/bin/sh
set -eu

target_dir=$1

case "${ANYCAST_PGO_MODE:-none}" in
  generate)
    install -d -m 0755 "$target_dir/etc/anycastlab"
    marker="$target_dir/etc/anycastlab/pgo-generate"
    temporary="$marker.tmp.$$"
    trap 'rm -f "$temporary"' 0 1 2 15
    printf '%s\n' 'llvm-ir-pgo-generate-v1' >"$temporary"
    chmod 0444 "$temporary"
    mv -f "$temporary" "$marker"
    trap - 0 1 2 15
    ;;
  none|use)
    rm -f "$target_dir/etc/anycastlab/pgo-generate"
    ;;
  *)
    printf 'Unsupported ANYCAST_PGO_MODE in post-build: %s\n' "$ANYCAST_PGO_MODE" >&2
    exit 1
    ;;
esac

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
