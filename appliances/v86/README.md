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

## OCI Object Storage release publishing

`.github/workflows/publish-native-v86.yml` builds the image on Ubuntu, runs the
full verification gate with the real native VM test required, and uploads the
verified bundle as a GitHub Actions artifact. It then publishes each file under
the digest-addressed OCI Object Storage key
`anycast-lab/native-v86/objects/sha256/<manifest-digest>/` and writes
`channels/<channel>/status.json` last. Tag pushes matching `v86-*` advance the
`stable` channel; a manual run can select another channel.

The workflow first caches the final roughly 20 MiB bundle, keyed by a digest of
the pinned versions, Buildroot external tree, image builder, manifest template,
and verifier plus the runner OS and architecture. A cache hit skips the large
Buildroot compile, but it does not skip bundle hash validation, TypeScript,
lint, unit/integration tests, the production build, or native Playwright tests.
On a bundle miss, Buildroot's native `ccache` integration restores a rolling,
1 GiB compiler cache scoped by pinned versions and runner platform, so image or
rootfs changes can reuse compatible host and target compilation results. Source
downloads are cached separately. Cache actions save new entries only after the
entire job succeeds; the multi-gigabyte intermediate Buildroot tree is never
cached. Bump the `native-v86-ccache-v1` namespace when changing the compiler or
toolchain configuration, as Buildroot cannot safely infer that incompatibility.
GitHub scopes caches by ref: successful manual runs on `master` refresh the
shared default-branch baseline that tag runs can restore, while a cache newly
saved by one tag is not visible to a sibling tag. Prefer a `master` workflow
dispatch when advancing that rolling baseline; the release still requires the
protected publish approval.

Configure these repository Actions values:

- environment secret `OCI_PAR_BASE_URL` in the protected
  `native-v86-publish` environment, containing the HTTPS base URL of an
  `AnyObjectReadWrite` pre-authenticated request restricted to the
  `anycast-lab/native-v86/` object-name prefix;
- variable `OCI_PUBLIC_BASE_URL`, containing the public native Object Storage
  URL through `/o`, before the object key;
- variable `OCI_PAR_EXPIRES_AT`, containing the PAR's ISO-8601 expiration; and
- optionally `OCI_OBJECT_PREFIX` to replace `anycast-lab/native-v86` and
  `OCI_CORS_ORIGIN` to replace the production smoke-test origin
  `https://anycast.guide`.

The bucket must use Standard storage and `ObjectReadWithoutList` public access.
Keep this bucket dedicated to public release artifacts because that access mode
applies to every object in it. Configure `native-v86-publish` with a required
reviewer; the secret is then unavailable to tag-controlled code until a human
approves the exact release job.

Create the publishing credential with listing denied and the exact trailing
slash in the prefix:

```sh
oci os preauth-request create \
  --bucket-name anycast_lab \
  --name anycast-lab-native-v86-github-actions \
  --access-type AnyObjectReadWrite \
  --object-name 'anycast-lab/native-v86/' \
  --bucket-listing-action Deny \
  --time-expires '<ISO-8601 expiry>'
```

The prefix-scoped PAR is a publishing credential: store its URL only as a
GitHub Actions secret, give it an explicit expiry, and rotate it before that
date. OCI does not include the prefix in a prefix-scoped PAR URL, so keep
`OCI_OBJECT_PREFIX` equal to the prefix used when the PAR was created.
Record the PAR ID, name, creator, and expiry outside the repository. Rotation
is create replacement, update the environment secret and expiry variable, run
and approve a successful publish, then delete the old PAR; OCI does not show
the URL again and PARs cannot be edited.

Publishing fails if any required value is absent. Existing digest-addressed
objects are downloaded and compared before reuse, and this publisher refuses
to replace them with different bytes. The channel status contains the absolute
manifest URL, manifest digest, build ID, VM memory size, source revision,
workflow generation, and publication time. A generation guard prevents an
older queued workflow from moving a channel backward. Before advancing that
channel, the publisher fetches the manifest through the public URL, compares
its bytes, and confirms its JSON content type and CORS response.

The guide repository tracks its production stable-channel URL. Another
deployment can override it with this build variable:

```text
ANYCAST_LAB_NATIVE_STATUS_URL=<OCI_PUBLIC_BASE_URL>/<OCI_OBJECT_PREFIX>/channels/stable/status.json
```

The normal guide build is external-only: it packages this small pointer and
never copies a cached local image into Workers Static Assets.

OCI's native Object Storage endpoint supplies wildcard CORS for anonymous
`GET`, `HEAD`, and `OPTIONS`; there is no bucket CORS rule to maintain. The
publisher verifies the actual response before advancing a channel. Browser
requests remain credential-free, and the published manifest and every binary
are verified before v86 starts.

OCI bucket versioning is recommended for recovery from an accidental channel
overwrite; the PAR itself cannot delete objects. Each digest bundle is about
20 MiB, so periodically remove only digests that are no longer referenced by a
channel or retained for rollback. Do not use a blind age rule that could delete
the currently live digest.

## Runtime dependency

The web package must pin `v86` exactly:

```json
"v86": "0.5.424"
```

Do not use a version range: v86 documents that saved-state formats may differ
between emulator versions, and the verified `v86.wasm` is tied to this package
and image manifest.
