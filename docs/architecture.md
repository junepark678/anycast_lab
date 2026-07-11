# Architecture

## Product boundary

Anycast Lab is a browser-local topology editor and packet fabric. The project
document owns nodes, interfaces, links, timing, failures, and appliance files.
It does not turn a visual topology into generated BIRD or FRR configuration:
the files entered by the user remain authoritative.

The application has five boundaries:

1. **React workspace** — topology, native-file editor, inspectors, terminal,
   guided trace, events, import/export, and runtime fidelity selection.
2. **Project/persistence** — validated schema, migrations, IndexedDB repository,
   debounced autosave, and bounded ZIP import/export.
3. **Compatibility engine** — deterministic protocol/FIB model and explainable
   trace used only when SIM is selected.
4. **Native orchestration** — lifecycle, raw L2 fabric, links, switches,
   terminals, capture, and the versioned appliance ABI.
5. **v86 appliance** — a pinned i686 Buildroot Linux image containing BIRD and
   FRR, executed locally by v86's WebAssembly CPU/device emulator.

## Fidelity is project state

Every non-switch node records either `compatibility` or `wasm`. The global
selector updates that state, so fidelity survives autosave and archive export.
The canvas and inspector display provenance on every node.

There is no automatic native-to-SIM fallback. Before native startup, the host
resolves a native runtime for every router, route server, client, and service.
Missing images, version mismatches, unsupported appliance kinds, invalid Linux
interface names, bad addresses, missing entrypoints, reused endpoints, and
reserved files are reported as eligibility errors.

## Native execution path

### Why a Linux VM

BIRD and FRR depend on Linux sockets, netlink, process control, timers, and a
substantial userspace. A direct WASM feasibility harness exists under
`appliances/bird`, but pretending that harness is a routing daemon would make
the fidelity label meaningless. The usable MVP therefore runs the actual
Buildroot packages inside Linux. BIRD/FRR are native i686 binaries; v86 itself
is the WebAssembly component.

The pinned image contains BIRD 2.15.1, FRR 10.5.1, iproute2, iputils,
traceroute, tcpdump, and ethtool. It is an initramfs kernel with no persistent
disk and no route to the public Internet.

### Verified artifacts and boot

The build emits a manifest, its digest, the Linux `bzImage`, v86 WASM, SeaBIOS,
and VGA BIOS. A dedicated release workflow publishes these under immutable,
digest-addressed OCI Object Storage keys, then advances a channel status document as its final
write. The guide packages only a same-origin pointer to that external status.
The browser verifies the manifest and each artifact before constructing a VM.

Each requested guest interface becomes an 802.1Q subinterface of v86's single
virtual NIC. The private VLAN tag is consumed by the adapter and never appears
on the lab fabric. Configuration files and a generated start script cross an
in-memory 9p channel as validated ustar archives. `/dev/hvc0` is reserved for a
small control agent; `/dev/ttyS0` remains the user's interactive root shell.

BIRD is executed in the foreground against the selected entrypoint. FRR uses
its upstream init helper only after `/etc/frr/frr.conf` and interfaces exist;
the lab injects `/etc/frr/daemons` only when the project did not provide one.
The injected default enables BGP only, plus FRR's mandatory core daemons; a
project that uses OSPF, IS-IS, BFD, RIP, Babel, or PIM supplies its normal
`/etc/frr/daemons` file. All of those daemon binaries remain packaged in the
image, and a user-provided activation file is passed through unchanged.
Because upstream integrated-config startup reads `/etc/frr/frr.conf`, native
eligibility rejects a different selected FRR entrypoint instead of silently
booting the wrong file.
Client and service nodes run normal Linux networking, including configured
IPv4/IPv6 default routes. A service's anycast addresses are assigned to its
first interface.

The native service primitive currently supplies address ownership and kernel
ICMP only. DNS, HTTP, and arbitrary TCP/UDP servers are not synthesized from
the topology document; users can start those real processes from the serial
shell. SIM may model declared higher-level service delivery for guided traces.

### Native Ethernet fabric

Appliances emit and receive byte-exact Ethernet frames through the ABI. The
host fabric applies:

- point-to-point link state;
- latency plus seeded jitter;
- seeded packet loss;
- serialization delay from bandwidth;
- link/interface MTU;
- node and interface state;
- in-flight failure drops; and
- Ethernet switch flooding and source-MAC learning.

Routing policy, neighbor discovery, protocol packets, the RIB/FIB, and IP
forwarding remain inside Linux and BIRD/FRR. The fabric does not inspect BGP or
invent routes. Frame observations and drops are bounded by the project capture
limit and can be exported as nanosecond-resolution PCAPNG.

v86 advances on browser wall-clock time. The fabric avoids idle polling and
schedules wakeups only for pending frame arrivals. Seeded loss and jitter are
reproducible for the same project and frame order, but native daemon timing is
not presented as deterministic simulation time.

## SIM execution path

SIM parses supported native syntax into a separate operational model while
retaining the source files unchanged. Its scheduler deterministically
converges connected/static routes, BGP, OSPF, route-server behavior, and
failures, then performs longest-prefix packet traces with a reason at every
hop. This is suited to the guide's quick exercises and automated explanations;
it is not a substitute for daemon-specific validation.

The preflight parser may reject syntax that a native daemon supports or omit a
daemon behavior. In NATIVE VM mode the daemon log and CLI are authoritative.

## Persistence and archives

IndexedDB stores complete validated projects behind a repository interface. A
debounced coordinator exposes saving/saved/error states and flushes on dispose.
The app requests persistent browser storage when available and falls back to
session memory if IndexedDB cannot open.

`.anycastlab` is a bounded ZIP format with a versioned manifest, `project.json`,
and separate binary entries for every appliance file. Import limits compressed
size, expanded size, entry count, paths, references, and schema version. Text
is reconstructed byte-for-byte, including line endings and trailing spaces.

## Security boundary

- Guests have no browser or public-network API; only lab Ethernet is delivered.
- Artifact hashes, ABI versions, image build IDs, and upstream versions are
  checked before native startup.
- Guest paths are normalized, bootstrap archives reject traversal, and a small
  set of control paths is reserved.
- Terminal and daemon output is rendered as text, not HTML.
- Imported archives are parsed and validated before becoming active state.

This isolates ordinary lab traffic and configuration mistakes. It is not a
claim that v86 or the guest kernel is a hardened boundary for hostile code, so
deployments should retain normal browser/site isolation and size limits.

## Current scope

The native image deliberately favors a broadly useful routing appliance over
an exhaustive GNS3 replacement. It supports BIRD/FRR protocols compiled into
the image, Linux clients/services, switches, IPv4/IPv6, raw capture, and manual
failures. Structural and configuration edits are locked while a native runtime
owns the project, preventing the saved/exported topology from diverging from
the VMs; reset the runtime before editing, or use the serial shell for an
intentional live experiment. VM snapshots exist
at the appliance boundary but are not yet part of the project archive. Each VM
uses 128 MiB, so large native topologies are intentionally more expensive than
SIM.
