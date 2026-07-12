#!/usr/bin/env node
import { createHash } from 'node:crypto';

export const FILESYSTEM_LAYOUT = Object.freeze({
  schemaVersion: 1,
  layoutVersion: 1,
  format: 'squashfs',
  compression: 'zstd',
  blockSize: 64 * 1024,
  cacheNamespace: 'anycastlab-v86-filesystem-v1',
});

export const FILESYSTEM_LAYER_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'complete',
    role: 'boot-complete',
    requiredAtBoot: true,
    file: 'rootfs-complete.squashfs',
    packages: Object.freeze([]),
    dependsOn: Object.freeze([]),
    mount: Object.freeze({
      type: 'root',
      path: '/',
      order: 0,
      readOnly: true,
    }),
  }),
  Object.freeze({
    id: 'base',
    role: 'overlay-base',
    requiredAtBoot: false,
    file: 'rootfs-base.squashfs',
    packages: Object.freeze([]),
    dependsOn: Object.freeze([]),
    mount: Object.freeze({
      type: 'overlay-base',
      path: '/',
      order: 0,
      readOnly: true,
    }),
  }),
  Object.freeze({
    id: 'bird',
    role: 'routing-suite',
    requiredAtBoot: false,
    file: 'rootfs-bird.squashfs',
    packages: Object.freeze(['bird']),
    dependsOn: Object.freeze(['base']),
    mount: Object.freeze({
      type: 'overlay-lower',
      path: '/',
      order: 10,
      readOnly: true,
    }),
  }),
  Object.freeze({
    id: 'frr',
    role: 'routing-suite',
    requiredAtBoot: false,
    file: 'rootfs-frr.squashfs',
    // FRR deliberately remains one cache and mount unit. Splitting daemons
    // would duplicate libfrr, vtysh, modules and the shared YANG model set.
    // The installed FRR service entry points use /bin/bash. Keep the
    // interpreter in the same optional unit so base+BIRD remains minimal.
    packages: Object.freeze(['bash', 'frr']),
    dependsOn: Object.freeze(['base']),
    mount: Object.freeze({
      type: 'overlay-lower',
      path: '/',
      order: 20,
      readOnly: true,
    }),
  }),
  Object.freeze({
    id: 'toolbox',
    role: 'diagnostics',
    requiredAtBoot: false,
    file: 'rootfs-toolbox.squashfs',
    // ping/ping6 are BusyBox links selected explicitly by path below; only
    // packages that still install dedicated diagnostic files belong here.
    packages: Object.freeze(['libpcap', 'tcpdump', 'traceroute']),
    dependsOn: Object.freeze(['base']),
    mount: Object.freeze({
      type: 'overlay-lower',
      path: '/',
      order: 30,
      readOnly: true,
    }),
  }),
]);

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function requireRecord(value, label) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactKeys(record, expected, label) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizedLayer(layer, definition, label) {
  const record = requireRecord(layer, label);
  requireExactKeys(record, [
    'id',
    'role',
    'requiredAtBoot',
    'file',
    'object',
    'size',
    'sha256',
    'cacheKey',
    'dependsOn',
    'mount',
  ], label);
  if (
    record.id !== definition.id ||
    record.role !== definition.role ||
    record.requiredAtBoot !== definition.requiredAtBoot ||
    record.file !== definition.file
  ) {
    throw new Error(`${label} does not match the pinned ${definition.id} layer contract`);
  }
  const sha256 = requireSha256(record.sha256, `${label}.sha256`);
  const size = requirePositiveInteger(record.size, `${label}.size`);
  const expectedObject = `blobs/sha256/${sha256}.squashfs`;
  if (record.object !== expectedObject) {
    throw new Error(`${label}.object must be ${expectedObject}`);
  }
  if (record.cacheKey !== `sha256:${sha256}`) {
    throw new Error(`${label}.cacheKey must identify the layer bytes`);
  }
  if (
    !Array.isArray(record.dependsOn) ||
    record.dependsOn.length !== definition.dependsOn.length ||
    record.dependsOn.some((dependency, index) => dependency !== definition.dependsOn[index])
  ) {
    throw new Error(`${label}.dependsOn does not match the pinned mount graph`);
  }
  const mount = requireRecord(record.mount, `${label}.mount`);
  requireExactKeys(mount, ['type', 'path', 'order', 'readOnly'], `${label}.mount`);
  for (const [name, expected] of Object.entries(definition.mount)) {
    if (mount[name] !== expected) {
      throw new Error(`${label}.mount does not match the pinned mount graph`);
    }
  }
  return {
    id: definition.id,
    role: definition.role,
    requiredAtBoot: definition.requiredAtBoot,
    file: definition.file,
    object: expectedObject,
    size,
    sha256,
    cacheKey: `sha256:${sha256}`,
    dependsOn: [...definition.dependsOn],
    mount: { ...definition.mount },
  };
}

