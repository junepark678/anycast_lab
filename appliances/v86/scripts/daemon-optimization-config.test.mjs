// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');

describe('Clang daemon optimization build contract', () => {
  it('uses explicit O3 ThinLTO/LLD flags for both BIRD and FRR in every mode', async () => {
    const makefile = await readFile(resolve(root, 'buildroot/external.mk'), 'utf8');
    expect(makefile).toContain('ANYCAST_COMMON_CFLAGS =');
    expect(makefile).toContain('-O3 -march=$(ANYCAST_TARGET_CPU) -flto=thin');
    expect(makefile).toContain('-fuse-ld=lld');
    expect(makefile).toContain('-Wl,-z,pack-relative-relocs');
    expect(makefile).toContain('--sysroot=$(STAGING_DIR)');
    expect(makefile).toContain('ANYCAST_LLD = $(HOST_DIR)/bin/ld.lld');
    expect(makefile).toContain('--ld-path=$(ANYCAST_LLD)');
    expect(makefile).toContain('-Qunused-arguments');
    expect(makefile.match(/LD="\$\(ANYCAST_LLD\)"/g)).toHaveLength(2);
    expect(makefile.match(/CPP="\$\(ANYCAST_CC\) -E"/g)).toHaveLength(2);
    expect(makefile).toContain('ANYCAST_BIRD_PGO_CFLAGS = -fprofile-generate=/tmp/anycast-pgo -fprofile-update=atomic');
    expect(makefile).toContain('ANYCAST_FRR_GENERATE_CFLAGS =');
    expect(makefile).toContain('-fprofile-use=$(ANYCAST_BIRD_PROFILE)');
    for (const component of ['LIBFRR', 'LIBMGMT_BE_NB', 'BGPD', 'ZEBRA', 'OSPFD']) {
      expect(makefile).toContain(`-fprofile-use=$(ANYCAST_FRR_${component}_PROFILE)`);
      expect(makefile).toContain(`ANYCAST_FRR_${component}_PGO_CFLAGS=`);
      expect(makefile).toContain(`ANYCAST_FRR_${component}_PGO_LDFLAGS=`);
    }
    expect(makefile).toContain('-Werror=profile-instr-out-of-date');
    expect(makefile).toContain('-Werror=backend-plugin');
    expect(makefile.match(/-frecord-command-line/g)).toHaveLength(1);
    expect(makefile).toContain('$(ANYCAST_PGO_RECORD_CFLAGS)');
    expect(makefile).toContain('ANYCAST_PGO_RECORD_CFLAGS = -frecord-command-line');
    expect(makefile).not.toContain('-Werror=profile-instr-missing');
    expect(makefile.match(/BR2_USE_CCACHE=0/g)).toHaveLength(4);
    expect(makefile).toContain('CFLAGS="$(ANYCAST_COMMON_CFLAGS) -D_GNU_SOURCE"');
    expect(makefile).toContain('CFLAGS="$(ANYCAST_COMMON_CFLAGS) -DFRR_XREF_NO_NOTE"');
    expect(makefile).toContain('--enable-user=root');
    expect(makefile).toContain('--enable-group=root');
    expect(makefile).toContain('--enable-vty-group=root');
    expect(makefile).not.toContain('CFLAGS="$(ANYCAST_COMMON_CFLAGS) -D_GNU_SOURCE $(');
    expect(makefile).not.toContain('CFLAGS="$(ANYCAST_COMMON_CFLAGS) -DFRR_XREF_NO_NOTE $(');
    expect(makefile).toContain('$(BIRD_TARGET_CONFIGURE) $(FRR_TARGET_CONFIGURE): | anycast-clang-toolchain');
    const defconfig = await readFile(resolve(root, 'buildroot/configs/anycast_lab_v86_defconfig'), 'utf8');
    expect(defconfig).toContain('# BR2_PACKAGE_LIBCAP is not set');
    expect(defconfig).not.toMatch(/^BR2_PACKAGE_LIBCAP=y$/m);
  });

  it('applies PGO only to trained BIRD and FRR build targets', async () => {
    const birdPatch = await readFile(
      resolve(root, 'buildroot/patches/bird/0001-scope-pgo-to-daemon.patch'),
      'utf8',
    );
    const frrPatch = await readFile(
      resolve(root, 'buildroot/patches/frr/0001-scope-pgo-to-trained-components.patch'),
      'utf8',
    );
    const defconfig = await readFile(resolve(root, 'buildroot/configs/anycast_lab_v86_defconfig'), 'utf8');
    expect(defconfig).toContain('$(BR2_EXTERNAL_ANYCAST_LAB_PATH)/patches');
    expect(birdPatch).toContain('$(daemon): CFLAGS += $(ANYCAST_BIRD_PGO_CFLAGS)');
    expect(birdPatch).toContain('$(daemon): LDFLAGS += $(ANYCAST_BIRD_PGO_LDFLAGS)');
    expect(birdPatch).not.toContain('$(client): CFLAGS');
    for (const target of [
      'lib_libfrr_la',
      'mgmtd_libmgmt_be_nb_la',
      'bgpd_libbgp_a',
      'bgpd_bgpd',
      'zebra_zebra',
      'ospfd_libfrrospf_a',
      'ospfd_libfrrospfclient_a',
      'ospfd_ospfd',
    ]) {
      expect(frrPatch).toContain(`${target}_CFLAGS`);
    }
    expect(frrPatch).toContain(
      'bgpd_bgp_btoa_LDFLAGS = $(AM_LDFLAGS) $(ANYCAST_FRR_BGPD_PGO_LDFLAGS)',
    );
    expect(frrPatch).toContain(
      'ospfclient_ospfclient_LDFLAGS = $(AM_LDFLAGS) $(ANYCAST_FRR_OSPFD_PGO_LDFLAGS)',
    );
    for (const test of [
      'aspath',
      'bgp_table',
      'capability',
      'ecommunity',
      'mp_attr',
      'packet',
      'peer_attr',
    ]) {
      expect(frrPatch).toContain(
        `tests_bgpd_test_${test}_LDFLAGS = $(AM_LDFLAGS) $(ANYCAST_FRR_BGPD_PGO_LDFLAGS)`,
      );
    }
    expect(frrPatch).toContain(
      'tests_ospfd_test_ospf_spf_LDFLAGS = $(AM_LDFLAGS) $(ANYCAST_FRR_OSPFD_PGO_LDFLAGS)',
    );
    expect(frrPatch).toContain(
      'bgpd_bgpd_LDFLAGS = $(AM_LDFLAGS) $(ANYCAST_FRR_BGPD_PGO_LDFLAGS)',
    );
    expect(frrPatch).toContain(
      'zebra_zebra_LDFLAGS = $(AM_LDFLAGS) $(ANYCAST_FRR_ZEBRA_PGO_LDFLAGS)',
    );
    expect(frrPatch).toContain(
      'ospfd_ospfd_LDFLAGS = $(AM_LDFLAGS) $(ANYCAST_FRR_OSPFD_PGO_LDFLAGS)',
    );
    expect(frrPatch).not.toContain('staticd_staticd_CFLAGS');
    expect(frrPatch).not.toContain('vtysh_vtysh_CFLAGS');
    expect(frrPatch).toContain('!defined(ANYCAST_LLVM_IR_PGO)');
  });

  it('builds a pinned profile-only i386 runtime after the complete GCC/glibc staging toolchain', async () => {
    const packageMakefile = await readFile(
      resolve(root, 'buildroot/package/anycast-clang-toolchain/anycast-clang-toolchain.mk'),
      'utf8',
    );
    const hashes = await readFile(
      resolve(root, 'buildroot/package/anycast-clang-toolchain/anycast-clang-toolchain.hash'),
      'utf8',
    );
    expect(packageMakefile).toContain('DEPENDENCIES = toolchain host-clang host-lld host-cmake host-ninja');
    expect(packageMakefile).toContain('INSTALL_TARGET = NO');
    expect(packageMakefile).toContain('ANYCAST_LLVM_JOBS ?= $(PARALLEL_JOBS)');
    expect(packageMakefile).toContain('CMAKE_C_COMPILER_TARGET=$(GNU_TARGET_NAME)');
    expect(packageMakefile).toContain('CMAKE_SYSROOT=$(STAGING_DIR)');
    expect(packageMakefile).toContain('CMAKE_MODULE_PATH=$(HOST_DIR)/lib/cmake/llvm');
    expect(packageMakefile).toContain('COMPILER_RT_DEFAULT_TARGET_ONLY=ON');
    expect(packageMakefile).not.toContain('COMPILER_RT_DEFAULT_TARGET_TRIPLE=');
    expect(packageMakefile).not.toContain('LLVM_MAIN_SRC_DIR=');
    expect(packageMakefile).toContain('COMPILER_RT_BUILD_PROFILE=ON');
    for (const disabled of ['BUILTINS', 'SANITIZERS', 'XRAY', 'LIBFUZZER', 'CTX_PROFILE', 'MEMPROF', 'ORC', 'GWP_ASAN']) {
      expect(packageMakefile).toContain(`COMPILER_RT_BUILD_${disabled}=OFF`);
    }
    expect(packageMakefile).toContain('libclang_rt.profile-i386.a');
    expect(packageMakefile).toContain('--print-runtime-dir');
    expect(packageMakefile).toContain('--print-file-name=libclang_rt.profile.a');
    expect(packageMakefile).toContain('"$$runtime_dir/libclang_rt.profile.a"');
    expect(packageMakefile).toContain('--parallel $(ANYCAST_LLVM_JOBS)');
    expect(hashes).toContain('dd54ae21aee1780fac59445b51ebff601ad016b31ac3a7de3b21126fd3ccb229');
  });

  it('keeps target LLVM disabled and pins every source identity used by the host suite', async () => {
    const defconfig = await readFile(resolve(root, 'buildroot/configs/anycast_lab_v86_defconfig'), 'utf8');
    expect(defconfig).toContain('# BR2_PACKAGE_LLVM is not set');
    expect(defconfig).toContain('# BR2_PACKAGE_CLANG is not set');
    expect(defconfig).toContain('# BR2_PACKAGE_COMPILER_RT is not set');
    const versions = await readFile(resolve(root, 'versions.env'), 'utf8');
    expect(versions).toMatch(/^LLVM_VERSION=21\.1\.8$/m);
    for (const name of [
      'LLVM_SOURCE_SHA256',
      'LLVM_THIRD_PARTY_SHA256',
      'LLVM_CMAKE_SOURCE_SHA256',
      'CLANG_SOURCE_SHA256',
      'LLD_SOURCE_SHA256',
      'COMPILER_RT_SOURCE_SHA256',
    ]) {
      expect(versions).toMatch(new RegExp(`^${name}=[a-f0-9]{64}$`, 'm'));
    }
  });

  it('discards interactive client profiles only in instrumented namespace terminals', async () => {
    const supervisor = await readFile(resolve(
      root,
      'buildroot/package/anycast-labd/src/labd.c',
    ), 'utf8');
    const terminal = supervisor.slice(
      supervisor.indexOf('static void terminal_helper('),
      supervisor.indexOf('static struct labd_terminal *find_terminal('),
    );
    expect(terminal).toContain('/etc/anycastlab/pgo-generate');
    expect(terminal).toContain('setenv("LLVM_PROFILE_FILE", "/dev/null", 1)');
    expect(terminal.indexOf('setenv("LLVM_PROFILE_FILE", "/dev/null", 1)'))
      .toBeLessThan(terminal.indexOf('execl("/bin/sh"'));
  });

  it('allows instrumented daemons to stop and flush profiles under v86', async () => {
    const supervisor = await readFile(resolve(
      root,
      'buildroot/package/anycast-labd/src/labd.c',
    ), 'utf8');
    const collect = supervisor.slice(
      supervisor.indexOf('if (strcmp(tokens[1], "COLLECT_PGO") == 0)'),
      supervisor.indexOf('response_error(request_id, "UNKNOWN_COMMAND"'),
    );
    expect(collect.indexOf('stop_node(node, &error)'))
      .toBeLessThan(collect.indexOf('export_pgo_profiles(node, &error)'));
    expect(supervisor).toContain('kill(node->launcher_pid, SIGTERM)');
    expect(supervisor).toContain('valid_pgo_name(entry->d_name, node->config.kind)');
    expect(supervisor).toContain('total > 64U * 1024U * 1024U');
  });

  it('invalidates expensive daemon builds with the narrow source key and the selected optimization mode', async () => {
    const build = await readFile(resolve(root, 'scripts/build-image.sh'), 'utf8');
    const cacheKey = await readFile(resolve(root, 'scripts/appliance-cache-key.mjs'), 'utf8');

    expect(cacheKey).toContain('export const DAEMON_CACHE_INPUTS');
    expect(cacheKey).toContain('export async function computeDaemonCacheKey');
    expect(cacheKey).toContain("command === '--daemons'");
    expect(build).toContain('DAEMON_INPUT_SHA=$(node "$ROOT/scripts/appliance-cache-key.mjs" --daemons)');
    expect(build).toContain('DAEMON_PROFILE_KEY=');
    expect(build).toContain('if [ "$PGO_MODE" = use ]; then DAEMON_PROFILE_KEY=$PGO_BUILD_KEY; fi');
    expect(build).toContain("DAEMON_OPTIMIZATION_KEY=$(printf '%s\\n%s\\n%s\\n' \\");
    expect(build).toContain('"$DAEMON_INPUT_SHA" "$PGO_MODE" "$DAEMON_PROFILE_KEY" | sha256sum');
    expect(build.match(/\$PGO_MODE:\$DAEMON_OPTIMIZATION_KEY/g)).toHaveLength(2);
    expect(build).toContain('if [ "$PREVIOUS_OPTIMIZATION" != "$PGO_MODE:$DAEMON_OPTIMIZATION_KEY" ]; then');
    expect(build).toContain("printf '%s\\n' \"$PGO_MODE:$DAEMON_OPTIMIZATION_KEY\" >\"$OPTIMIZATION_STAMP.tmp\"");
    expect(build).toContain('mv "$OPTIMIZATION_STAMP.tmp" "$OPTIMIZATION_STAMP"');
    expect(build).not.toContain('$PGO_MODE:$PGO_BUILD_KEY');
  });

  it('exposes fail-closed shell modes, profile validation, tool provenance, and manifest provenance', async () => {
    const build = await readFile(resolve(root, 'scripts/build-image.sh'), 'utf8');
    expect(build).toContain('PGO_MODE=${ANYCAST_PGO_MODE:-none}');
    expect(build).toContain('PGO_PROFILE_DIR=${ANYCAST_PGO_PROFILE_DIR:-}');
    expect(build.match(/node "\$ROOT\/scripts\/pgo-profile-set\.mjs" validate/g)).toHaveLength(3);
    expect(build).toContain('profile-set.json; do');
    expect(build).toContain('"$PGO_PROFILE_DIR/training-evidence.json"');
    expect(build).toContain('"$VALIDATED_PROFILE_DIR/training-evidence.json"');
    expect(build).toContain('if [ "$SNAPSHOT_BUILD_KEY" != "$PGO_BUILD_KEY" ]; then');
    expect(build).toContain('chmod 0444 "$VALIDATED_PROFILE_DIR"/*.profdata');
    expect(build).toContain('chmod 0555 "$VALIDATED_PROFILE_DIR"');
    expect(build).toContain('PGO_PROFILE_DIR="$VALIDATED_PROFILE_DIR"');
    expect(build).toContain('if [ "$POST_BUILD_PROFILE_KEY" != "$PGO_BUILD_KEY" ]; then');
    expect(build).toContain('pgo-profile-set.mjs" frr-digest');
    expect(build).toContain('buildroot_make bird-dirclean frr-dirclean');
    expect(build).toContain('buildroot_make anycast-labd-dirclean');
    expect(build).toContain('anycast-clang-toolchain');
    expect(build).toContain('verify-optimized-daemons.sh');
    expect(build).toContain('verify-effective-config.mjs');
    for (const profile of [
      'frr-libfrr.profdata',
      'frr-libmgmt-be-nb.profdata',
      'frr-bgpd.profdata',
      'frr-zebra.profdata',
      'frr-ospfd.profdata',
    ]) {
      expect(build).toContain(profile);
    }
    expect(build).toContain('LLVM_JOBS');
    expect(build).toContain('BR2_JLEVEL="$LLVM_JOBS"');
    expect(build).toContain('BR2_JLEVEL="$JOBS"');
    expect(build).toContain('GUEST_MEMORY_BYTES=134217728');
    expect(build).toContain('elif [ "$PGO_MODE" = generate ]; then');
    expect(build).toContain('GUEST_MEMORY_BYTES=268435456');
    expect(build).toContain('s/@GUEST_MEMORY_BYTES@/$GUEST_MEMORY_BYTES/g');
    expect(build).toContain('--print-runtime-dir');
    expect(build).toContain('--print-file-name=libclang_rt.profile.a');
    const manifest = await readFile(resolve(root, 'artifact-manifest.template.json'), 'utf8');
    expect(manifest).toContain('"scope": "bird-and-frr"');
    expect(manifest).toContain('"compilerVersion": "@LLVM_VERSION@"');
    expect(manifest).toContain('"profileSetBuildKey": @PGO_PROFILE_SET_BUILD_KEY_JSON@');
    expect(manifest).toContain('"memoryBytes": @GUEST_MEMORY_BYTES@');
    expect(manifest).toContain('"birdProfileSha256": @BIRD_PROFILE_SHA256_JSON@');
    expect(manifest).toContain('"frrProfileSha256": @FRR_PROFILE_SHA256_JSON@');
  });
});
