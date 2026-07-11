################################################################################
#
# anycast-clang-toolchain
#
################################################################################

ANYCAST_CLANG_TOOLCHAIN_VERSION = $(LLVM_PROJECT_VERSION)
ANYCAST_CLANG_TOOLCHAIN_SOURCE = compiler-rt-$(ANYCAST_CLANG_TOOLCHAIN_VERSION).src.tar.xz
ANYCAST_CLANG_TOOLCHAIN_SITE = $(LLVM_PROJECT_SITE)
ANYCAST_CLANG_TOOLCHAIN_LICENSE = NCSA MIT
ANYCAST_CLANG_TOOLCHAIN_LICENSE_FILES = LICENSE.TXT
# Spell out toolchain even though target generic packages normally acquire it:
# compiler-rt's configure probes require the completed GCC/glibc staging tree.
ANYCAST_CLANG_TOOLCHAIN_DEPENDENCIES = toolchain host-clang host-lld host-cmake host-ninja
ANYCAST_CLANG_TOOLCHAIN_INSTALL_TARGET = NO
ANYCAST_CLANG_TOOLCHAIN_INSTALL_STAGING = NO
ANYCAST_LLVM_JOBS ?= $(PARALLEL_JOBS)

define ANYCAST_CLANG_TOOLCHAIN_CONFIGURE_CMDS
	gcc_install_dir="$$(dirname "$$($(TARGET_CC) -print-libgcc-file-name)")"; \
	test -f "$$gcc_install_dir/libgcc.a"; \
	$(HOST_DIR)/bin/cmake \
		-S $(@D) \
		-B $(@D)/build \
		-G Ninja \
		-DCMAKE_BUILD_TYPE=Release \
		-DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
		-DCMAKE_C_COMPILER=$(HOST_DIR)/bin/clang \
		-DCMAKE_CXX_COMPILER=$(HOST_DIR)/bin/clang++ \
		-DCMAKE_C_COMPILER_TARGET=$(GNU_TARGET_NAME) \
		-DCMAKE_CXX_COMPILER_TARGET=$(GNU_TARGET_NAME) \
		-DCMAKE_SYSROOT=$(STAGING_DIR) \
		-DCMAKE_C_FLAGS="--gcc-install-dir=$$gcc_install_dir -march=pentiumpro" \
		-DCMAKE_CXX_FLAGS="--gcc-install-dir=$$gcc_install_dir -march=pentiumpro" \
		-DCMAKE_AR=$(HOST_DIR)/bin/llvm-ar \
		-DCMAKE_NM=$(HOST_DIR)/bin/llvm-nm \
		-DCMAKE_RANLIB=$(HOST_DIR)/bin/llvm-ranlib \
		-DLLVM_CONFIG_PATH=$(HOST_DIR)/bin/llvm-config \
		-DCMAKE_MODULE_PATH=$(HOST_DIR)/lib/cmake/llvm \
		-DLLVM_DIR=$(HOST_DIR)/lib/cmake/llvm \
		-DLLVM_COMMON_CMAKE_UTILS=$(HOST_DIR)/lib/cmake/llvm \
		-DCOMPILER_RT_STANDALONE_BUILD=ON \
		-DCOMPILER_RT_DEFAULT_TARGET_ONLY=ON \
		-DCOMPILER_RT_BUILD_BUILTINS=OFF \
		-DCOMPILER_RT_BUILD_SANITIZERS=OFF \
		-DCOMPILER_RT_BUILD_XRAY=OFF \
		-DCOMPILER_RT_BUILD_LIBFUZZER=OFF \
		-DCOMPILER_RT_BUILD_PROFILE=ON \
		-DCOMPILER_RT_BUILD_CTX_PROFILE=OFF \
		-DCOMPILER_RT_BUILD_MEMPROF=OFF \
		-DCOMPILER_RT_BUILD_ORC=OFF \
		-DCOMPILER_RT_BUILD_GWP_ASAN=OFF \
		-DCOMPILER_RT_INCLUDE_TESTS=OFF
endef

define ANYCAST_CLANG_TOOLCHAIN_BUILD_CMDS
	$(HOST_DIR)/bin/cmake --build $(@D)/build --target profile --parallel $(ANYCAST_LLVM_JOBS)
	test -f $(@D)/build/lib/linux/libclang_rt.profile-i386.a
	runtime_dir="$$($(HOST_DIR)/bin/clang --target=$(GNU_TARGET_NAME) --print-runtime-dir)"; \
	case "$$runtime_dir" in "$(HOST_DIR)"/*) ;; \
		*) printf 'Unsafe Clang runtime directory: %s\n' "$$runtime_dir" >&2; exit 1 ;; \
	esac; \
	$(INSTALL) -D -m 0644 \
		$(@D)/build/lib/linux/libclang_rt.profile-i386.a \
		"$$runtime_dir/libclang_rt.profile.a"; \
	resolved="$$($(HOST_DIR)/bin/clang --target=$(GNU_TARGET_NAME) --print-file-name=libclang_rt.profile.a)"; \
	test "$$resolved" = "$$runtime_dir/libclang_rt.profile.a"; \
	test -s "$$resolved"
endef

$(eval $(generic-package))
