#!/bin/sh
set -eu

if [ "$#" -lt 5 ] || [ "$#" -gt 7 ]; then
  echo "usage: $0 OUTPUT BIRD_VERSION FRR_VERSION LLVM_VERSION PGO_MODE [BIRD_PROFILE FRR_PROFILE]" >&2
  exit 2
fi

OUTPUT=$1
BIRD_VERSION=$2
FRR_VERSION=$3
LLVM_VERSION=$4
PGO_MODE=$5
BIRD_PROFILE=${6:-}
FRR_PROFILE=${7:-}

READELF=${READELF:-"$OUTPUT/host/bin/i686-buildroot-linux-gnu-readelf"}
LLVM_NM=${LLVM_NM:-"$OUTPUT/host/bin/llvm-nm"}
LLVM_VERSION_SYMBOL=$(printf '%s' "$LLVM_VERSION" | tr . _)

require_text() {
  file=$1
  text=$2
  if ! grep -Fq -- "$text" "$file"; then
    printf 'Missing optimization evidence %s in %s\n' "$text" "$file" >&2
    exit 1
  fi
}

reject_text() {
  file=$1
  text=$2
  if grep -Fq -- "$text" "$file"; then
    printf 'Unexpected optimization evidence %s in %s\n' "$text" "$file" >&2
    exit 1
  fi
}

verify_final_elf() {
  file=$1
  provenance_file=$2
  if [ ! -f "$provenance_file" ]; then
    printf 'Missing unstripped optimization provenance ELF: %s\n' "$provenance_file" >&2
    exit 1
  fi
  header=$($READELF -h "$file")
  comments=$($READELF -p .comment "$provenance_file")
  symbols=$($READELF --wide --dyn-syms "$file")
  sections=$($READELF --wide --sections "$file")
  printf '%s\n' "$header" | grep -Eq 'Class:[[:space:]]+ELF32'
  printf '%s\n' "$header" | grep -Eq 'Machine:[[:space:]]+Intel 80386'
  printf '%s\n' "$comments" | grep -Fq "clang version $LLVM_VERSION"
  printf '%s\n' "$comments" | grep -Fq "Linker: LLD $LLVM_VERSION"
  printf '%s\n' "$symbols" | grep -Fq "__anycast_clang_$LLVM_VERSION_SYMBOL"
  printf '%s\n' "$symbols" | grep -Fq '__anycast_o3_thinlto'
  printf '%s\n' "$symbols" | grep -Fq "__anycast_pgo_$PGO_MODE"
  if [ "$PGO_MODE" = generate ]; then
    printf '%s\n' "$sections" | grep -Fq '__llvm_prf_'
  elif printf '%s\n' "$sections" | grep -Fq '__llvm_prf_'; then
    printf 'Final binary unexpectedly retains LLVM profile sections: %s\n' "$file" >&2
    exit 1
  fi
}

BIRD_CONFIG="$OUTPUT/build/bird-$BIRD_VERSION/config.log"
FRR_CONFIG="$OUTPUT/build/frr-$FRR_VERSION/config.log"
for config in "$BIRD_CONFIG" "$FRR_CONFIG"; do
  test -f "$config"
  require_text "$config" '/bin/clang'
  require_text "$config" '--target=i686-buildroot-linux-gnu'
  require_text "$config" '--sysroot='
  require_text "$config" '--gcc-install-dir='
  require_text "$config" "--ld-path=$OUTPUT/host/bin/ld.lld"
  require_text "$config" '-march=pentiumpro'
  require_text "$config" '-O3'
  require_text "$config" '-flto=thin'
  require_text "$config" '-fuse-ld=lld'
done

case "$PGO_MODE" in
  none)
    reject_text "$BIRD_CONFIG" '-fprofile-generate='
    reject_text "$FRR_CONFIG" '-fprofile-generate='
    reject_text "$BIRD_CONFIG" '-fprofile-use='
    reject_text "$FRR_CONFIG" '-fprofile-use='
    ;;
  generate)
    for config in "$BIRD_CONFIG" "$FRR_CONFIG"; do
      require_text "$config" '-fprofile-generate=/tmp/anycast-pgo'
      require_text "$config" '-fprofile-update=atomic'
    done
    ;;
  use)
    test -n "$BIRD_PROFILE"
    test -n "$FRR_PROFILE"
    require_text "$BIRD_CONFIG" "-fprofile-use=$BIRD_PROFILE"
    require_text "$FRR_CONFIG" "-fprofile-use=$FRR_PROFILE"
    require_text "$BIRD_CONFIG" '-Werror=profile-instr-out-of-date'
    require_text "$FRR_CONFIG" '-Werror=profile-instr-out-of-date'
    ;;
  *)
    printf 'Unsupported PGO mode for verification: %s\n' "$PGO_MODE" >&2
    exit 2
    ;;
esac

BIRD_PROGRAMS='bird birdc birdcl'
verified_bird_programs=0
for program in $BIRD_PROGRAMS; do
  file="$OUTPUT/target/usr/sbin/$program"
  [ -f "$file" ] || continue
  verify_final_elf "$file" "$OUTPUT/build/bird-$BIRD_VERSION/$program"
  verified_bird_programs=$((verified_bird_programs + 1))
