// @vitest-environment node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const configPath = resolve(import.meta.dirname, '../buildroot/board/linux.config');

let source;
let entries;
let duplicates;

beforeAll(async () => {
  source = await readFile(configPath, 'utf8');
  entries = new Map();
  duplicates = [];

  for (const line of source.split('\n')) {
    const assigned = /^(CONFIG_[A-Z0-9_]+)=(.+)$/.exec(line);
    const disabled = /^# (CONFIG_[A-Z0-9_]+) is not set$/.exec(line);
    if (assigned === null && disabled === null) continue;
    const symbol = assigned?.[1] ?? disabled[1];
    const value = assigned?.[2] ?? 'n';
    if (entries.has(symbol)) duplicates.push(symbol);
    entries.set(symbol, value);
  }
});

function expectConfig(expected) {
  for (const [symbol, value] of Object.entries(expected)) {
    expect(entries.get(symbol), `${symbol} in ${configPath}`).toBe(value);
  }
}

describe('v86 Linux kernel configuration', () => {
  it('is moduleless, size-oriented, and uniprocessor-only', () => {
    expectConfig({
      CONFIG_MODULES: 'n',
      CONFIG_SMP: 'n',
      CONFIG_CC_OPTIMIZE_FOR_SIZE: 'y',
      CONFIG_CC_OPTIMIZE_FOR_PERFORMANCE: 'n',
      CONFIG_PREEMPT_NONE: 'y',
      CONFIG_PREEMPT_DYNAMIC: 'n',
      CONFIG_HZ_100: 'y',
      CONFIG_HZ_250: 'n',
      CONFIG_LOG_BUF_SHIFT: '14',
      CONFIG_KALLSYMS: 'n',
      CONFIG_BLK_DEV_INITRD: 'n',
      CONFIG_SLUB_TINY: 'y',
      CONFIG_BASE_SMALL: 'y',
      CONFIG_PARTITION_ADVANCED: 'y',
      CONFIG_LOCALVERSION_AUTO: 'n',
    });
    expect(duplicates).toEqual([]);
    expect(source).not.toMatch(/^CONFIG_[A-Z0-9_]+=m$/m);
  });

  it('provides a complete shared-kernel container boundary', () => {
    expectConfig(Object.fromEntries([
      'MULTIUSER',
      'SYSVIPC',
      'BINFMT_ELF',
      'BINFMT_SCRIPT',
      'CGROUPS',
      'MEMCG',
      'CGROUP_SCHED',
      'FAIR_GROUP_SCHED',
      'CFS_BANDWIDTH',
      'CGROUP_PIDS',
      'NAMESPACES',
      'UTS_NS',
      'TIME_NS',
      'IPC_NS',
      'PID_NS',
      'NET_NS',
      'SECCOMP',
      'SECCOMP_FILTER',
      'SECURITY_DMESG_RESTRICT',
      'STACKPROTECTOR_STRONG',
      'UNIX98_PTYS',
      'TMPFS_XATTR',
    ].map((symbol) => [`CONFIG_${symbol}`, 'y'])));
    expectConfig({
      CONFIG_MEMCG_V1: 'n',
      CONFIG_BINFMT_MISC: 'n',
      CONFIG_USER_NS: 'n',
      CONFIG_LEGACY_PTYS: 'n',
      CONFIG_DEVMEM: 'n',
      CONFIG_DEVPORT: 'n',
      CONFIG_POSIX_MQUEUE: 'n',
      CONFIG_RSEQ: 'n',
      CONFIG_TMPFS_POSIX_ACL: 'n',
      CONFIG_FS_POSIX_ACL: 'n',
      CONFIG_9P_FS_POSIX_ACL: 'n',
    });
  });

  it('keeps the browser fabric, namespace links, and delay simulation built in', () => {
    expectConfig(Object.fromEntries([
      'PACKET',
      'UNIX',
      'INET',
      'IP_MULTICAST',
      'IP_ADVANCED_ROUTER',
      'IP_MULTIPLE_TABLES',
      'IP_ROUTE_MULTIPATH',
      'IP_MROUTE',
      'IPV6',
      'IPV6_MULTIPLE_TABLES',
      'DUMMY',
      'VETH',
      'TUN',
      'IFB',
      'VLAN_8021Q',
      'BRIDGE',
      'NET_VRF',
      'NET_SCHED',
      'NET_SCH_HTB',
      'NET_SCH_TBF',
      'NET_SCH_NETEM',
      'NET_SCH_INGRESS',
      'NET_CLS_U32',
      'NET_CLS_ACT',
      'NET_ACT_GACT',
      'NET_ACT_MIRRED',
    ].map((symbol) => [`CONFIG_${symbol}`, 'y'])));
  });

  it('retains every v86 boot/control device and external-image storage path', () => {
    expectConfig(Object.fromEntries([
      'PCI',
      'PCI_GODIRECT',
      'PCI_DIRECT',
      'BLOCK',
      'SCSI',
      'BLK_DEV_SD',
      'ATA',
      'ATA_PIIX',
      'ATA_GENERIC',
      'VIRTIO_NET',
      'VIRTIO_CONSOLE',
      'VIRTIO_PCI',
      'VIRTIO_PCI_LEGACY',
      'NET_9P',
      'NET_9P_VIRTIO',
      '9P_FS',
      'SERIAL_8250',
      'SERIAL_8250_CONSOLE',
      'DEVTMPFS',
      'DEVTMPFS_MOUNT',
      'PROC_FS',
      'SYSFS',
      'TMPFS',
      'SQUASHFS',
      'SQUASHFS_FILE_DIRECT',
      'SQUASHFS_COMPILE_DECOMP_SINGLE',
      'SQUASHFS_EMBEDDED',
      'SQUASHFS_ZSTD',
      'ZSTD_DECOMPRESS',
      'OVERLAY_FS',
    ].map((symbol) => [`CONFIG_${symbol}`, 'y'])));
    expectConfig({
      CONFIG_SERIAL_8250_NR_UARTS: '1',
      CONFIG_SERIAL_8250_RUNTIME_UARTS: '1',
      CONFIG_SQUASHFS_FRAGMENT_CACHE_SIZE: '1',
      CONFIG_NET_9P_FD: 'n',
      CONFIG_VIRTIO_MMIO: 'n',
      CONFIG_VIRTIO_BALLOON: 'n',
      CONFIG_HW_RANDOM: 'n',
      CONFIG_VIRTIO_BLK: 'n',
      CONFIG_EXT4_FS: 'n',
      CONFIG_EROFS_FS: 'n',
      CONFIG_SQUASHFS_XATTR: 'n',
      CONFIG_OVERLAY_FS_REDIRECT_DIR: 'n',
      CONFIG_OVERLAY_FS_INDEX: 'n',
      CONFIG_OVERLAY_FS_METACOPY: 'n',
    });
  });

  it('excludes physical peripherals, unused filesystems, and production debug instrumentation', () => {
    expectConfig(Object.fromEntries([
      'ETHERNET',
      'WIRELESS',
      'WLAN',
      'INPUT',
      'SERIO',
      'VT',
      'VGA_CONSOLE',
      'HID_SUPPORT',
      'USB_SUPPORT',
      'DRM',
      'FB',
      'SOUND',
      'MEDIA_SUPPORT',
      'I2C',
      'SPI',
      'GPIOLIB',
      'PPS',
      'PTP_1588_CLOCK',
      'POWER_SUPPLY',
      'HWMON',
      'THERMAL',
      'DMI',
      'CPU_SUP_AMD',
      'PERF_EVENTS_INTEL_UNCORE',
      'PERF_EVENTS_INTEL_RAPL',
      'PERF_EVENTS_INTEL_CSTATE',
      'PERF_EVENTS_AMD_POWER',
      'PERF_EVENTS_AMD_UNCORE',
      'PERF_EVENTS_AMD_BRS',
      'ACPI',
      'PNP',
      'HPET_TIMER',
      'MTRR',
      'X86_PAT',
      'MODIFY_LDT_SYSCALL',
      'X86_BUS_LOCK_DETECT',
      'STANDALONE',
      'FUSE_FS',
      'NFS_FS',
      'CIFS',
      'NLS',
      'MSDOS_PARTITION',
      'EFI_PARTITION',
      'IPV6_SIT',
      'BRIDGE_IGMP_SNOOPING',
      'BRIDGE_VLAN_FILTERING',
      'ETHTOOL_NETLINK',
      'ALLOW_DEV_COREDUMP',
      'PROC_PAGE_MONITOR',
      'CROSS_MEMORY_ATTACH',
      'FHANDLE',
      'CACHESTAT_SYSCALL',
      'BLK_DEV_WRITE_MOUNTED',
      'BLK_DEV_LOOP',
      'ATA_VERBOSE_ERROR',
      'ATA_FORCE',
      'OVERLAY_FS_REDIRECT_ALWAYS_FOLLOW',
      'X86_VERBOSE_BOOTUP',
      'EARLY_PRINTK',
      'PCI_GOANY',
      'PCI_BIOS',
      'PCI_QUIRKS',
      'PCI_LABEL',
      'DEBUG_BUGVERBOSE',
      'DEBUG_MISC',
      'SLUB_DEBUG',
      'DEBUG_MEMORY_INIT',
      'DEBUG_FS',
      'MAGIC_SYSRQ',
      'FTRACE',
      'KPROBES',
      'UPROBES',
      'GCOV_KERNEL',
      'X86_DEBUG_FPU',
      'COMPACTION',
      'MIGRATION',
      'SECRETMEM',
      'SCSI_PROC_FS',
      'BLK_DEV_BSG',
      'DNOTIFY',
      'SERIAL_8250_PCI',
      'SERIAL_8250_EXAR',
      'SERIAL_8250_DWLIB',
      'SERIAL_8250_LPSS',
      'SERIAL_8250_MID',
      'SERIAL_8250_PERICOM',
    ].map((symbol) => [`CONFIG_${symbol}`, 'n'])));
  });

  it('retains only the compression algorithms selected for boot and immutable images', () => {
    expectConfig({
      CONFIG_KERNEL_GZIP: 'y',
      CONFIG_RD_GZIP: 'n',
      CONFIG_INITRAMFS_COMPRESSION_GZIP: 'n',
      CONFIG_RD_BZIP2: 'n',
      CONFIG_RD_LZMA: 'n',
      CONFIG_RD_XZ: 'n',
      CONFIG_RD_LZO: 'n',
      CONFIG_RD_LZ4: 'n',
      CONFIG_RD_ZSTD: 'n',
      CONFIG_SQUASHFS_ZLIB: 'n',
      CONFIG_SQUASHFS_LZ4: 'n',
      CONFIG_SQUASHFS_LZO: 'n',
      CONFIG_SQUASHFS_XZ: 'n',
      CONFIG_SQUASHFS_ZSTD: 'y',
      CONFIG_ZSTD_DECOMPRESS: 'y',
    });
  });
});
