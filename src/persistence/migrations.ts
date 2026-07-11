import {
  CURRENT_SCHEMA_VERSION,
  type LabProject,
} from '../core/types';
import { assertValidProject } from '../core/validation';
import type { ProjectIdentity, ProjectMigrator } from './types';
import {
  assertProjectIdentity,
  cloneProjectValue,
  isRecord,
} from './value';

export const CURRENT_PROJECT_SCHEMA_VERSION = CURRENT_SCHEMA_VERSION;

export class ProjectMigrationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProjectMigrationError';
  }
}

export interface ProjectMigrationContext {
  /** A stable timestamp supplied once for the entire migration run. */
  now: string;
}

export interface ProjectMigration {
  from: number;
  to: number;
  migrate(
    document: Readonly<Record<string, unknown>>,
    context: ProjectMigrationContext,
  ): Record<string, unknown>;
}

export interface MigrateProjectOptions<TProject extends ProjectIdentity> {
  targetVersion?: number;
  migrations?: readonly ProjectMigration[];
  now?: string;
  validate?: (document: unknown) => TProject;
}

/**
 * Version zero was the pre-versioned project shape used by early prototypes.
 * The migration is deliberately lossless: unknown fields are retained.
 */
export const DEFAULT_PROJECT_MIGRATIONS: readonly ProjectMigration[] = [
  {
    from: 0,
    to: 1,
    migrate(document, context) {
      const legacyVersion = document.version;
      const createdAt =
        typeof document.createdAt === 'string'
          ? document.createdAt
          : context.now;
      const updatedAt =
        typeof document.updatedAt === 'string'
          ? document.updatedAt
          : createdAt;

      const migrated: Record<string, unknown> = {
        ...document,
        schemaVersion: 1,
        createdAt,
        updatedAt,
        seed:
          typeof document.seed === 'number' && Number.isFinite(document.seed)
            ? document.seed
            : 1,
        nodes: Array.isArray(document.nodes) ? document.nodes : [],
        links: Array.isArray(document.links) ? document.links : [],
        scenarioEvents: Array.isArray(document.scenarioEvents)
          ? document.scenarioEvents
          : [],
        settings: {
          defaultTtl: 32,
          maxConvergenceIterations: 64,
          captureLimit: 10_000,
          ...(isRecord(document.settings) ? document.settings : {}),
        },
      };

      // Older drafts called the schema field `version`. Do not retain it when
      // it is clearly the legacy numeric schema marker. Other uses are kept.
      if (typeof legacyVersion === 'number') {
        delete migrated.version;
      }
      return migrated;
    },
  },
];

export function readProjectSchemaVersion(document: unknown): number {
  if (!isRecord(document)) {
    throw new ProjectMigrationError('A lab project must be an object');
  }

  if (document.schemaVersion === undefined) {
    return 0;
  }
  if (
    typeof document.schemaVersion !== 'number' ||
    !Number.isSafeInteger(document.schemaVersion) ||
    document.schemaVersion < 0
  ) {
    throw new ProjectMigrationError(
      'Project schemaVersion must be a non-negative integer',
    );
  }
  return document.schemaVersion;
}

export function migrateProject<TProject extends ProjectIdentity = ProjectIdentity>(
  document: unknown,
  options: MigrateProjectOptions<TProject> = {},
): TProject {
  const targetVersion =
    options.targetVersion ?? CURRENT_PROJECT_SCHEMA_VERSION;
  const migrationList = options.migrations ?? DEFAULT_PROJECT_MIGRATIONS;
  const context: ProjectMigrationContext = {
    now: options.now ?? new Date().toISOString(),
  };

  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new ProjectMigrationError('Target schema version is invalid');
  }

  let current = readProjectSchemaVersion(document);
  if (current > targetVersion) {
    throw new ProjectMigrationError(
      `Project schema ${current} is newer than supported schema ${targetVersion}`,
    );
  }

  const byVersion = new Map<number, ProjectMigration>();
  for (const migration of migrationList) {
    if (
      !Number.isSafeInteger(migration.from) ||
      !Number.isSafeInteger(migration.to) ||
      migration.from < 0 ||
      migration.to !== migration.from + 1
    ) {
      throw new ProjectMigrationError(
        `Invalid migration ${migration.from} -> ${migration.to}`,
      );
    }
    if (byVersion.has(migration.from)) {
      throw new ProjectMigrationError(
        `Duplicate migration from schema ${migration.from}`,
      );
    }
    byVersion.set(migration.from, migration);
  }

  let migrated = cloneProjectValue(document);
  while (current < targetVersion) {
    const migration = byVersion.get(current);
    if (migration === undefined) {
      throw new ProjectMigrationError(
        `No migration from schema ${current} to ${current + 1}`,
      );
    }
    if (!isRecord(migrated)) {
      throw new ProjectMigrationError(
        `Migration from schema ${current} returned a non-object`,
      );
    }

    try {
      migrated = migration.migrate(migrated, context);
    } catch (error) {
      throw new ProjectMigrationError(
        `Failed to migrate project from schema ${current} to ${migration.to}`,
        { cause: error },
      );
    }
    if (!isRecord(migrated)) {
      throw new ProjectMigrationError(
        `Migration from schema ${current} returned a non-object`,
      );
    }
    migrated.schemaVersion = migration.to;
    current = migration.to;
  }

  if (options.validate !== undefined) {
    return options.validate(migrated);
  }

  assertProjectIdentity(migrated);
  return migrated as unknown as TProject;
}

export function createProjectMigrator<TProject extends ProjectIdentity>(
  options: MigrateProjectOptions<TProject> = {},
): ProjectMigrator<TProject> {
  return (document) => migrateProject(document, options);
}

/** Current-project migrator with the core model's complete validator. */
export function migrateLabProject(document: unknown): LabProject {
  return migrateProject<LabProject>(document, {
    validate(value) {
      assertValidProject(value);
      return value;
    },
  });
}

export function createLabProjectMigrator(): ProjectMigrator<LabProject> {
  return migrateLabProject;
}
