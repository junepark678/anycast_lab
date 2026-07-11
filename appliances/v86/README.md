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

`manifest.sha256` is published in the external release status and supplied to
`createV86RuntimeFactory`; the runtime verifies the manifest and every artifact
before constructing a VM. This detects stale, truncated, or mixed build
artifacts—it is not an authenticity boundary against a compromised artifact
origin, because that origin serves both bytes and digest. A deployment that
needs adversarial artifact provenance must pin the digest independently (for
example in the application build or signed release metadata).

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

Native images are served from dedicated object storage, not Workers Static
Assets. The build enforces a 512 MiB per-file browser-safety ceiling to catch
accidental oversized outputs; it does not constrain normal image growth to a
site-hosting asset limit.

## R2 release publishing

`.github/workflows/publish-native-v86.yml` builds the image on Ubuntu, runs the
full verification gate with the real native VM test required, and uploads the
verified bundle as a GitHub Actions artifact. It then publishes each file under
the immutable R2 key
`anycast-lab/native-v86/objects/sha256/<manifest-digest>/` and writes
`channels/<channel>/status.json` last. Tag pushes matching `v86-*` advance the
`stable` channel; a manual run can select another channel.

Configure these repository Actions values:

- secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`, using an R2 API token
  scoped to write only the artifact bucket;
- variables `R2_ACCOUNT_ID`, `R2_BUCKET`, and `R2_PUBLIC_BASE_URL` (the HTTPS
  custom domain or public bucket origin); and
- optionally `R2_PREFIX` to replace `anycast-lab/native-v86` and
  `R2_CORS_ORIGIN` to replace the production smoke-test origin
  `https://anycast.guide`.

Publishing fails if any required value is absent. Existing digest-addressed
objects are downloaded and compared before reuse, and different bytes are
never allowed to replace them. The channel status contains the absolute
manifest URL, manifest digest, build ID, VM memory size, source revision, and
publication time. Before advancing that channel, the publisher fetches the
manifest through the public URL, compares its bytes, and confirms that the
configured guide origin receives an `Access-Control-Allow-Origin` response.

Set the guide's Cloudflare Pages build variable to the resulting channel URL:

```text
ANYCAST_LAB_NATIVE_STATUS_URL=https://<asset-domain>/<R2_PREFIX>/channels/stable/status.json
```

The normal guide build is external-only: it packages this small pointer and
never copies a cached local image into Workers Static Assets. If the variable
is absent, the build still succeeds but reports NATIVE VM as unavailable.

The public R2 origin must allow cross-origin `GET` and `HEAD` from the guide.
For the production guide, the bucket CORS policy can be limited to:

```json
[
  {
    "AllowedOrigins": ["https://anycast.guide"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["Range"],
    "ExposeHeaders": ["Content-Length", "Content-Range", "ETag"],
    "MaxAgeSeconds": 86400
  }
]
```

Add explicit localhost origins only when testing the external bundle from a
local development server. The published manifest and every binary are still
verified in the browser before v86 starts.

## Runtime dependency

The web package must pin `v86` exactly:

```json
"v86": "0.5.424"
```

Do not use a version range: v86 documents that saved-state formats may differ
between emulator versions, and the verified `v86.wasm` is tied to this package
and image manifest.
