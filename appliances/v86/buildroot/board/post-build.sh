#!/bin/sh
set -eu

target_dir=$1

readelf=${HOST_DIR:?Buildroot must export HOST_DIR}/bin/i686-buildroot-linux-gnu-readelf
objcopy=$HOST_DIR/bin/i686-buildroot-linux-gnu-objcopy
if [ ! -x "$readelf" ] || [ ! -x "$objcopy" ]; then
  echo 'Missing target binutils required for rootfs metadata cleanup' >&2
  exit 1
fi

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
  # Buildroot removes empty target directories during finalization. The FRR
  # package is the first retained owner of /usr/libexec in some clean builds,
  # so recreate the destination instead of relying on an overlay placeholder.
  install -d -m 0755 "$target_dir/usr/libexec"
  install -m 0755 "$target_dir/etc/init.d/S50frr" \
    "$target_dir/usr/libexec/anycastlab-frr"
  rm -f "$target_dir/etc/init.d/S50frr"
fi

# Keep the boot surface limited to syslog and the native appliance service.
# Network links and forwarding sysctls are applied by the injected start script;
# cloned immutable guests must not run a shared seed file, cron, module loading,
# or a second ifupdown configuration path.
rm -f \
  "$target_dir/etc/init.d/S01seedrng" \
  "$target_dir/etc/init.d/S02klogd" \
  "$target_dir/etc/init.d/S02sysctl" \
  "$target_dir/etc/init.d/S11modules" \
  "$target_dir/etc/init.d/S40network" \
  "$target_dir/etc/init.d/S50crond"
rm -rf \
  "$target_dir/etc/network" \
  "$target_dir/lib/modules" \
  "$target_dir/usr/share/udhcpc" \
  "$target_dir/var/lib/seedrng"

# Remove package tools that have no executable runtime in this appliance.  FRR
# still retains its real daemons, vtysh, service scripts, YANG modules and shared
# libraries; BIRD retains both control clients.  The Python reload helper was
# already unusable because the target intentionally contains no Python runtime.
rm -f \
  "$target_dir/sbin/ctstat" \
  "$target_dir/sbin/genl" \
  "$target_dir/sbin/ifstat" \
  "$target_dir/sbin/lnstat" \
  "$target_dir/sbin/nstat" \
  "$target_dir/sbin/rtacct" \
  "$target_dir/sbin/rtmon" \
  "$target_dir/sbin/routel" \
  "$target_dir/sbin/rtstat" \
  "$target_dir/usr/bin/clockdiff" \
  "$target_dir/usr/bin/pcre2grep" \
  "$target_dir/usr/bin/pcre2test" \
  "$target_dir/usr/bin/tracepath" \
  "$target_dir/usr/bin/yanglint" \
  "$target_dir/usr/bin/yangre" \
  "$target_dir/usr/sbin/arping" \
  "$target_dir/usr/sbin/ethtool" \
  "$target_dir/usr/sbin/frr-reload" \
  "$target_dir/usr/sbin/frr-reload.py" \
  "$target_dir/usr/sbin/frr_babeltrace.py" \
  "$target_dir/usr/sbin/generate_support_bundle.py"
rm -rf \
  "$target_dir/usr/share/bash-completion" \
  "$target_dir/usr/share/metainfo/org.kernel.software.network.ethtool.metainfo.xml"

# These optional companion libraries are normally pulled in by package-level
# dependencies even though no retained program links them.  Re-evaluate that
# assumption against every target ELF on each build: an upstream dependency
# change must retain a newly used library instead of producing a broken image.
needed_libraries=$(mktemp "${TMPDIR:-/tmp}/anycast-rootfs-needed.XXXXXX")
trap 'rm -f "$needed_libraries"' 0 1 2 15
find "$target_dir" -xdev -type f -print | while IFS= read -r file; do
  "$readelf" --dynamic "$file" 2>/dev/null || :
done | sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' |
  LC_ALL=C sort -u >"$needed_libraries"

prune_unused_library_family() {
  family=$1
  for library in "$target_dir/usr/lib/$family.so"*; do
    [ -e "$library" ] || [ -L "$library" ] || continue
    if grep -Fxq "${library##*/}" "$needed_libraries"; then
      return
    fi
  done
  rm -f "$target_dir/usr/lib/$family.so"*
}

for family in libform libmenu libpanel libpcre2-posix libpsx; do
  prune_unused_library_family "$family"
done
rm -f "$needed_libraries"
trap - 0 1 2 15

# A reused Buildroot output directory does not uninstall files from newly
# disabled packages.  Force the curated BusyBox ping applets into place so an
# old iputils binary can neither survive nor reintroduce setuid permissions.
ln -sf busybox "$target_dir/bin/ping"
ln -sf busybox "$target_dir/bin/ping6"

# Never bake training scratch files (or any other host/build leftovers) into a
# fresh guest. Runtime PGO creates its private directory after boot.
install -d -m 1777 "$target_dir/tmp" "$target_dir/var/tmp"
find "$target_dir/tmp" "$target_dir/var/tmp" -mindepth 1 -delete

# PGO provenance remains in the unstripped package build ELFs consumed by
# verify-optimized-daemons.sh.  Remove the target copies before packing so the
# browser artifact does not retain absolute profile/build paths. Preserve file
# dates to keep the reproducible-rootfs contract intact.
find "$target_dir" -xdev -type f -print | while IFS= read -r file; do
  if "$readelf" --sections "$file" 2>/dev/null | grep -Fq '.GCC.command.line'; then
    "$objcopy" --preserve-dates --remove-section=.GCC.command.line "$file"
  fi
done

chmod 0755 \
  "$target_dir/etc/init.d/S20anycastlab" \
  "$target_dir/usr/sbin/anycast-labd"
rm -f \
  "$target_dir/usr/libexec/anycastlab-agent" \
  "$target_dir/usr/libexec/anycastlab-shell"

# Browser terminals are independent PTYs opened inside each node's PID/mount
# namespaces by anycast-labd.  A host-namespace serial shell would defeat that
# isolation and retain an otherwise idle shell forever, so remove the template
# or a stale output tree's previous direct-shell entry.
template_serial=$(grep -c '# GENERIC_SERIAL$' "$target_dir/etc/inittab" || :)
direct_serial=$(grep -Fxc 'ttyS0::respawn:/usr/libexec/anycastlab-shell' \
  "$target_dir/etc/inittab" || :)
case "$template_serial:$direct_serial" in
  1:0|0:1|0:0) ;;
  *)
    echo 'Buildroot serial inittab template drifted' >&2
    exit 1
    ;;
esac
sed -i \
  '\|# GENERIC_SERIAL$|d;\|ttyS0::respawn:/usr/libexec/anycastlab-shell|d;\|/sbin/swapon -a|d;\|/sbin/swapoff -a|d' \
  "$target_dir/etc/inittab"

# Apply the policy to the real target tree as well as to the later fakeroot
# metadata. post-fakeroot.sh repeats this after package permission tables run.
find "$target_dir" -xdev -type f \( -perm -4000 -o -perm -2000 \) \
  -exec chmod a-s {} +