function cacheProjection(layers) {
  return {
    schemaVersion: FILESYSTEM_LAYOUT.schemaVersion,
    layoutVersion: FILESYSTEM_LAYOUT.layoutVersion,
    format: FILESYSTEM_LAYOUT.format,
    compression: FILESYSTEM_LAYOUT.compression,
    blockSize: FILESYSTEM_LAYOUT.blockSize,
    layers: layers.map((layer) => ({
      id: layer.id,
      role: layer.role,
      requiredAtBoot: layer.requiredAtBoot,
      file: layer.file,
      object: layer.object,
      size: layer.size,
      sha256: layer.sha256,
      dependsOn: [...layer.dependsOn],
      mount: { ...layer.mount },
    })),
  };
}

export function filesystemCacheKey(layers) {
  return `sha256:${digest(JSON.stringify(cacheProjection(layers)))}`;
}

export function createFilesystemMetadata(artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length !== FILESYSTEM_LAYER_DEFINITIONS.length) {
    throw new Error(`Expected exactly ${FILESYSTEM_LAYER_DEFINITIONS.length} filesystem layer artifacts`);
  }
  const byId = new Map();
  for (const artifact of artifacts) {
    const record = requireRecord(artifact, 'filesystem layer artifact');
    if (typeof record.id !== 'string' || byId.has(record.id)) {
      throw new Error('Filesystem layer artifact IDs must be unique strings');
    }
    byId.set(record.id, record);
  }
  const layers = FILESYSTEM_LAYER_DEFINITIONS.map((definition, index) => {
    const artifact = byId.get(definition.id);
    if (artifact === undefined) throw new Error(`Missing filesystem layer artifact: ${definition.id}`);
    return normalizedLayer({
      id: definition.id,
      role: definition.role,
      requiredAtBoot: definition.requiredAtBoot,
      file: definition.file,
      object: `blobs/sha256/${artifact.sha256}.squashfs`,
      size: artifact.size,
      sha256: artifact.sha256,
      cacheKey: `sha256:${artifact.sha256}`,
      dependsOn: [...definition.dependsOn],
      mount: { ...definition.mount },
    }, definition, `filesystem.layers[${index}]`);
  });
  if (byId.size !== layers.length) throw new Error('Unexpected filesystem layer artifact ID');
  return {
    schemaVersion: FILESYSTEM_LAYOUT.schemaVersion,
    layoutVersion: FILESYSTEM_LAYOUT.layoutVersion,
    format: FILESYSTEM_LAYOUT.format,
    compression: FILESYSTEM_LAYOUT.compression,
    blockSize: FILESYSTEM_LAYOUT.blockSize,
    cache: {
      namespace: FILESYSTEM_LAYOUT.cacheNamespace,
      key: filesystemCacheKey(layers),
    },
    layers,
  };
}

export function validateFilesystemMetadata(value) {
  const filesystem = requireRecord(value, 'filesystem');
  requireExactKeys(filesystem, [
    'schemaVersion',
    'layoutVersion',
    'format',
    'compression',
    'blockSize',
    'cache',
    'layers',
  ], 'filesystem');
  for (const name of ['schemaVersion', 'layoutVersion', 'format', 'compression', 'blockSize']) {
    if (filesystem[name] !== FILESYSTEM_LAYOUT[name]) {
      throw new Error(`filesystem.${name} does not match the supported filesystem contract`);
    }
  }
  if (
    !Array.isArray(filesystem.layers) ||
    filesystem.layers.length !== FILESYSTEM_LAYER_DEFINITIONS.length
  ) {
    throw new Error(`Expected exactly ${FILESYSTEM_LAYER_DEFINITIONS.length} filesystem layers`);
  }
  const layers = filesystem.layers.map((layer, index) => normalizedLayer(
    layer,
    FILESYSTEM_LAYER_DEFINITIONS[index],
    `filesystem.layers[${index}]`,
  ));
  const cache = requireRecord(filesystem.cache, 'filesystem.cache');
  requireExactKeys(cache, ['namespace', 'key'], 'filesystem.cache');
  if (cache.namespace !== FILESYSTEM_LAYOUT.cacheNamespace) {
    throw new Error('filesystem.cache.namespace does not match the supported cache contract');
  }
  const expectedKey = filesystemCacheKey(layers);
  if (cache.key !== expectedKey) {
    throw new Error(`filesystem.cache.key must be ${expectedKey}`);
  }
  return {
    schemaVersion: FILESYSTEM_LAYOUT.schemaVersion,
    layoutVersion: FILESYSTEM_LAYOUT.layoutVersion,
    format: FILESYSTEM_LAYOUT.format,
    compression: FILESYSTEM_LAYOUT.compression,
    blockSize: FILESYSTEM_LAYOUT.blockSize,
    cache: {
      namespace: FILESYSTEM_LAYOUT.cacheNamespace,
      key: expectedKey,
    },
    layers,
  };
}
