#!/bin/sh
set -eu

if [ "$#" -lt 5 ] || [ "$#" -gt 6 ]; then
  echo "usage: $0 OUTPUT BIRD_VERSION FRR_VERSION LLVM_VERSION PGO_MODE [PROFILE_DIR]" >&2
  exit 2
fi

OUTPUT=$1
BIRD_VERSION=$2
FRR_VERSION=$3
LLVM_VERSION=$4
PGO_MODE=$5
PROFILE_DIR=${6:-}

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
  pgo_scope=$3
  expected_profile=${4:-}
  if [ ! -f "$provenance_file" ]; then
    printf 'Missing unstripped optimization provenance ELF: %s\n' "$provenance_file" >&2
    exit 1
  fi
  header=$($READELF -h "$file")
  comments=$($READELF -p .comment "$provenance_file")
  symbols=$($READELF --wide --dyn-syms "$file")
  final_sections=$($READELF --wide --sections "$file")
  provenance_sections=$($READELF --wide --sections "$provenance_file")
  provenance_symbols=$($LLVM_NM "$provenance_file")
  printf '%s\n' "$header" | grep -Eq 'Class:[[:space:]]+ELF32'
  printf '%s\n' "$header" | grep -Eq 'Machine:[[:space:]]+Intel 80386'
  printf '%s\n' "$comments" | grep -Fq "clang version $LLVM_VERSION"
  printf '%s\n' "$comments" | grep -Fq "Linker: LLD $LLVM_VERSION"
  printf '%s\n' "$symbols" | grep -Fq "__anycast_clang_$LLVM_VERSION_SYMBOL"
  printf '%s\n' "$symbols" | grep -Fq '__anycast_o3_thinlto'

  pgo_symbols=$(printf '%s\n' "$symbols" | grep -F '__anycast_pgo_' || :)
  if [ "$pgo_scope" = selected ]; then
    if ! printf '%s\n' "$pgo_symbols" | grep -Eq "__anycast_pgo_${PGO_MODE}([[:space:]]|$)"; then
      printf 'PGO-selected ELF lacks mode marker __anycast_pgo_%s: %s\n' "$PGO_MODE" "$file" >&2
      exit 1
    fi
    if printf '%s\n' "$pgo_symbols" | grep -Ev "__anycast_pgo_${PGO_MODE}([[:space:]]|$)" >/dev/null; then
      printf 'PGO-selected ELF retains an unexpected anycast PGO mode marker: %s\n' "$file" >&2
      exit 1
    fi
  elif [ -n "$pgo_symbols" ]; then
    printf 'PGO-unselected ELF unexpectedly carries an anycast PGO marker: %s\n' "$file" >&2
    exit 1
  fi

  if [ "$pgo_scope" = selected ] && [ "$PGO_MODE" = generate ]; then
    if ! printf '%s\n' "$final_sections" | grep -Fq '__llvm_prf_'; then
      printf 'PGO-selected generate ELF lacks LLVM profile sections: %s\n' "$file" >&2
      exit 1
    fi
    if ! printf '%s\n' "$provenance_sections" | grep -Fq '__llvm_prf_'; then
      printf 'PGO-selected unstripped generate ELF lacks LLVM profile sections: %s\n' \
        "$provenance_file" >&2
      exit 1
    fi
    if ! printf '%s\n' "$provenance_symbols" | grep -Fq '__llvm_profile_runtime'; then
      printf 'PGO-selected generate ELF lacks compiler-rt profile runtime: %s\n' \
        "$provenance_file" >&2
      exit 1
    fi
  else
    if printf '%s\n%s\n' "$final_sections" "$provenance_sections" | grep -Fq '__llvm_prf_'; then
      printf 'PGO-%s ELF unexpectedly retains LLVM profile sections: %s\n' "$pgo_scope" "$file" >&2
      exit 1
    fi
    if printf '%s\n' "$provenance_symbols" | grep -Fq '__llvm_profile_runtime'; then
      printf 'PGO-%s ELF unexpectedly retains compiler-rt profile runtime: %s\n' \
        "$pgo_scope" "$provenance_file" >&2
      exit 1
    fi
  fi

  if [ "$PGO_MODE" = use ]; then
    if ! recorded_commands=$($READELF -p .GCC.command.line "$provenance_file" 2>/dev/null); then
      printf 'PGO-use ELF lacks recorded Clang compile provenance: %s\n' \
        "$provenance_file" >&2
      exit 1
    fi
    profile_use_tokens=$(printf '%s\n' "$recorded_commands" | \
      grep -Eo -- '-fprofile-(instr-)?use(=[^[:space:]]+)?' | LC_ALL=C sort -u || :)
    if [ "$pgo_scope" = selected ]; then
      if [ -z "$expected_profile" ]; then
        printf 'PGO-selected use ELF lacks an expected component profile path: %s\n' "$file" >&2
        exit 1
      fi
      expected_token="-fprofile-use=$expected_profile"
      if [ "$profile_use_tokens" != "$expected_token" ]; then
        printf 'PGO-selected use ELF has an invalid component profile set\nExpected: %s\nActual: %s\nELF: %s\n' \
          "$expected_token" "$profile_use_tokens" "$provenance_file" >&2
        exit 1
      fi
    elif [ -n "$profile_use_tokens" ]; then
      printf 'PGO-unselected use ELF contains profile-use compile flags %s: %s\n' \
        "$profile_use_tokens" "$provenance_file" >&2
      exit 1
    fi
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

