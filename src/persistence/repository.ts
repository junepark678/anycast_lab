import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

import type { LabProject } from '../core/types';
import {
  createLabProjectMigrator,
  createProjectMigrator,
  readProjectSchemaVersion,
} from './migrations';
import type {
  ProjectIdentity,
  ProjectMigrator,
  ProjectRepository,
  ProjectSummary,
  SaveProjectOptions,
  StoredProject,
} from './types';
import { assertProjectIdentity, cloneProjectValue } from './value';

export const DEFAULT_PROJECT_DATABASE_NAME = 'anycast-lab';
export const PROJECT_DATABASE_VERSION = 1;

interface DatabaseProjectRecord {
  id: string;
  name: string;
  schemaVersion: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
  /** Optional so databases created before project catalogs remain readable. */
  lastOpenedAt?: number;
  project: unknown;
}

interface LabDatabase extends DBSchema {
  projects: {
    key: string;
    value: DatabaseProjectRecord;
    indexes: {
      'by-updated-at': number;
    };
  };
}

export class ProjectRevisionConflictError extends Error {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly actualRevision: number;

  constructor(projectId: string, expectedRevision: number, actualRevision: number) {
    super(
      `Project ${projectId} is at revision ${actualRevision}; expected ${expectedRevision}`,
    );
    this.name = 'ProjectRevisionConflictError';
    this.projectId = projectId;
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export interface RepositoryOptions<TProject extends ProjectIdentity> {
  migrate?: ProjectMigrator<TProject>;
  now?: () => number;
}

export interface IndexedDbRepositoryOptions<TProject extends ProjectIdentity>
  extends RepositoryOptions<TProject> {
  databaseName?: string;
}

export interface CreateRepositoryOptions<TProject extends ProjectIdentity>
  extends IndexedDbRepositoryOptions<TProject> {
  /** Useful for SSR, deterministic tests, and private browsing fallbacks. */
  forceMemory?: boolean;
  fallback?: ProjectRepository<TProject>;
  onFallback?: (error: unknown) => void;
}

function defaultNow(): number {
  return Date.now();
}

function toStoredProject<TProject extends ProjectIdentity>(
  record: DatabaseProjectRecord,
  migrate: ProjectMigrator<TProject>,
): StoredProject<TProject> {
  return {
    project: migrate(cloneProjectValue(record.project)),
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOpenedAt: readLastOpenedAt(record),
  };
}

function toSummary(record: DatabaseProjectRecord): ProjectSummary {
  return {
    id: record.id,
    name: record.name,
    schemaVersion: record.schemaVersion,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastOpenedAt: readLastOpenedAt(record),
  };
}

function sortSummaries(summaries: ProjectSummary[]): ProjectSummary[] {
  return summaries.sort(
    (left, right) =>
      right.lastOpenedAt - left.lastOpenedAt ||
      right.updatedAt - left.updatedAt ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

/** Legacy records predate explicit open recency, so their last save is the fallback. */
function readLastOpenedAt(record: DatabaseProjectRecord): number {
  return typeof record.lastOpenedAt === 'number' &&
    Number.isFinite(record.lastOpenedAt)
    ? record.lastOpenedAt
    : record.updatedAt;
}

function prepareProject<TProject extends ProjectIdentity>(
  project: TProject,
  migrate: ProjectMigrator<TProject>,
): TProject {
  assertProjectIdentity(project);
  const prepared = migrate(cloneProjectValue(project));
  assertProjectIdentity(prepared);
  return prepared;
}

export class MemoryProjectRepository<TProject extends ProjectIdentity>
  implements ProjectRepository<TProject>
{
  readonly backend = 'memory' as const;

  private readonly records = new Map<string, DatabaseProjectRecord>();
  private readonly migrate: ProjectMigrator<TProject>;
  private readonly now: () => number;

  constructor(options: RepositoryOptions<TProject> = {}) {
    this.migrate = options.migrate ?? createProjectMigrator<TProject>();
    this.now = options.now ?? defaultNow;
  }

  async get(id: string): Promise<StoredProject<TProject> | undefined> {
    const record = this.records.get(id);
    return record === undefined
      ? undefined
      : toStoredProject(cloneProjectValue(record), this.migrate);
  }

  async list(): Promise<ProjectSummary[]> {
    return sortSummaries(
      [...this.records.values()].map((record) => toSummary(record)),
    );
  }

  async save(
    project: TProject,
    options: SaveProjectOptions = {},
  ): Promise<StoredProject<TProject>> {
    const prepared = prepareProject(project, this.migrate);
    const existing = this.records.get(prepared.id);
    const actualRevision = existing?.revision ?? 0;
    assertExpectedRevision(prepared.id, options, actualRevision);

    const timestamp = this.now();
    const record: DatabaseProjectRecord = {
      id: prepared.id,
      name: prepared.name,
      schemaVersion: readProjectSchemaVersion(prepared),
      revision: actualRevision + 1,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastOpenedAt:
        existing === undefined ? timestamp : readLastOpenedAt(existing),
      project: cloneProjectValue(prepared),
    };
    this.records.set(record.id, record);
    return toStoredProject(record, this.migrate);
  }

  async markOpened(
    id: string,
  ): Promise<StoredProject<TProject> | undefined> {
    const existing = this.records.get(id);
    if (existing === undefined) return undefined;

    const record = { ...existing, lastOpenedAt: this.now() };
    this.records.set(id, record);
    return toStoredProject(record, this.migrate);
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }

  close(): void {
    // Memory repositories own no external resources.
  }
}

export class IndexedDbProjectRepository<TProject extends ProjectIdentity>
  implements ProjectRepository<TProject>
{
  readonly backend = 'indexeddb' as const;

  private readonly db: IDBPDatabase<LabDatabase>;
  private readonly migrate: ProjectMigrator<TProject>;
  private readonly now: () => number;

  private constructor(
    db: IDBPDatabase<LabDatabase>,
    options: IndexedDbRepositoryOptions<TProject>,
  ) {
    this.db = db;
    this.migrate = options.migrate ?? createProjectMigrator<TProject>();
    this.now = options.now ?? defaultNow;
  }

  static async open<T extends ProjectIdentity>(
    options: IndexedDbRepositoryOptions<T> = {},
  ): Promise<IndexedDbProjectRepository<T>> {
    if (typeof indexedDB === 'undefined') {
      throw new Error('IndexedDB is not available in this environment');
    }

    const db = await openDB<LabDatabase>(
      options.databaseName ?? DEFAULT_PROJECT_DATABASE_NAME,
      PROJECT_DATABASE_VERSION,
      {
        upgrade(database, oldVersion) {
          if (oldVersion < 1) {
            const projects = database.createObjectStore('projects', {
              keyPath: 'id',
            });
            projects.createIndex('by-updated-at', 'updatedAt');
          }
        },
      },
    );
    return new IndexedDbProjectRepository<T>(db, options);
  }

  async get(id: string): Promise<StoredProject<TProject> | undefined> {
    const record = await this.db.get('projects', id);
    return record === undefined
      ? undefined
      : toStoredProject(record, this.migrate);
  }

  async list(): Promise<ProjectSummary[]> {
    const records = await this.db.getAll('projects');
    return sortSummaries(records.map(toSummary));
  }

  async save(
    project: TProject,
    options: SaveProjectOptions = {},
  ): Promise<StoredProject<TProject>> {
    const prepared = prepareProject(project, this.migrate);
    const transaction = this.db.transaction('projects', 'readwrite');

    try {
      const existing = await transaction.store.get(prepared.id);
      const actualRevision = existing?.revision ?? 0;
      assertExpectedRevision(prepared.id, options, actualRevision);

      const timestamp = this.now();
      const record: DatabaseProjectRecord = {
        id: prepared.id,
        name: prepared.name,
        schemaVersion: readProjectSchemaVersion(prepared),
        revision: actualRevision + 1,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        lastOpenedAt:
          existing === undefined ? timestamp : readLastOpenedAt(existing),
        project: cloneProjectValue(prepared),
      };
      await transaction.store.put(record);
      await transaction.done;
      return toStoredProject(record, this.migrate);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // A failing request may already have aborted the transaction.
      }
      throw error;
    }
  }

  async markOpened(
    id: string,
  ): Promise<StoredProject<TProject> | undefined> {
    const transaction = this.db.transaction('projects', 'readwrite');

    try {
      const existing = await transaction.store.get(id);
      if (existing === undefined) {
        await transaction.done;
        return undefined;
      }

      const record: DatabaseProjectRecord = {
        ...existing,
        lastOpenedAt: this.now(),
      };
      await transaction.store.put(record);
      await transaction.done;
      return toStoredProject(record, this.migrate);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // A failing request may already have aborted the transaction.
      }
      throw error;
    }
  }

  async delete(id: string): Promise<boolean> {
    const transaction = this.db.transaction('projects', 'readwrite');
    const exists = (await transaction.store.getKey(id)) !== undefined;
    if (exists) {
      await transaction.store.delete(id);
    }
    await transaction.done;
    return exists;
  }

  async clear(): Promise<void> {
    await this.db.clear('projects');
  }

  close(): void {
    this.db.close();
  }
}

export async function createProjectRepository<
  TProject extends ProjectIdentity = LabProject,
>(
  options: CreateRepositoryOptions<TProject> = {},
): Promise<ProjectRepository<TProject>> {
  const fallback =
    options.fallback ?? new MemoryProjectRepository<TProject>(options);

  if (options.forceMemory || typeof indexedDB === 'undefined') {
    return fallback;
  }

  try {
    return await IndexedDbProjectRepository.open(options);
  } catch (error) {
    options.onFallback?.(error);
    return fallback;
  }
}

export type LabProjectRepositoryOptions = Omit<
  CreateRepositoryOptions<LabProject>,
  'migrate'
> & {
  migrate?: ProjectMigrator<LabProject>;
};

/** Preferred browser repository for the current, fully validated project model. */
export function createLabProjectRepository(
  options: LabProjectRepositoryOptions = {},
): Promise<ProjectRepository<LabProject>> {
  return createProjectRepository<LabProject>({
    ...options,
    migrate: options.migrate ?? createLabProjectMigrator(),
  });
}

function assertExpectedRevision(
  projectId: string,
  options: SaveProjectOptions,
  actualRevision: number,
): void {
  if (
    options.expectedRevision !== undefined &&
    options.expectedRevision !== actualRevision
  ) {
    throw new ProjectRevisionConflictError(
      projectId,
      options.expectedRevision,
      actualRevision,
    );
  }
}
