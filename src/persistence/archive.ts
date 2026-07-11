import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';

import type { LabProject } from '../core/types';
import {
  createLabProjectMigrator,
  readProjectSchemaVersion,
} from './migrations';
import type { ProjectIdentity, ProjectMigrator } from './types';
import {
  cloneProjectValue,
  isArrayBuffer,
  isRecord,
  isUint8Array,
} from './value';

export const ANYCAST_LAB_ARCHIVE_EXTENSION = '.anycastlab';
export const ANYCAST_LAB_ARCHIVE_MIME = 'application/vnd.anycast-lab+zip';
export const ANYCAST_LAB_ARCHIVE_VERSION = 1;

const MANIFEST_PATH = 'manifest.json';
const PROJECT_PATH = 'project.json';
const FILE_REFERENCE_KEY = '$$anycastLabArchiveFile';
const DEFAULT_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 4_096;

export class ProjectArchiveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectArchiveError';
  }
}

export type ArchivedFileEncoding = 'utf-8' | 'uint8array' | 'arraybuffer';

export interface ArchivedProjectFile {
  id: number;
  archivePath: string;
  nodeId: string;
  path: string;
  encoding: ArchivedFileEncoding;
  byteLength: number;
}

export interface AnycastLabArchiveManifest {
  format: 'anycastlab';
  archiveVersion: 1;
  exportedAt: string;
  project: {
    id: string;
    name: string;
    schemaVersion: number;
    path: 'project.json';
  };
  files: ArchivedProjectFile[];
}

export interface ExportProjectArchiveOptions {
  exportedAt?: string;
  compressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
}

export interface ImportProjectArchiveOptions<
  TProject extends ProjectIdentity,
> {
  migrate?: ProjectMigrator<TProject>;
  maxArchiveBytes?: number;
  maxUncompressedBytes?: number;
  maxEntries?: number;
}

export interface ImportedProjectArchive<TProject extends ProjectIdentity> {
  project: TProject;
  manifest: AnycastLabArchiveManifest;
}

interface FileReference {
  [FILE_REFERENCE_KEY]: number;
}

interface ExtractionResult {
  document: unknown;
  files: ArchivedProjectFile[];
  entries: Record<string, Uint8Array>;
}

/**
 * Export a complete project to a ZIP-based `.anycastlab` document.
 * Router file contents are separate binary ZIP entries, not JSON strings.
 */
export function exportProjectArchive<
  TProject extends ProjectIdentity = LabProject,
>(
  project: TProject,
  options: ExportProjectArchiveOptions = {},
): Uint8Array {
  const extracted = extractProjectFiles(cloneProjectValue(project));
  const manifest: AnycastLabArchiveManifest = {
    format: 'anycastlab',
    archiveVersion: ANYCAST_LAB_ARCHIVE_VERSION,
    exportedAt: options.exportedAt ?? new Date().toISOString(),
    project: {
      id: project.id,
      name: project.name,
      schemaVersion: readProjectSchemaVersion(project),
      path: PROJECT_PATH,
    },
    files: extracted.files,
  };

  const entries: Record<string, Uint8Array> = {
    [MANIFEST_PATH]: encodeJson(manifest, MANIFEST_PATH),
    [PROJECT_PATH]: encodeJson(extracted.document, PROJECT_PATH),
    ...extracted.entries,
  };

  return zipSync(entries, {
    level: options.compressionLevel ?? 6,
    // Stable mtimes make archives reproducible when exportedAt is fixed.
    mtime: new Date('2000-01-01T00:00:00.000Z'),
  });
}

export function decodeProjectArchive<
  TProject extends ProjectIdentity = LabProject,