for config in "$BIRD_CONFIG" "$FRR_CONFIG"; do
  # PGO is deliberately attached to a small target whitelist. Profile flags in
  # the package-wide configure contract would silently instrument every client,
  # daemon, and plugin again.
  reject_text "$config" '-fprofile-generate='
  reject_text "$config" '-fprofile-use='
done

case "$PGO_MODE" in
  none|generate)
    ;;
  use)
    if [ -z "$PROFILE_DIR" ] || [ ! -d "$PROFILE_DIR" ]; then
      printf 'PGO use verification requires the validated profile directory: %s\n' "$PROFILE_DIR" >&2
      exit 1
    fi
    for profile_file in \
      bird.profdata \
      frr-libfrr.profdata \
      frr-libmgmt-be-nb.profdata \
      frr-bgpd.profdata \
      frr-zebra.profdata \
      frr-ospfd.profdata; do
      profile="$PROFILE_DIR/$profile_file"
      if [ ! -f "$profile" ] || [ -L "$profile" ]; then
        printf 'PGO use verification requires a regular, non-symlink profile: %s\n' \
          "$profile" >&2
        exit 1
      fi
    done
    ;;
  *)
    printf 'Unsupported PGO mode for verification: %s\n' "$PGO_MODE" >&2
    exit 2
    ;;
esac

BIRD_PROGRAMS='bird:selected birdc:unselected birdcl:unselected'
BIRD_OWNED_ELFS=
verified_bird_programs=0
for pair in $BIRD_PROGRAMS; do
  program=${pair%%:*}
  pgo_scope=${pair#*:}
  file="$OUTPUT/target/usr/sbin/$program"
  [ -f "$file" ] || continue
  expected_profile=
  if [ "$pgo_scope" = selected ] && [ "$PGO_MODE" = use ]; then
    expected_profile="$PROFILE_DIR/bird.profdata"
  fi
  verify_final_elf \
    "$file" "$OUTPUT/build/bird-$BIRD_VERSION/$program" "$pgo_scope" "$expected_profile"
  BIRD_OWNED_ELFS="$BIRD_OWNED_ELFS usr/sbin/$program"
  verified_bird_programs=$((verified_bird_programs + 1))
done
if [ "$verified_bird_programs" -ne 3 ]; then
  echo 'Expected the BIRD daemon and both control clients' >&2
  exit 1
fi

# FRR has one package-wide configure contract but emits many independently
# linked daemons. Verify every installed program from that package so a custom
# link rule cannot silently fall back to GCC/BFD or drop ThinLTO/PGO.
FRR_PROGRAMS='sbin/babeld:babeld/babeld:unselected sbin/bfdd:bfdd/bfdd:unselected sbin/bgpd:bgpd/bgpd:selected sbin/eigrpd:eigrpd/eigrpd:unselected sbin/fabricd:isisd/fabricd:unselected sbin/fpm_listener:zebra/fpm_listener:unselected sbin/isisd:isisd/isisd:unselected sbin/ldpd:ldpd/ldpd:unselected sbin/mgmtd:mgmtd/mgmtd:unselected bin/mtracebis:pimd/mtracebis:unselected sbin/ospf6d:ospf6d/ospf6d:unselected sbin/ospfd:ospfd/ospfd:selected sbin/pathd:pathd/pathd:unselected sbin/pbrd:pbrd/pbrd:unselected sbin/pim6d:pimd/pim6d:unselected sbin/pimd:pimd/pimd:unselected sbin/ripd:ripd/ripd:unselected sbin/ripngd:ripngd/ripngd:unselected sbin/ssd:tools/ssd:unselected sbin/staticd:staticd/staticd:unselected sbin/vrrpd:vrrpd/vrrpd:unselected sbin/watchfrr:watchfrr/watchfrr:unselected sbin/zebra:zebra/zebra:selected bin/vtysh:vtysh/vtysh:unselected'
FRR_OWNED_ELFS=
verified_frr_programs=0
for pair in $FRR_PROGRAMS; do
  program=${pair%%:*}
  remainder=${pair#*:}
  build_program=${remainder%%:*}
  pgo_scope=${remainder#*:}
  file="$OUTPUT/target/usr/$program"
  if [ ! -f "$file" ]; then
    printf 'Missing expected FRR executable: %s\n' "$file" >&2
    exit 1
  fi
  expected_profile=
  if [ "$pgo_scope" = selected ] && [ "$PGO_MODE" = use ]; then
    case "$program" in
      sbin/bgpd) expected_profile="$PROFILE_DIR/frr-bgpd.profdata" ;;
      sbin/ospfd) expected_profile="$PROFILE_DIR/frr-ospfd.profdata" ;;
      sbin/zebra) expected_profile="$PROFILE_DIR/frr-zebra.profdata" ;;
      *) printf 'Missing FRR selected-program profile mapping: %s\n' "$program" >&2; exit 1 ;;
    esac
  fi
  verify_final_elf \
    "$file" "$OUTPUT/build/frr-$FRR_VERSION/$build_program" "$pgo_scope" "$expected_profile"
  FRR_OWNED_ELFS="$FRR_OWNED_ELFS usr/$program"
  verified_frr_programs=$((verified_frr_programs + 1))
