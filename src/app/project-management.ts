import {
  createEmptyProject,
  type LabProject,
} from '../core/types';
import type { ProjectIdentity, ProjectSummary } from '../persistence/types';
import { cloneProjectValue } from '../persistence/value';
import { createExampleProject } from './example-project';

export const DEFAULT_BLANK_PROJECT_NAME = 'Untitled lab';
export const MAX_PROJECT_NAME_LENGTH = 100;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const MAX_ID_GENERATION_ATTEMPTS = 32;

export type ProjectNameErrorReason =
  | 'empty'
  | 'too-long'
  | 'control-character';

export class ProjectNameError extends Error {
  readonly reason: ProjectNameErrorReason;

  constructor(reason: ProjectNameErrorReason, message: string) {
    super(message);
    this.name = 'ProjectNameError';
    this.reason = reason;
  }
}

export interface ProjectFactoryOptions {
  /** Injectable clock for deterministic project timestamps. */
  now?: () => Date;
  /** Injectable ID source; production defaults to `crypto.randomUUID()`. */
  randomUUID?: () => string;
}

export type ProjectCatalogIdentity = Pick<ProjectIdentity, 'id' | 'name'>;

/** Returns the display-ready name, or a reason suitable for inline UI errors. */
export function validateProjectName(input: string): string {
  if (typeof input !== 'string') {
    throw new ProjectNameError('empty', 'Project name is required.');
  }

  const name = input.trim();
  if (name.length === 0) {
    throw new ProjectNameError('empty', 'Project name is required.');
  }
  if (Array.from(name).length > MAX_PROJECT_NAME_LENGTH) {
    throw new ProjectNameError(
      'too-long',
      `Project name must be ${MAX_PROJECT_NAME_LENGTH} characters or fewer.`,
    );
  }
  if (PROJECT_NAME_CONTROL_CHARACTERS.test(name)) {
    throw new ProjectNameError(
      'control-character',
      'Project name must be a single line.',
    );
  }
  return name;
}

/** Creates a genuinely empty project with a globally unique browser ID. */
export function createBlankProject(
  name = DEFAULT_BLANK_PROJECT_NAME,
  options: ProjectFactoryOptions = {},
): LabProject {
  const timestamp = createTimestamp(options);
  const project = createEmptyProject({
    id: createProjectId(options),
    name: validateProjectName(name),
  });
  project.createdAt = timestamp;
  project.updatedAt = timestamp;
  return project;
}

/**
 * Creates an independent copy of the built-in demo.
 *
 * The template factory already deep-clones topology data; supplying identity
 * and time here keeps managed demo creation deterministic and UUID-backed.
 */
export function createDefaultDemoProject(
  options: ProjectFactoryOptions = {},
): LabProject {
  const timestamp = createTimestamp(options);
  return createExampleProject({
    id: createProjectId(options),
    now: timestamp,
  });
}

/** Returns the first available `<name> copy`, `<name> copy 2`, ... label. */
export function createDuplicateProjectName(
  sourceName: string,
  existingProjects: readonly Pick<ProjectCatalogIdentity, 'name'>[],
): string {
  const name = validateProjectName(sourceName);
  const occupied = new Set(
    existingProjects.map((project) => projectSearchKey(project.name)),
  );

  // At most every existing name can occupy one candidate, so this bound also
  // avoids an accidental unbounded loop over hostile imported metadata.
  for (let copyNumber = 1; copyNumber <= existingProjects.length + 2; copyNumber += 1) {
    const suffix = copyNumber === 1 ? ' copy' : ` copy ${copyNumber}`;
    const candidate = appendNameSuffix(name, suffix);
    if (!occupied.has(projectSearchKey(candidate))) return candidate;
  }

  throw new Error('Could not create a unique project copy name');
}

/** Deep-copies a project while replacing every piece of catalog identity. */
export function duplicateProject(
  source: LabProject,
  existingProjects: readonly ProjectCatalogIdentity[],
  options: ProjectFactoryOptions = {},
): LabProject {
  const timestamp = createTimestamp(options);
  const copy = cloneProjectValue(source);
  copy.id = createProjectId(options, [source, ...existingProjects]);
  copy.name = createDuplicateProjectName(source.name, existingProjects);
  copy.createdAt = timestamp;
  copy.updatedAt = timestamp;
  return copy;
}

/**
 * Filters without disturbing the repository's recent-first order.
 * Compatibility decomposition plus mark stripping makes composed/decomposed
 * Unicode and common accent-insensitive queries behave alike.
 */
export function filterProjectSummaries<
  TSummary extends Pick<ProjectSummary, 'name'>,
>(summaries: readonly TSummary[], query: string): TSummary[] {
  const terms = projectSearchKey(query).split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return [...summaries];

  return summaries.filter((summary) => {
    const name = projectSearchKey(summary.name);
    return terms.every((term) => name.includes(term));
  });
}

function createTimestamp(options: ProjectFactoryOptions): string {
  const date = options.now?.() ?? new Date();
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('Project clock returned an invalid date');
  }
  return date.toISOString();
}

function createProjectId(
  options: ProjectFactoryOptions,
  occupiedProjects: readonly Pick<ProjectIdentity, 'id'>[] = [],
): string {
  const occupiedIds = new Set(occupiedProjects.map((project) => project.id));
  const randomUUID =
    options.randomUUID ??
    (() => {
      if (typeof globalThis.crypto?.randomUUID !== 'function') {
        throw new Error('This browser cannot create UUID project IDs');
      }
      return globalThis.crypto.randomUUID();
    });

  for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
    const id = randomUUID();
    if (!UUID_PATTERN.test(id)) {
      throw new TypeError('Project ID generator returned an invalid UUID');
    }
    if (!occupiedIds.has(id)) return id;
  }
  throw new Error('Could not create a unique project ID');
}

function appendNameSuffix(name: string, suffix: string): string {
  const capacity = MAX_PROJECT_NAME_LENGTH - Array.from(suffix).length;
  const prefix = Array.from(name).slice(0, capacity).join('').trimEnd();
  return validateProjectName(`${prefix}${suffix}`);
}

function projectSearchKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ß/gu, 'ss')
    .replace(/ς/gu, 'σ')
    .trim();
}
