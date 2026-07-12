#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: $0 OUTPUT" >&2
  exit 2
fi

output=$1
target=$output/target
archive=$output/images/rootfs.cpio
readelf=${READELF:-$output/host/bin/i686-buildroot-linux-gnu-readelf}

fail() {
  echo "Rootfs policy violation: $*" >&2
  exit 1
}

[ -d "$target" ] || fail "missing target tree $target"
[ -x "$readelf" ] || fail "missing target readelf $readelf"

for required in \
  bin/bash \
  bin/busybox \
  bin/stty \
  sbin/bridge \
  sbin/ip \
  sbin/ss \
  sbin/tc \
  usr/bin/tcpdump \
  usr/bin/traceroute \
  usr/bin/vtysh \
  usr/libexec/anycastlab-frr \
  usr/sbin/anycast-labd \
  usr/sbin/bgpd \
  usr/sbin/bird \
  usr/sbin/birdc \
  usr/sbin/birdcl \
  usr/sbin/frrinit.sh \
  usr/sbin/frrcommon.sh \
  usr/sbin/frr \
  usr/sbin/ospfd \
  usr/sbin/watchfrr.sh \
  usr/sbin/zebra; do
  [ -x "$target/$required" ] || fail "required executable is missing: /$required"
done

[ -L "$target/bin/ping" ] && [ "$(readlink "$target/bin/ping")" = busybox ] || \
  fail '/bin/ping is not the curated BusyBox applet'
[ -L "$target/bin/ping6" ] && [ "$(readlink "$target/bin/ping6")" = busybox ] || \
  fail '/bin/ping6 is not the curated BusyBox applet'

for forbidden in \
  etc/init.d/S01seedrng \
  etc/init.d/S02klogd \
  etc/init.d/S02sysctl \
  etc/init.d/S11modules \
  etc/init.d/S40network \
  etc/init.d/S50crond \
  lib/modules \
  sbin/ctstat \
  sbin/genl \
  sbin/ifstat \
  sbin/lnstat \
  sbin/nstat \
  sbin/rtacct \
  sbin/rtmon \
  sbin/routel \
  sbin/rtstat \
  usr/bin/clockdiff \
  usr/bin/pcre2grep \
  usr/bin/pcre2test \
  usr/bin/tracepath \
  usr/bin/yanglint \
  usr/bin/yangre \
  usr/sbin/arping \
  usr/sbin/ethtool \
  usr/sbin/frr-reload \
  usr/sbin/frr-reload.py \
  usr/sbin/frr_babeltrace.py \
  usr/sbin/generate_support_bundle.py \
  usr/share/bash-completion; do
  [ ! -e "$target/$forbidden" ] && [ ! -L "$target/$forbidden" ] || \
    fail "pruned path survived: /$forbidden"
done

[ -x "$target/etc/init.d/S01syslogd" ] || fail 'syslog service is missing'
[ -x "$target/etc/init.d/S20anycastlab" ] || fail 'native appliance service is missing'
[ "$(sed -n 's/^SYSLOGD_ARGS=//p' "$target/etc/default/syslogd")" = \
  '"-O /run/messages -s 64 -b 1"' ] || fail 'syslog is not bounded to writable tmpfs'
[ "$(grep -Ec '^[[:space:]]*ttyS0:.*:respawn:' "$target/etc/inittab")" -eq 0 ] || \
  fail 'host serial shell survived namespace-supervisor pruning'
if grep -Eq '^[^#].*(/sbin/(getty|swapon|swapoff)|-o remount,rw /)' "$target/etc/inittab"; then
  fail 'getty, swap, or writable-root action survived inittab pruning'
fi
for removed_host_agent in \
  usr/libexec/anycastlab-agent \
  usr/libexec/anycastlab-shell; do
  [ ! -e "$target/$removed_host_agent" ] && [ ! -L "$target/$removed_host_agent" ] || \
    fail "obsolete per-VM host agent survived: /$removed_host_agent"
done

if find "$target" -xdev -type f \( -perm -4000 -o -perm -2000 \) \
  -print -quit | grep -q .; then
  find "$target" -xdev -type f \( -perm -4000 -o -perm -2000 \) -print >&2
  fail 'target tree contains setuid or setgid files'
fi

if find "$target/tmp" "$target/var/tmp" -mindepth 1 -print -quit | grep -q .; then
  fail 'target scratch directories are not empty'
fi

find "$target" -xdev -type f -print | while IFS= read -r file; do
  if "$readelf" --sections "$file" 2>/dev/null | grep -Fq '.GCC.command.line'; then
    printf 'Target ELF retains .GCC.command.line: %s\n' "$file" >&2
    exit 1
  fi
done

