# v86 Linux router appliance

This directory builds the faithful appliance used by `src/appliances/v86`:
an i686 Buildroot Linux kernel with an embedded root filesystem containing
the unmodified Buildroot packages for BIRD and FRRouting. The browser executes
that kernel under the pinned official `v86` npm package.

## Reproducible build

Prerequisites are a normal Buildroot host toolchain (`gcc`, `make`, `perl`,
`python3`, `cpio`, `rsync`, `bc`, `bison`, `flex`, `unzip`), `curl`, `xz`, and
Node.js. Docker is not required.

The 32-bit Pentium Pro target is intentional: v86 does not emulate x86-64 CPU
extensions. BIRD and FRR are native 32-bit Linux executables inside the guest;
their configuration and routing behavior are otherwise unchanged.

```sh
JOBS=8 ./scripts/build-image.sh
```

The script verifies every downloaded source, confirms the BIRD/FRR versions in
the pinned Buildroot release, enables Buildroot reproducibility, and produces:

```text
dist/
├── manifest.json
├── manifest.sha256
├── router-bzimage.bin
├── seabios.bin
├── vgabios.bin
└── v86.wasm
```

`manifest.sha256` is published in `runtime/status.json` and supplied to
`createV86RuntimeFactory`; the runtime verifies the manifest and every artifact
before constructing a VM. In the bundled same-origin deployment this detects
stale, truncated, or mixed build artifacts—it is not an authenticity boundary
against a compromised origin, because that origin serves both bytes and
digest. A deployment that needs adversarial artifact provenance must pin the
digest independently (for example in the application build or signed release
metadata).

The root image mounts v86's in-memory 9p filesystem and dedicates `/dev/hvc0`
to a small boot/config agent. Native files are transferred as validated ustar
archives. `/dev/ttyS0` remains an interactive Linux serial shell. v86's one NIC
is a private VLAN trunk; the browser adapter removes the private outer tag so
each requested `ethN` behaves as an independent lab-fabric port.
The normal FRR boot service is moved to `/usr/libexec/anycastlab-frr`, so an
FRR appliance can start it explicitly after its native files and interfaces
have been installed without also starting FRR on BIRD or client nodes.
When a project does not provide `/etc/frr/daemons`, the host injects a minimal
BGP policy. Other packaged protocol daemons are enabled with the same daemon
activation file used by a normal FRR deployment.
Each VM is capped at 128 MiB; the UI should show the aggregate memory estimate
before starting a large native topology.

The build also enforces the guide deployment's 25 MiB per-file static-asset
limit. If the embedded-rootfs kernel grows beyond it, the build fails rather
than publishing an undeployable manifest; the image must then be reduced or
served through a chunked/external artifact channel.

## Runtime dependency

The web package must pin `v86` exactly:

```json
"v86": "0.5.424"
```

Do not use a version range: v86 documents that saved-state formats may differ
between emulator versions, and the verified `v86.wasm` is tied to this package
and image manifest.
