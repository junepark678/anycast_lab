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
    expect(makefile).toContain('--sysroot=$(STAGING_DIR)');
    expect(makefile).toContain('ANYCAST_LLD = $(HOST_DIR)/bin/ld.lld');
    expect(makefile).toContain('--ld-path=$(ANYCAST_LLD)');
    expect(makefile).toContain('-Qunused-arguments');
    expect(makefile.match(/LD="\$\(ANYCAST_LLD\)"/g)).toHaveLength(2);
    expect(makefile.match(/CPP="\$\(ANYCAST_CC\) -E"/g)).toHaveLength(2);
    expect(makefile).toContain('ANYCAST_BIRD_PGO_FLAGS = -fprofile-generate=/tmp/anycast-pgo -fprofile-update=atomic');
    expect(makefile).toContain('ANYCAST_FRR_PGO_FLAGS = -fprofile-generate=/tmp/anycast-pgo -fprofile-update=atomic');
    expect(makefile).toContain('-fprofile-use=$(ANYCAST_BIRD_PROFILE)');
    expect(makefile).toContain('-fprofile-use=$(ANYCAST_FRR_PROFILE)');
    expect(makefile).toContain('-Werror=profile-instr-out-of-date');
    expect(makefile).not.toContain('-Werror=profile-instr-missing');
    expect(makefile.match(/BR2_USE_CCACHE=0/g)).toHaveLength(4);
    expect(makefile).toContain('CFLAGS="$(ANYCAST_COMMON_CFLAGS) -D_GNU_SOURCE $(ANYCAST_BIRD_PGO_FLAGS)"');
    expect(makefile).toContain('CFLAGS="$(ANYCAST_COMMON_CFLAGS) -DFRR_XREF_NO_NOTE $(ANYCAST_FRR_PGO_FLAGS)"');
    expect(makefile).toContain('$(BIRD_TARGET_CONFIGURE) $(FRR_TARGET_CONFIGURE): | anycast-clang-toolchain');
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

  it('exposes fail-closed shell modes, profile validation, tool provenance, and manifest provenance', async () => {
    const build = await readFile(resolve(root, 'scripts/build-image.sh'), 'utf8');
    expect(build).toContain('PGO_MODE=${ANYCAST_PGO_MODE:-none}');
    expect(build).toContain('PGO_PROFILE_DIR=${ANYCAST_PGO_PROFILE_DIR:-}');
    expect(build).toContain("node \"$ROOT/scripts/pgo-profile-set.mjs\" validate");
    expect(build).toContain('buildroot_make bird-dirclean frr-dirclean');
    expect(build).toContain('anycast-clang-toolchain');
    expect(build).toContain('verify-optimized-daemons.sh');
    expect(build).toContain('LLVM_JOBS');
    expect(build).toContain('BR2_JLEVEL="$LLVM_JOBS"');
    expect(build).toContain('BR2_JLEVEL="$JOBS"');
    expect(build).toContain('--print-runtime-dir');
    expect(build).toContain('--print-file-name=libclang_rt.profile.a');
    const manifest = await readFile(resolve(root, 'artifact-manifest.template.json'), 'utf8');
    expect(manifest).toContain('"scope": "bird-and-frr"');
    expect(manifest).toContain('"compilerVersion": "@LLVM_VERSION@"');
    expect(manifest).toContain('"profileSetBuildKey": @PGO_PROFILE_SET_BUILD_KEY_JSON@');
    expect(manifest).toContain('"birdProfileSha256": @BIRD_PROFILE_SHA256_JSON@');
    expect(manifest).toContain('"frrProfileSha256": @FRR_PROFILE_SHA256_JSON@');
  });
});
