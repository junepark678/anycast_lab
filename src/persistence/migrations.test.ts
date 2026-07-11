import { describe, expect, it } from 'vitest';

import {
  migrateProject,
  ProjectMigrationError,
  readProjectSchemaVersion,
} from './migrations';

describe('project migrations', () => {
  it('upgrades an unversioned project without discarding unknown fields', () => {
    const migrated = migrateProject(
      {
        id: 'legacy',
        name: 'Legacy topology',
        version: 0,
        custom: { preserve: true },
      },
      { now: '2026-07-11T00:00:00.000Z' },
    );

    expect(migrated).toMatchObject({
      id: 'legacy',
      name: 'Legacy topology',
      schemaVersion: 1,
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
      seed: 1,
      nodes: [],
      links: [],
      settings: {},
      custom: { preserve: true },
    });
    expect((migrated as typeof migrated & { settings: unknown }).settings).toEqual({
      defaultTtl: 32,
      maxConvergenceIterations: 64,
      captureLimit: 10_000,
    });
    expect(migrated).not.toHaveProperty('version');
  });

  it('rejects projects created by a newer schema', () => {
    expect(() =>
      migrateProject({
        id: 'future',
        name: 'Future',
        schemaVersion: 99,
      }),
    ).toThrow(/newer than supported/);
  });

  it('detects missing migration steps', () => {
    expect(() =>
      migrateProject(
        { id: 'old', name: 'Old', schemaVersion: 0 },
        { targetVersion: 2, migrations: [] },
      ),
    ).toThrow(ProjectMigrationError);
  });

  it('validates schema version values', () => {
    expect(() => readProjectSchemaVersion({ schemaVersion: 1.5 })).toThrow(
      /non-negative integer/,
    );
  });
});
