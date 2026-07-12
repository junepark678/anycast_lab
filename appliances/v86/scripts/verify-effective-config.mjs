#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BUILDROOT_REQUIRED = Object.freeze({
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

const BUSYBOX_REQUIRED = Object.freeze({
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

// This is intentionally a behavioral allow/deny contract, not a comparison
// with the input fragment. Kconfig may select hidden implementation symbols
// (for example the x86 perf core and virtio failover helpers) even when an
// input fragment contains a best-effort `is not set` line. Only options that
// define the appliance's boot path, isolation boundary, network fabric, and
// deliberately removed subsystems belong here.
const KERNEL_REQUIRED = Object.freeze({
  CONFIG_X86_32: 'y',
  CONFIG_M686: 'y',
  CONFIG_CC_OPTIMIZE_FOR_SIZE: 'y',
  CONFIG_HZ_100: 'y',
  CONFIG_LOG_BUF_SHIFT: '14',
  CONFIG_BINFMT_ELF: 'y',
  CONFIG_BINFMT_SCRIPT: 'y',

  CONFIG_CGROUPS: 'y',
  CONFIG_MEMCG: 'y',
  CONFIG_CGROUP_SCHED: 'y',
  CONFIG_FAIR_GROUP_SCHED: 'y',
  CONFIG_CFS_BANDWIDTH: 'y',
  CONFIG_CGROUP_PIDS: 'y',
  CONFIG_NAMESPACES: 'y',
  CONFIG_UTS_NS: 'y',
  CONFIG_TIME_NS: 'y',
  CONFIG_IPC_NS: 'y',
  CONFIG_PID_NS: 'y',
  CONFIG_NET_NS: 'y',
  CONFIG_SECCOMP: 'y',
  CONFIG_SECCOMP_FILTER: 'y',

  CONFIG_SCSI: 'y',
  CONFIG_BLK_DEV_SD: 'y',
  CONFIG_ATA: 'y',
  CONFIG_ATA_SFF: 'y',
  CONFIG_ATA_BMDMA: 'y',
  CONFIG_ATA_PIIX: 'y',
  CONFIG_SQUASHFS: 'y',
  CONFIG_SQUASHFS_ZSTD: 'y',
  CONFIG_OVERLAY_FS: 'y',
  CONFIG_DEVTMPFS: 'y',
  CONFIG_DEVTMPFS_MOUNT: 'y',
  CONFIG_PROC_FS: 'y',
  CONFIG_SYSFS: 'y',
  CONFIG_TMPFS: 'y',

  CONFIG_PACKET: 'y',
  CONFIG_UNIX: 'y',
  CONFIG_INET: 'y',
  CONFIG_IP_ADVANCED_ROUTER: 'y',
  CONFIG_IP_MULTIPLE_TABLES: 'y',
  CONFIG_IPV6: 'y',
  CONFIG_IPV6_MULTIPLE_TABLES: 'y',
  CONFIG_VETH: 'y',
  CONFIG_TUN: 'y',
  CONFIG_IFB: 'y',
  CONFIG_VLAN_8021Q: 'y',
  CONFIG_BRIDGE: 'y',
  CONFIG_NET_VRF: 'y',
  CONFIG_NET_SCHED: 'y',
  CONFIG_NET_SCH_HTB: 'y',
  CONFIG_NET_SCH_TBF: 'y',
  CONFIG_NET_SCH_NETEM: 'y',
  CONFIG_NET_SCH_INGRESS: 'y',
  CONFIG_NET_CLS_U32: 'y',
  CONFIG_NET_CLS_ACT: 'y',
  CONFIG_NET_ACT_GACT: 'y',
  CONFIG_NET_ACT_MIRRED: 'y',

  CONFIG_VIRTIO: 'y',
  CONFIG_VIRTIO_PCI: 'y',
  CONFIG_VIRTIO_PCI_LEGACY: 'y',
  CONFIG_VIRTIO_NET: 'y',
  CONFIG_VIRTIO_CONSOLE: 'y',
  CONFIG_NET_9P: 'y',
  CONFIG_NET_9P_VIRTIO: 'y',
  CONFIG_9P_FS: 'y',
  CONFIG_TTY: 'y',
  CONFIG_UNIX98_PTYS: 'y',
  CONFIG_SERIAL_8250: 'y',
  CONFIG_SERIAL_8250_CONSOLE: 'y',
  CONFIG_SERIAL_8250_NR_UARTS: '1',
  CONFIG_SERIAL_8250_RUNTIME_UARTS: '1',
});

const KERNEL_FORBIDDEN = Object.freeze([
  'CONFIG_SMP',
  'CONFIG_MODULES',
  'CONFIG_BLK_DEV_INITRD',
  'CONFIG_SWAP',
  'CONFIG_COREDUMP',
  'CONFIG_AIO',
  'CONFIG_IO_URING',
  'CONFIG_KALLSYMS',
  'CONFIG_BINFMT_MISC',
  'CONFIG_DEVMEM',
  'CONFIG_DEVPORT',
  'CONFIG_AUDIT',
  'CONFIG_SECURITY',
  'CONFIG_USER_NS',
  'CONFIG_VIRTIO_BLK',
  'CONFIG_VIRTIO_BALLOON',
  'CONFIG_NETFILTER',
  'CONFIG_ETHERNET',
  'CONFIG_WIRELESS',
  'CONFIG_WLAN',
  'CONFIG_ACPI',
  'CONFIG_PM',
  'CONFIG_INPUT',
  'CONFIG_VT',
  'CONFIG_HID_SUPPORT',
  'CONFIG_USB_SUPPORT',
  'CONFIG_DRM',
  'CONFIG_FB',
  'CONFIG_SOUND',
  'CONFIG_MEDIA_SUPPORT',
  'CONFIG_EXT4_FS',
  'CONFIG_EROFS_FS',
  'CONFIG_FUSE_FS',
  'CONFIG_NFS_FS',
  'CONFIG_CIFS',
  'CONFIG_DEBUG_FS',
  'CONFIG_FTRACE',
  'CONFIG_KPROBES',
  'CONFIG_UPROBES',
  'CONFIG_GCOV_KERNEL',
]);

export function parseKconfig(source, label = 'Kconfig') {
  if (typeof source !== 'string') throw new Error(`${label} must be text`);
  const entries = new Map();
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const assigned = /^([A-Za-z0-9_]+)=(.*)$/.exec(line);
    const disabled = /^# ([A-Za-z0-9_]+) is not set$/.exec(line);
    if (assigned === null && disabled === null) continue;
    const symbol = assigned?.[1] ?? disabled[1];
    const value = assigned?.[2] ?? 'n';
    if (entries.has(symbol)) {
      throw new Error(`${label}:${index + 1} duplicates ${symbol}`);
    }
    entries.set(symbol, value);
  }
  return entries;
}

function requireValues(entries, required, label) {
  for (const [symbol, expected] of Object.entries(required)) {
    const actual = entries.get(symbol) ?? 'n';
    if (actual !== expected) {
      throw new Error(`${label} resolved ${symbol}=${actual}; expected ${expected}`);
    }
  }
}

export function verifyEffectiveBuildrootConfig(source) {
  const entries = parseKconfig(source, 'Buildroot .config');
  requireValues(entries, BUILDROOT_REQUIRED, 'Buildroot');
  const busyboxConfig = entries.get('BR2_PACKAGE_BUSYBOX_CONFIG');
  if (
    typeof busyboxConfig !== 'string' ||
    !/^".*\/board\/busybox-shared\.config"$/.test(busyboxConfig)
  ) {
    throw new Error('Buildroot did not resolve the curated BusyBox configuration');
  }
  return entries;
}

export function verifyEffectiveBusyboxConfig(source) {
  const entries = parseKconfig(source, 'BusyBox .config');
  requireValues(entries, BUSYBOX_REQUIRED, 'BusyBox');
  return entries;
}

export function verifyEffectiveKernelConfig(effectiveSource) {
  const effective = parseKconfig(effectiveSource, 'Linux effective .config');
  requireValues(effective, KERNEL_REQUIRED, 'Linux');
  requireValues(
    effective,
    Object.fromEntries(KERNEL_FORBIDDEN.map((symbol) => [symbol, 'n'])),
    'Linux',
  );
  const module = [...effective].find(([, value]) => value === 'm');
  if (module !== undefined) throw new Error(`Linux effective config contains module ${module[0]}`);
  return effective;
}

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`${name ?? '<missing>'} requires a value`);
    if (name === '--buildroot') options.buildroot = value;
    else if (name === '--busybox') options.busybox = value;
    else if (name === '--kernel') options.kernel = value;
    else throw new Error(`Unknown argument: ${name}`);
  }
  for (const name of ['buildroot', 'busybox', 'kernel']) {
    if (options[name] === undefined) throw new Error(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  return options;
}

export async function verifyEffectiveConfigs(options) {
  const [buildroot, busybox, kernel] = await Promise.all([
    readFile(resolve(options.buildroot), 'utf8'),
    readFile(resolve(options.busybox), 'utf8'),
    readFile(resolve(options.kernel), 'utf8'),
  ]);
  verifyEffectiveBuildrootConfig(buildroot);
  verifyEffectiveBusyboxConfig(busybox);
  verifyEffectiveKernelConfig(kernel);
}

const invokedPath = process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  await verifyEffectiveConfigs(parseArguments(process.argv.slice(2)));
  process.stdout.write('Verified resolved Buildroot, BusyBox, and Linux configurations\n');
}