>(
  archive: Uint8Array,
  options: ImportProjectArchiveOptions<TProject> = {},
): ImportedProjectArchive<TProject> {
  const maxArchiveBytes =
    options.maxArchiveBytes ?? DEFAULT_MAX_ARCHIVE_BYTES;
  const maxUncompressedBytes =
    options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  validateLimit(maxArchiveBytes, 'maxArchiveBytes');
  validateLimit(maxUncompressedBytes, 'maxUncompressedBytes');
  validateLimit(maxEntries, 'maxEntries');

  if (archive.byteLength > maxArchiveBytes) {
    throw new ProjectArchiveError(
      `Archive is ${archive.byteLength} bytes; limit is ${maxArchiveBytes}`,
    );
  }

  let count = 0;
  let expandedBytes = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(archive, {
      filter(file) {
        validateArchivePath(file.name);
        count += 1;
        if (count > maxEntries) {
          throw new ProjectArchiveError(
            `Archive contains more than ${maxEntries} entries`,
          );
        }
        expandedBytes += file.originalSize;
        if (expandedBytes > maxUncompressedBytes) {
          throw new ProjectArchiveError(
            `Archive expands beyond ${maxUncompressedBytes} bytes`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ProjectArchiveError) {
      throw error;
    }
    throw new ProjectArchiveError('The file is not a readable ZIP archive', {
      cause: error,
    });
  }

  const manifestBytes = entries[MANIFEST_PATH];
  const projectBytes = entries[PROJECT_PATH];
  if (manifestBytes === undefined || projectBytes === undefined) {
    throw new ProjectArchiveError(
      'Archive must contain manifest.json and project.json',
    );
  }

  const manifest = parseManifest(manifestBytes);
  const document = parseJson(projectBytes, PROJECT_PATH);
  const restored = restoreProjectFiles(document, manifest.files, entries);
  try {
    if (readProjectSchemaVersion(restored) !== manifest.project.schemaVersion) {
      throw new ProjectArchiveError(
        'Project schema version does not match the archive manifest',
      );
    }
  } catch (error) {
    if (error instanceof ProjectArchiveError) {
      throw error;
    }
    throw new ProjectArchiveError('Project schema version is invalid', {
      cause: error,
    });
  }
  const migrate =
    options.migrate ??
    (createLabProjectMigrator() as unknown as ProjectMigrator<TProject>);
  let project: TProject;
  try {
    project = migrate(restored);
  } catch (error) {
    throw new ProjectArchiveError('Project data is invalid or unsupported', {
      cause: error,
    });
  }

  if (project.id !== manifest.project.id) {
    throw new ProjectArchiveError(
      'Project id does not match the archive manifest',
    );
  }
  if (project.name !== manifest.project.name) {
    throw new ProjectArchiveError(
      'Project name does not match the archive manifest',
    );
  }
  return { project, manifest };
}

export async function importProjectArchive<
  TProject extends ProjectIdentity = LabProject,
>(
  input: Uint8Array | ArrayBuffer | Blob,
  options: ImportProjectArchiveOptions<TProject> = {},
): Promise<ImportedProjectArchive<TProject>> {
  let bytes: Uint8Array;
  if (input instanceof Uint8Array) {
    bytes = input;
  } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
    bytes = new Uint8Array(await input.arrayBuffer());
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input);
  } else {
    throw new ProjectArchiveError('Unsupported archive input');
  }
  return decodeProjectArchive(bytes, options);
}

export function projectArchiveFilename(projectName: string): string {
  const stem = projectName
    .normalize('NFKC')
    .trim()
    .replace(/[\x00-\x1f<>:"/\\|?*]+/g, '-')
    .replace(/[. ]+$/g, '')
    .slice(0, 100);
  return `${stem || 'anycast-lab'}${ANYCAST_LAB_ARCHIVE_EXTENSION}`;
}

function extractProjectFiles(document: unknown): ExtractionResult {
  const entries: Record<string, Uint8Array> = {};
  const files: ArchivedProjectFile[] = [];
  if (!isRecord(document) || !Array.isArray(document.nodes)) {
    return { document, files, entries };
  }

  for (const nodeValue of document.nodes) {
    if (!isRecord(nodeValue) || !Array.isArray(nodeValue.files)) {
      continue;
    }
    const nodeId = typeof nodeValue.id === 'string' ? nodeValue.id : '';
    for (const fileValue of nodeValue.files) {
      if (!isRecord(fileValue) || typeof fileValue.path !== 'string') {
        continue;
      }
      if (!Object.prototype.hasOwnProperty.call(fileValue, 'content')) {
        continue;
      }

      const encoded = encodeFileContent(fileValue.content, nodeId, fileValue.path);
      if (encoded === undefined) {
        continue;
      }
      const id = files.length;
      const archivePath = `files/${id.toString().padStart(6, '0')}.bin`;
      entries[archivePath] = encoded.bytes;
      files.push({
        id,
        archivePath,
        nodeId,
        path: fileValue.path,
        encoding: encoded.encoding,
        byteLength: encoded.bytes.byteLength,
      });
      fileValue.content = { [FILE_REFERENCE_KEY]: id } satisfies FileReference;
    }
  }

  return { document, files, entries };
}

function encodeFileContent(
  content: unknown,
  nodeId: string,
  path: string,
): { bytes: Uint8Array; encoding: ArchivedFileEncoding } | undefined {
  if (typeof content === 'string') {
    const bytes = strToU8(content);
    if (strFromU8(bytes) !== content) {
      throw new ProjectArchiveError(
        `File ${path} on node ${nodeId} is not valid UTF-8 text`,
      );
    }
    return { bytes, encoding: 'utf-8' };
  }
  if (isUint8Array(content)) {
    return { bytes: content.slice(), encoding: 'uint8array' };
  }
  if (isArrayBuffer(content)) {
    return {
      bytes: new Uint8Array(content.slice(0)),
      encoding: 'arraybuffer',
    };
  }
  return undefined;
}

function restoreProjectFiles(
  document: unknown,
  fileEntries: readonly ArchivedProjectFile[],
  entries: Readonly<Record<string, Uint8Array>>,
): unknown {
  const indexed = new Map<number, ArchivedProjectFile>();
  const archivePaths = new Set<string>();
  for (const file of fileEntries) {
    validateArchivedFile(file);
    if (indexed.has(file.id)) {
      throw new ProjectArchiveError(`Duplicate archived file id ${file.id}`);
    }
    if (archivePaths.has(file.archivePath)) {
      throw new ProjectArchiveError(
        `Duplicate archived file path ${file.archivePath}`,
      );
    }
    indexed.set(file.id, file);
    archivePaths.add(file.archivePath);
  }

  const used = new Set<number>();
  if (isRecord(document) && Array.isArray(document.nodes)) {
    for (const node of document.nodes) {
      if (!isRecord(node) || !Array.isArray(node.files)) {
        continue;
      }
      const nodeId = typeof node.id === 'string' ? node.id : '';
      for (const file of node.files) {
        if (!isRecord(file) || !isFileReference(file.content)) {
          continue;
        }
        const id = file.content[FILE_REFERENCE_KEY];
        const metadata = indexed.get(id);
        if (metadata === undefined) {
          throw new ProjectArchiveError(
            `Project references missing file id ${id}`,
          );
        }
        if (used.has(id)) {
          throw new ProjectArchiveError(`Project references file id ${id} twice`);
        }
        if (
          metadata.nodeId !== nodeId ||
          metadata.path !== file.path
        ) {
          throw new ProjectArchiveError(
            `Archived file ${metadata.archivePath} does not match its project file`,
          );
        }
        const bytes = entries[metadata.archivePath];
        if (bytes === undefined) {
          throw new ProjectArchiveError(
            `Archive is missing ${metadata.archivePath}`,
          );
        }
        if (bytes.byteLength !== metadata.byteLength) {
          throw new ProjectArchiveError(
            `Size mismatch for archived file ${metadata.archivePath}`,
          );
        }
        used.add(id);
        file.content = decodeFileContent(bytes, metadata);
      }
    }
  }

  for (const file of fileEntries) {
    if (!used.has(file.id)) {
      throw new ProjectArchiveError(
        `Archived file ${file.archivePath} is not referenced by the project`,
      );
    }
  }
  return document;
}

function decodeFileContent(
  bytes: Uint8Array,
  metadata: ArchivedProjectFile,
): string | Uint8Array | ArrayBuffer {
  switch (metadata.encoding) {
    case 'utf-8':
      try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch (error) {
        throw new ProjectArchiveError(
          `Archived file ${metadata.archivePath} is not valid UTF-8`,
          { cause: error },
        );
      }
    case 'uint8array':
      return bytes.slice();
    case 'arraybuffer':
      return bytes.slice().buffer;
  }
}

function isFileReference(value: unknown): value is FileReference {
  return (
    isRecord(value) &&
    Object.keys(value).length === 1 &&
    typeof value[FILE_REFERENCE_KEY] === 'number' &&
    Number.isSafeInteger(value[FILE_REFERENCE_KEY]) &&
    value[FILE_REFERENCE_KEY] >= 0
  );
}

function validateArchivedFile(value: unknown): asserts value is ArchivedProjectFile {
  if (
    !isRecord(value) ||
    typeof value.id !== 'number' ||
    !Number.isSafeInteger(value.id) ||
    value.id < 0 ||
    typeof value.archivePath !== 'string' ||
    typeof value.nodeId !== 'string' ||
    typeof value.path !== 'string' ||
    !['utf-8', 'uint8array', 'arraybuffer'].includes(
      String(value.encoding),
    ) ||
    typeof value.byteLength !== 'number' ||
    !Number.isSafeInteger(value.byteLength) ||
    value.byteLength < 0
  ) {
    throw new ProjectArchiveError('Archive manifest contains invalid file metadata');
  }
  validateArchivePath(value.archivePath);
  if (!value.archivePath.startsWith('files/')) {
    throw new ProjectArchiveError('Project file entries must live under files/');
  }
}

function parseManifest(bytes: Uint8Array): AnycastLabArchiveManifest {
  const value = parseJson(bytes, MANIFEST_PATH);
  if (
    !isRecord(value) ||
    value.format !== 'anycastlab' ||
    value.archiveVersion !== ANYCAST_LAB_ARCHIVE_VERSION ||
    typeof value.exportedAt !== 'string' ||
    !isRecord(value.project) ||
    typeof value.project.id !== 'string' ||
    typeof value.project.name !== 'string' ||
    typeof value.project.schemaVersion !== 'number' ||
    !Number.isSafeInteger(value.project.schemaVersion) ||
    value.project.schemaVersion < 0 ||
    value.project.path !== PROJECT_PATH ||
    !Array.isArray(value.files)
  ) {
    throw new ProjectArchiveError('Archive manifest is invalid or unsupported');
  }
  for (const file of value.files) {
    validateArchivedFile(file);
  }
  return value as unknown as AnycastLabArchiveManifest;
}

function encodeJson(value: unknown, label: string): Uint8Array {
  try {
    return strToU8(`${JSON.stringify(value, null, 2)}\n`);
  } catch (error) {
    throw new ProjectArchiveError(`${label} cannot be serialized`, {
      cause: error,
    });
  }
}

function parseJson(bytes: Uint8Array, label: string): unknown {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new ProjectArchiveError(`${label} is not valid UTF-8 JSON`, {
      cause: error,
    });
  }
}

function validateArchivePath(path: string): void {
  if (
    path.length === 0 ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.split('/').some((part) => part === '..' || part === '.')
  ) {
    throw new ProjectArchiveError(`Unsafe archive path: ${path}`);
  }
}

function validateLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
