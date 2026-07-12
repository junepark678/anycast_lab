// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  parseKconfig,
  verifyEffectiveBuildrootConfig,
  verifyEffectiveBusyboxConfig,
  verifyEffectiveKernelConfig,
} from './verify-effective-config.mjs';

const lines = (values) => `${Object.entries(values).map(([name, value]) => (
  value === 'n' ? `# ${name} is not set` : `${name}=${value}`
)).join('\n')}\n`;

const validBuildroot = lines({
  BR2_x86_pentiumpro: 'y',
  BR2_TOOLCHAIN_BUILDROOT_GLIBC: 'y',
  BR2_PIC_PIE: 'y',
  BR2_RELRO_FULL: 'y',
  BR2_REPRODUCIBLE: 'y',
  BR2_TARGET_GENERIC_REMOUNT_ROOTFS_RW: 'n',
  BR2_TARGET_GENERIC_GETTY: 'n',
  BR2_ROOTFS_DEVICE_CREATION_DYNAMIC_DEVTMPFS: 'y',
  BR2_TARGET_ROOTFS_INITRAMFS: 'n',
  BR2_TARGET_ROOTFS_CPIO: 'n',
  BR2_TARGET_ROOTFS_TAR: 'n',
  BR2_PACKAGE_BUSYBOX: 'y',
  BR2_PACKAGE_BUSYBOX_CONFIG: '"/source/board/busybox-shared.config"',
  BR2_PACKAGE_IFUPDOWN_SCRIPTS: 'n',
  BR2_PACKAGE_URANDOM_SCRIPTS: 'n',
  BR2_PACKAGE_IPROUTE2: 'y',
  BR2_PACKAGE_IPUTILS: 'n',
  BR2_PACKAGE_ETHTOOL: 'n',
  BR2_PACKAGE_BASH: 'y',
  BR2_PACKAGE_BIRD: 'y',
  BR2_PACKAGE_FRR: 'y',
  BR2_PACKAGE_ANYCAST_LABD: 'y',
  BR2_PACKAGE_LLVM: 'n',
  BR2_PACKAGE_CLANG: 'n',
  BR2_PACKAGE_COMPILER_RT: 'n',
});

const validBusybox = lines({
  CONFIG_PIE: 'y',
  CONFIG_FEATURE_SUID: 'n',
  CONFIG_GETTY: 'n',
  CONFIG_INIT: 'y',
  CONFIG_ASH: 'y',
  CONFIG_MOUNT: 'y',
  CONFIG_UMOUNT: 'y',
  CONFIG_STTY: 'y',
  CONFIG_PING: 'y',
  CONFIG_PING6: 'y',
  CONFIG_SYSLOGD: 'y',
  CONFIG_FEATURE_ROTATE_LOGFILE: 'y',
  CONFIG_TAR: 'n',
  CONFIG_GZIP: 'n',
  CONFIG_GUNZIP: 'n',
  CONFIG_ZCAT: 'n',
  CONFIG_BASE64: 'n',
});

const validKernel = readFileSync(
  resolve(import.meta.dirname, '../buildroot/board/linux.config'),
  'utf8',
);

describe('effective appliance Kconfig verification', () => {
  it('accepts the resolved Buildroot, BusyBox, and moduleless Linux contracts', () => {
    expect(() => verifyEffectiveBuildrootConfig(validBuildroot)).not.toThrow();
    expect(() => verifyEffectiveBusyboxConfig(validBusybox)).not.toThrow();
    expect(() => verifyEffectiveKernelConfig(validKernel)).not.toThrow();
  });

  it('rejects dependency resolution that silently re-enables culled userspace', () => {
    expect(() => verifyEffectiveBuildrootConfig(
      validBuildroot.replace('# BR2_PACKAGE_IPUTILS is not set', 'BR2_PACKAGE_IPUTILS=y'),
    )).toThrow('BR2_PACKAGE_IPUTILS=y; expected n');
    expect(() => verifyEffectiveBuildrootConfig(
      validBuildroot.replace('BR2_PACKAGE_ANYCAST_LABD=y', '# BR2_PACKAGE_ANYCAST_LABD is not set'),
    )).toThrow('BR2_PACKAGE_ANYCAST_LABD=n; expected y');
    expect(() => verifyEffectiveBusyboxConfig(
      validBusybox.replace('# CONFIG_FEATURE_SUID is not set', 'CONFIG_FEATURE_SUID=y'),
    )).toThrow('CONFIG_FEATURE_SUID=y; expected n');
    expect(() => verifyEffectiveBusyboxConfig(
      validBusybox.replace('# CONFIG_TAR is not set', 'CONFIG_TAR=y'),
    )).toThrow('CONFIG_TAR=y; expected n');
  });

  it('rejects Linux drift in a required isolation primitive or removed subsystem', () => {
    expect(() => verifyEffectiveKernelConfig(
      validKernel.replace('CONFIG_NET_NS=y', '# CONFIG_NET_NS is not set'),
    )).toThrow('CONFIG_NET_NS=n; expected y');
    expect(() => verifyEffectiveKernelConfig(
      validKernel.replace('# CONFIG_SMP is not set', 'CONFIG_SMP=y'),
    )).toThrow('CONFIG_SMP=y; expected n');
  });

  it('rejects any effective module, including symbols outside the explicit contract', () => {
    expect(() => verifyEffectiveKernelConfig(
      `${validKernel}\nCONFIG_SYNTHETIC_DRIVER=m\n`,
    )).toThrow('contains module CONFIG_SYNTHETIC_DRIVER');
  });

  it('permits unavoidable hidden selections that do not expand the appliance contract', () => {
    const resolved = `${validKernel}
CONFIG_PERF_EVENTS=y
CONFIG_MICROCODE=y
CONFIG_FAILOVER=y
CONFIG_NET_FAILOVER=y
`;
    expect(() => verifyEffectiveKernelConfig(resolved)).not.toThrow();
  });

  it('rejects duplicate assignments instead of accepting the last value', () => {
    expect(() => parseKconfig('CONFIG_TEST=y\n# CONFIG_TEST is not set\n', 'fixture'))
      .toThrow('duplicates CONFIG_TEST');
  });
});