# Check both sides of the runtime dependency contract after pruning. This is
# intentionally based on the packed target tree, not Buildroot package
# metadata: it catches SONAME drift, broken interpreter links and executable
# scripts whose runtime was accidentally culled.
needed=$(mktemp)
dependency_violations=$(mktemp)
trap 'rm -f "$needed" "$dependency_violations"' 0 1 2 15
find "$target" -xdev -type f -print | while IFS= read -r file; do
  relative=${file#"$target"}
  "$readelf" --dynamic "$file" 2>/dev/null |
    sed -n 's/.*Shared library: \[\([^]]*\)\].*/\1/p' |
    while IFS= read -r library; do
      printf '%s\n' "$library" >>"$needed"
      if [ ! -e "$target/lib/$library" ] &&
        [ ! -e "$target/usr/lib/$library" ] &&
        [ ! -e "$target/usr/lib/frr/$library" ]; then
        printf '%s needs missing %s\n' "$relative" "$library" \
          >>"$dependency_violations"
      fi
    done

  interpreter=$("$readelf" --program-headers "$file" 2>/dev/null |
    sed -n 's/.*Requesting program interpreter: \([^]]*\)].*/\1/p' |
    head -n 1)
  if [ -n "$interpreter" ] && [ ! -x "$target$interpreter" ]; then
    printf '%s requests missing interpreter %s\n' "$relative" "$interpreter" \
      >>"$dependency_violations"
  fi

  [ -x "$file" ] || continue
  IFS= read -r first_line <"$file" || first_line=
  case "$first_line" in
    '#!'*)
      shebang=${first_line#\#!}
      # Intentional field splitting: the first shebang word is the interpreter.
      set -- $shebang
      script_interpreter=${1:-}
      if [ -z "$script_interpreter" ] ||
        [ "${script_interpreter#/}" = "$script_interpreter" ] ||
        [ ! -x "$target$script_interpreter" ]; then
        printf '%s has unavailable shebang interpreter %s\n' \
          "$relative" "${script_interpreter:-<empty>}" >>"$dependency_violations"
      elif [ "$script_interpreter" = /usr/bin/env ]; then
        shift
        while [ "$#" -gt 0 ] && [ "${1#-}" != "$1" ]; do shift; done
        command=${1:-}
        command_path=
        for directory in bin sbin usr/bin usr/sbin; do
          if [ -n "$command" ] && [ -x "$target/$directory/$command" ]; then
            command_path=$target/$directory/$command
            break
          fi
        done
        if [ -z "$command_path" ]; then
          printf '%s invokes unavailable env command %s\n' \
            "$relative" "${command:-<empty>}" >>"$dependency_violations"
        fi
      fi
      ;;
  esac
done

LC_ALL=C sort -u "$needed" -o "$needed"
if [ -s "$dependency_violations" ]; then
  cat "$dependency_violations" >&2
  fail 'target runtime dependency closure is incomplete'
fi

# Optional ncurses/PCRE/libcap companions may be retained if a future package
# actually links them, but otherwise their presence means pruning regressed.
for family in libform libmenu libpanel libpcre2-posix libpsx; do
  present=false
  referenced=false
  for library in "$target/usr/lib/$family.so"*; do
    [ -e "$library" ] || [ -L "$library" ] || continue
    present=true
    if grep -Fxq "${library##*/}" "$needed"; then referenced=true; fi
  done
  if [ "$present" = true ] && [ "$referenced" = false ]; then
    fail "unreferenced companion library survived: $family"
  fi
done

for bash_script in \
  usr/sbin/frr \
  usr/sbin/frrcommon.sh \
  usr/sbin/frrinit.sh \
  usr/sbin/watchfrr.sh; do
  IFS= read -r first_line <"$target/$bash_script" || first_line=
  [ "$first_line" = '#!/bin/bash' ] || fail "/$bash_script lost its Bash contract"
done

verbose=$(mktemp)
names=$(mktemp)
trap 'rm -f "$needed" "$dependency_violations" "$verbose" "$names"' 0 1 2 15
if [ -f "$archive" ]; then
  LC_ALL=C cpio -itv <"$archive" >"$verbose" 2>/dev/null
  LC_ALL=C cpio -it <"$archive" >"$names" 2>/dev/null

  privileged=$(awk 'substr($1,4,1) ~ /[sS]/ || substr($1,7,1) ~ /[sS]/ { print }' "$verbose")
  if [ -n "$privileged" ]; then
    printf '%s\n' "$privileged" >&2
    fail 'cpio artifact contains setuid or setgid files'
  fi

  scratch=$(awk '/^(tmp|var\/tmp)\// { print }' "$names")
  if [ -n "$scratch" ]; then
    printf '%s\n' "$scratch" >&2
    fail 'cpio artifact contains stale scratch files'
  fi
fi

printf 'Verified curated, dependency-complete, non-setuid appliance rootfs'
if [ -f "$archive" ]; then printf ' and cpio artifact'; fi
printf '\n'
