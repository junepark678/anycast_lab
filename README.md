# Anycast Lab

Anycast Lab is the local-first network workbench for
[anycast.guide](https://anycast.guide). It accepts real BIRD and FRRouting
configuration files, connects routers, route servers, clients, services, and
Ethernet switches, and applies latency, jitter, loss, bandwidth, MTU, and
failures in the browser.

Projects autosave to IndexedDB. A portable `.anycastlab` ZIP contains the
topology plus the exact appliance file tree; no account or backend is needed.

## Two explicit fidelity modes

- **SIM** is the fast deterministic compatibility engine. It understands the
  documented BGP, OSPF, static, direct, route-server, IPv4, and IPv6 subset and
  produces guided per-hop traces. It never claims to execute an upstream
  daemon.
- **NATIVE VM** runs pinned Buildroot packages for BIRD 2.15.1 and FRR 10.5.1
  as native i686 Linux executables. Release binaries use Clang 21, `-O3`,
  ThinLTO, and profiles collected from the real BGP/OSPF native workload. The
  Linux guests run under the pinned v86 WebAssembly emulator. Linux clients and
  services participate on the same raw-Ethernet fabric, serial shells are
  interactive, and captures export as PCAPNG. Native service nodes own
  addresses and answer kernel ICMP; application servers are started explicitly
  from their serial shells.

Native mode has no compatibility fallback. Its selector is disabled when the
verified VM image is not part of the deployment. Each guest is allocated 128
MiB, and the UI shows the aggregate estimate before startup.

## Development

Requirements are Bun 1.3 or Node.js 22+ and a modern browser.

```sh
bun install
bun run dev
```

Build the optional native image before packaging a deployment that should
offer NATIVE VM mode:

```sh
bun run build:v86-image
bun run build
```

The image build requires a normal Buildroot host toolchain and builds the
pinned host-only LLVM suite on its first run, which can take substantially
longer than later cached builds. See
[`appliances/v86/README.md`](./appliances/v86/README.md) for the pinned inputs,
artifact contract, and guest design. A normal build without those artifacts is
still valid and publishes an explicit `nativeV86: false` runtime status.

The hosted guide does not compile Buildroot in its site build environment.
The native release workflow builds and verifies the appliance separately,
publishes digest-addressed artifacts to OCI Object Storage, and advances a small channel status
document only after every object is available. The guide build publishes a
same-origin pointer to that status. See the appliance README for its Actions
configuration and OCI public-read contract.

## Verification

```sh
bun run verify
```

That gate runs strict TypeScript, ESLint, Vitest, the native C/WASM appliance
ABI probe, a production build, and Playwright browser workflows. It is suitable
for quick iteration; the native browser smoke test skips when no image exists.

The release-grade gate also constructs the pinned Buildroot image and makes the
real VM smoke test mandatory:

```sh
bun run verify:full
```

When the image is present, Playwright boots Linux, starts the real BIRD binary,
and starts the real FRR suite in a second VM. It requires cross-VM ping, an
Established BGP session and OSPF adjacency reported by both `birdc` and
`vtysh`, an installed BGP route with a routed ping, a locked running project,
and a packet-bearing PCAPNG export.

Focused commands are also available:

```sh
bun run test
bun run test:e2e
bun run test:bird-abi
bun run check
bun run lint
```

## Native files remain authoritative

Files such as these are stored and exported byte-for-byte:

```text
/etc/bird/bird.conf
/etc/bird/filters.conf
/etc/frr/frr.conf
/etc/frr/daemons
```

The topology supplies the environment that daemon configuration does not:
interfaces, addresses, links, latency, clients, service addresses, and failure
state. Native mode mounts the files into the guest and executes the configured
daemon; SIM parses a supported subset without rewriting the source.

BIRD accepts an arbitrary selected config path through `bird -c`. FRR's
upstream integrated-config service is intentionally stricter: its selected
native entrypoint must be `/etc/frr/frr.conf`, so the UI cannot imply that a
custom path was executed when `frrinit.sh` would ignore it.

If a project omits `/etc/frr/daemons`, native mode supplies a conservative
BGP-only daemon policy (FRR still starts its mandatory management, zebra, and
static daemons). To run OSPF, IS-IS, BFD, RIP, Babel, or PIM, include the same
`/etc/frr/daemons` file you would deploy on a Linux router and enable the
corresponding packaged daemon. User-provided daemon files are never replaced.

The full boundary and fidelity notes live in
[`docs/architecture.md`](./docs/architecture.md).

## License

GNU Affero General Public License v3.0, or any later version. See [LICENSE](./LICENSE). The software
is provided without warranty.