done
if [ "$verified_bird_programs" -ne 3 ]; then
  echo 'Expected the BIRD daemon and both control clients' >&2
  exit 1
fi

# FRR has one package-wide configure contract but emits many independently
# linked daemons. Verify every installed program from that package so a custom
# link rule cannot silently fall back to GCC/BFD or drop ThinLTO/PGO.
FRR_PROGRAMS='sbin/babeld:babeld/babeld sbin/bfdd:bfdd/bfdd sbin/bgpd:bgpd/bgpd sbin/eigrpd:eigrpd/eigrpd sbin/fabricd:isisd/fabricd sbin/fpm_listener:zebra/fpm_listener sbin/isisd:isisd/isisd sbin/ldpd:ldpd/ldpd sbin/mgmtd:mgmtd/mgmtd sbin/ospf6d:ospf6d/ospf6d sbin/ospfd:ospfd/ospfd sbin/pathd:pathd/pathd sbin/pbrd:pbrd/pbrd sbin/pim6d:pimd/pim6d sbin/pimd:pimd/pimd sbin/ripd:ripd/ripd sbin/ripngd:ripngd/ripngd sbin/ssd:tools/ssd sbin/staticd:staticd/staticd sbin/vrrpd:vrrpd/vrrpd sbin/watchfrr:watchfrr/watchfrr sbin/zebra:zebra/zebra bin/vtysh:vtysh/vtysh'
verified_frr_programs=0
for pair in $FRR_PROGRAMS; do
  program=${pair%%:*}
  build_program=${pair#*:}
  file="$OUTPUT/target/usr/$program"
  if [ ! -f "$file" ]; then
    printf 'Missing expected FRR executable: %s\n' "$file" >&2
    exit 1
  fi
  verify_final_elf "$file" "$OUTPUT/build/frr-$FRR_VERSION/$build_program"
  verified_frr_programs=$((verified_frr_programs + 1))
done
if [ "$verified_frr_programs" -ne 23 ]; then
  echo 'Expected all 23 pinned FRR executables' >&2
  exit 1
fi

FRR_LIBRARIES='lib/libfrr.so.0.0.0:lib/.libs/libfrr.so.0.0.0 lib/frr/modules/dplane_fpm_nl.so:zebra/.libs/dplane_fpm_nl.so lib/frr/modules/pathd_pcep.so:pathd/.libs/pathd_pcep.so lib/frr/modules/zebra_cumulus_mlag.so:zebra/.libs/zebra_cumulus_mlag.so lib/frr/modules/zebra_fpm.so:zebra/.libs/zebra_fpm.so'
verified_frr_libraries=0
for pair in $FRR_LIBRARIES; do
  library=${pair%%:*}
  build_library=${pair#*:}
  file="$OUTPUT/target/usr/$library"
  if [ ! -f "$file" ]; then
    printf 'Missing expected FRR shared ELF: %s\n' "$file" >&2
    exit 1
  fi
  verify_final_elf "$file" "$OUTPUT/build/frr-$FRR_VERSION/$build_library"
  verified_frr_libraries=$((verified_frr_libraries + 1))
done
if [ "$verified_frr_libraries" -ne 5 ]; then
  echo 'Expected all five pinned FRR shared ELFs' >&2
  exit 1
fi

UNSTRIPPED_BIRD="$OUTPUT/build/bird-$BIRD_VERSION/bird"
UNSTRIPPED_BGPD="$OUTPUT/build/frr-$FRR_VERSION/bgpd/bgpd"
UNSTRIPPED_ZEBRA="$OUTPUT/build/frr-$FRR_VERSION/zebra/zebra"
for file in "$UNSTRIPPED_BIRD" "$UNSTRIPPED_BGPD" "$UNSTRIPPED_ZEBRA"; do
  test -x "$file"
  if [ "$PGO_MODE" = generate ]; then
    if ! "$LLVM_NM" "$file" | grep -Fq '__llvm_profile_runtime'; then
      printf 'Instrumented binary lacks compiler-rt profile runtime: %s\n' "$file" >&2
      exit 1
    fi
  elif "$LLVM_NM" "$file" | grep -Fq '__llvm_profile_runtime'; then
    printf 'Final binary unexpectedly retains profile runtime: %s\n' "$file" >&2
    exit 1
  fi
done

if find "$OUTPUT/target" -name 'libclang_rt*' -print -quit | grep -q .; then
  echo 'Host-only compiler-rt leaked into the target root filesystem' >&2
  exit 1
fi

MARKER="$OUTPUT/target/etc/anycastlab/pgo-generate"
if [ "$PGO_MODE" = generate ]; then
  test -f "$MARKER"
  test ! -L "$MARKER"
  test "$(cat "$MARKER")" = 'llvm-ir-pgo-generate-v1'
else
  test ! -e "$MARKER"
fi

printf 'Verified Clang %s O3 ThinLTO PGO mode %s for %s BIRD executables, %s FRR executables, and %s FRR shared ELFs (%s/%s)\n' \
  "$LLVM_VERSION" "$PGO_MODE" "$verified_bird_programs" "$verified_frr_programs" "$verified_frr_libraries" \
  "$BIRD_VERSION" "$FRR_VERSION"
