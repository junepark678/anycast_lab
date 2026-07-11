include $(sort $(wildcard $(BR2_EXTERNAL_ANYCAST_LAB_PATH)/package/*/*.mk))

# BIRD and FRR deliberately use a Clang/LLD frontend over Buildroot's GCC-built
# i686 glibc sysroot.  Keep this package-local: the kernel, libc and the rest of
# the image continue to use Buildroot's supported GCC toolchain.
ANYCAST_PGO_MODE ?= none
ANYCAST_TARGET_TRIPLE = i686-buildroot-linux-gnu
ANYCAST_TARGET_CPU = pentiumpro
ANYCAST_CLANG = $(HOST_DIR)/bin/clang
ANYCAST_LLD = $(HOST_DIR)/bin/ld.lld
ANYCAST_LLVM_AR = $(HOST_DIR)/bin/llvm-ar
ANYCAST_LLVM_NM = $(HOST_DIR)/bin/llvm-nm
ANYCAST_LLVM_RANLIB = $(HOST_DIR)/bin/llvm-ranlib
ANYCAST_GCC_INSTALL_DIR = $(patsubst %/,%,$(dir $(shell $(TARGET_CC) -print-libgcc-file-name)))

ANYCAST_COMMON_CFLAGS = \
	$(filter-out -O%,$(TARGET_CFLAGS)) \
	-O3 -march=$(ANYCAST_TARGET_CPU) -flto=thin
ANYCAST_COMMON_LDFLAGS = \
	$(TARGET_LDFLAGS) \
	-O3 -march=$(ANYCAST_TARGET_CPU) -flto=thin -fuse-ld=lld \
	-Wl,--defsym=__anycast_clang_$(subst .,_,$(LLVM_PROJECT_VERSION))=1 \
	-Wl,--export-dynamic-symbol=__anycast_clang_$(subst .,_,$(LLVM_PROJECT_VERSION)) \
	-Wl,--defsym=__anycast_o3_thinlto=1 \
	-Wl,--export-dynamic-symbol=__anycast_o3_thinlto

ifeq ($(ANYCAST_PGO_MODE),none)
ANYCAST_BIRD_PGO_FLAGS =
ANYCAST_FRR_PGO_FLAGS =
ANYCAST_PGO_MARKER = none
else ifeq ($(ANYCAST_PGO_MODE),generate)
ANYCAST_BIRD_PGO_FLAGS = -fprofile-generate=/tmp/anycast-pgo -fprofile-update=atomic
ANYCAST_FRR_PGO_FLAGS = -fprofile-generate=/tmp/anycast-pgo -fprofile-update=atomic
ANYCAST_PGO_MARKER = generate
else ifeq ($(ANYCAST_PGO_MODE),use)
ifeq ($(strip $(ANYCAST_BIRD_PROFILE)),)
$(error ANYCAST_BIRD_PROFILE is required when ANYCAST_PGO_MODE=use)
endif
ifeq ($(strip $(ANYCAST_FRR_PROFILE)),)
$(error ANYCAST_FRR_PROFILE is required when ANYCAST_PGO_MODE=use)
endif
ANYCAST_PROFILE_USE_WARNINGS = \
	-Werror=profile-instr-out-of-date
ANYCAST_BIRD_PGO_FLAGS = \
	-fprofile-use=$(ANYCAST_BIRD_PROFILE) $(ANYCAST_PROFILE_USE_WARNINGS)
ANYCAST_FRR_PGO_FLAGS = \
	-fprofile-use=$(ANYCAST_FRR_PROFILE) $(ANYCAST_PROFILE_USE_WARNINGS)
ANYCAST_PGO_MARKER = use
else
$(error Unsupported ANYCAST_PGO_MODE '$(ANYCAST_PGO_MODE)'; expected none, generate or use)
endif

ANYCAST_PGO_LDFLAGS = \
	-Wl,--defsym=__anycast_pgo_$(ANYCAST_PGO_MARKER)=1 \
	-Wl,--export-dynamic-symbol=__anycast_pgo_$(ANYCAST_PGO_MARKER)
ANYCAST_CC = \
	$(ANYCAST_CLANG) \
	--target=$(ANYCAST_TARGET_TRIPLE) \
	--sysroot=$(STAGING_DIR) \
	--gcc-install-dir=$(ANYCAST_GCC_INSTALL_DIR) \
	--ld-path=$(ANYCAST_LLD) \
	-Qunused-arguments

# Keep Buildroot's target sysroot, hardening and reproducibility flags while
# selecting the pinned host Clang directly. Disable ccache only for these two
# packages: profile contents can change at a stable path and must never reuse a
# stale object.
BIRD_CONF_ENV += \
	BR2_USE_CCACHE=0 \
	CC="$(ANYCAST_CC)" \
	CPP="$(ANYCAST_CC) -E" \
	AR="$(ANYCAST_LLVM_AR)" \
	LD="$(ANYCAST_LLD)" \
	NM="$(ANYCAST_LLVM_NM)" \
	RANLIB="$(ANYCAST_LLVM_RANLIB)" \
	CFLAGS="$(ANYCAST_COMMON_CFLAGS) -D_GNU_SOURCE $(ANYCAST_BIRD_PGO_FLAGS)" \
	LDFLAGS="$(ANYCAST_COMMON_LDFLAGS) $(ANYCAST_BIRD_PGO_FLAGS) $(ANYCAST_PGO_LDFLAGS)"
BIRD_MAKE_ENV += BR2_USE_CCACHE=0

FRR_CONF_ENV += \
	BR2_USE_CCACHE=0 \
	CC="$(ANYCAST_CC)" \
	CPP="$(ANYCAST_CC) -E" \
	AR="$(ANYCAST_LLVM_AR)" \
	LD="$(ANYCAST_LLD)" \
	NM="$(ANYCAST_LLVM_NM)" \
	RANLIB="$(ANYCAST_LLVM_RANLIB)" \
	CFLAGS="$(ANYCAST_COMMON_CFLAGS) -DFRR_XREF_NO_NOTE $(ANYCAST_FRR_PGO_FLAGS)" \
	LDFLAGS="$(ANYCAST_COMMON_LDFLAGS) $(ANYCAST_FRR_PGO_FLAGS) $(ANYCAST_PGO_LDFLAGS)"
FRR_MAKE_ENV += BR2_USE_CCACHE=0

# external.mk is loaded after Buildroot has expanded the upstream BIRD/FRR
# package definitions, so a late *_DEPENDENCIES append would not affect their
# configure stamps. Explicit order-only prerequisites keep the host-only LLVM
# suite and i386 profiling runtime out of the target package graph/rootfs.
$(BIRD_TARGET_CONFIGURE) $(FRR_TARGET_CONFIGURE): | anycast-clang-toolchain