done
if [ "$verified_frr_programs" -ne 24 ]; then
  echo 'Expected all 24 pinned FRR executables' >&2
  exit 1
fi

FRR_LIBRARIES='lib/libfrr.so.0.0.0:lib/.libs/libfrr.so.0.0.0:selected lib/libmgmt_be_nb.so.0.0.0:mgmtd/.libs/libmgmt_be_nb.so.0.0.0:selected lib/frr/modules/dplane_fpm_nl.so:zebra/.libs/dplane_fpm_nl.so:unselected lib/frr/modules/pathd_pcep.so:pathd/.libs/pathd_pcep.so:unselected lib/frr/modules/zebra_cumulus_mlag.so:zebra/.libs/zebra_cumulus_mlag.so:unselected lib/frr/modules/zebra_fpm.so:zebra/.libs/zebra_fpm.so:unselected'
verified_frr_libraries=0
for pair in $FRR_LIBRARIES; do
  library=${pair%%:*}
  remainder=${pair#*:}
  build_library=${remainder%%:*}
  pgo_scope=${remainder#*:}
  file="$OUTPUT/target/usr/$library"
  if [ ! -f "$file" ]; then
    printf 'Missing expected FRR shared ELF: %s\n' "$file" >&2
    exit 1
  fi
  expected_profile=
  if [ "$pgo_scope" = selected ] && [ "$PGO_MODE" = use ]; then
    case "$library" in
      lib/libfrr.so.0.0.0) expected_profile="$PROFILE_DIR/frr-libfrr.profdata" ;;
      lib/libmgmt_be_nb.so.0.0.0) expected_profile="$PROFILE_DIR/frr-libmgmt-be-nb.profdata" ;;
      *) printf 'Missing FRR selected-library profile mapping: %s\n' "$library" >&2; exit 1 ;;
    esac
  fi
  verify_final_elf \
    "$file" "$OUTPUT/build/frr-$FRR_VERSION/$build_library" "$pgo_scope" "$expected_profile"
  FRR_OWNED_ELFS="$FRR_OWNED_ELFS usr/$library"
  verified_frr_libraries=$((verified_frr_libraries + 1))
done
if [ "$verified_frr_libraries" -ne 6 ]; then
  echo 'Expected all six pinned FRR shared ELFs' >&2
  exit 1
fi

verify_package_elf_inventory() {
  package=$1
  expected_words=$2
  package_files="$OUTPUT/build/packages-file-list.txt"
  if [ ! -f "$package_files" ]; then
    printf 'Missing Buildroot package ownership inventory: %s\n' "$package_files" >&2
    exit 1
  fi
  actual=$(
    while IFS=, read -r owner installed_path; do
      [ "$owner" = "$package" ] || continue
      relative=${installed_path#./}
      installed="$OUTPUT/target/$relative"
      if [ -f "$installed" ] && [ ! -L "$installed" ] && \
        "$READELF" -h "$installed" >/dev/null 2>&1; then
        printf '%s\n' "$relative"
      fi
    done <"$package_files" | LC_ALL=C sort -u
  )
  expected=$(
    for relative in $expected_words; do printf '%s\n' "$relative"; done | LC_ALL=C sort -u
  )
  if [ "$actual" != "$expected" ]; then
    printf 'Package-owned ELF inventory drifted for %s\nExpected:\n%s\nActual:\n%s\n' \
      "$package" "$expected" "$actual" >&2
    exit 1
  fi
}

verify_package_elf_inventory bird "$BIRD_OWNED_ELFS"
verify_package_elf_inventory frr "$FRR_OWNED_ELFS"

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

printf 'Verified Clang %s O3 ThinLTO selective PGO mode %s for %s BIRD executables, %s FRR executables, and %s FRR shared ELFs (%s/%s)\n' \
  "$LLVM_VERSION" "$PGO_MODE" "$verified_bird_programs" "$verified_frr_programs" "$verified_frr_libraries" \
  "$BIRD_VERSION" "$FRR_VERSION"
