import { describe, expect, it, vi } from 'vitest';

import {
  createProjectRepository,
  MemoryProjectRepository,
  PROJECT_DATABASE_VERSION,
  ProjectRevisionConflictError,
} from './repository';

interface TestProject {
  id: string;
  name: string;
  schemaVersion: number;
  nodes: Array<{ id: string; bytes?: Uint8Array }>;
  links: unknown[];
}

function project(id = 'project-1', name = 'Seoul lab'): TestProject {
  return {
    id,
    name,
    schemaVersion: 1,
    nodes: [{ id: 'router-1', bytes: new Uint8Array([0, 1, 255]) }],
    links: [],
  };
}

describe('MemoryProjectRepository', () => {
  it('saves immutable snapshots and increments revisions', async () => {
    let now = 100;
    const repository = new MemoryProjectRepository<TestProject>({
      now: () => now,
    });
    const source = project();

    const first = await repository.save(source, { expectedRevision: 0 });
    source.name = 'mutated outside the repository';
    source.nodes[0]!.bytes![0] = 99;
    now = 200;
    const second = await repository.save(
      { ...first.project, name: 'Updated lab' },
      { expectedRevision: 1 },
    );

    expect(first).toMatchObject({
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
      lastOpenedAt: 100,
    });
    expect(first.project.name).toBe('Seoul lab');
    expect(first.project.nodes[0]!.bytes).toEqual(new Uint8Array([0, 1, 255]));
    expect(second).toMatchObject({
      revision: 2,
      createdAt: 100,
      updatedAt: 200,
      lastOpenedAt: 100,
    });

    const loaded = await repository.get(source.id);
    expect(loaded?.project.name).toBe('Updated lab');
    loaded!.project.name = 'mutated loaded value';
    expect((await repository.get(source.id))?.project.name).toBe('Updated lab');
  });

  it('enforces optimistic revisions', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    await repository.save(project());

    await expect(
      repository.save(project('project-1', 'stale'), { expectedRevision: 0 }),
    ).rejects.toMatchObject({
      name: 'ProjectRevisionConflictError',
      expectedRevision: 0,
      actualRevision: 1,
    } satisfies Partial<ProjectRevisionConflictError>);
  });

  it('lists recently opened projects first and deletes them', async () => {
    let now = 10;
    const repository = new MemoryProjectRepository<TestProject>({
      now: () => now,
    });
    await repository.save(project('old', 'Old'));
    now = 20;
    await repository.save(project('new', 'New'));

    expect((await repository.list()).map(({ id }) => id)).toEqual(['new', 'old']);
    now = 30;
    const opened = await repository.markOpened('old');
    expect(opened).toMatchObject({
      revision: 1,
      createdAt: 10,
      updatedAt: 10,
      lastOpenedAt: 30,
      project: { id: 'old', name: 'Old' },
    });
    expect((await repository.list()).map(({ id }) => id)).toEqual(['old', 'new']);

    expect(await repository.delete('new')).toBe(true);
    expect(await repository.delete('new')).toBe(false);
    expect((await repository.list()).map(({ id }) => id)).toEqual(['old']);
    await repository.clear();
    expect(await repository.list()).toEqual([]);
  });

  it('marks opens without saving content or bumping its revision', async () => {
    let now = 100;
    const repository = new MemoryProjectRepository<TestProject>({
      now: () => now,
    });
    await repository.save(project());

    now = 200;
    const opened = await repository.markOpened('project-1');
    expect(opened).toMatchObject({
      revision: 1,
      createdAt: 100,
      updatedAt: 100,
      lastOpenedAt: 200,
      project: { name: 'Seoul lab' },
    });

    now = 300;
    const saved = await repository.save(project('project-1', 'Edited'));
    expect(saved).toMatchObject({
      revision: 2,
      createdAt: 100,
      updatedAt: 300,
      lastOpenedAt: 200,
    });
    expect(await repository.markOpened('missing')).toBeUndefined();
  });

  it('reads pre-catalog records using updatedAt as their open recency', async () => {
    const repository = new MemoryProjectRepository<TestProject>({
      now: () => 42,
    });
    await repository.save(project());

    const records = (
      repository as unknown as {
        records: Map<string, { updatedAt: number; lastOpenedAt?: number }>;
      }
    ).records;
    delete records.get('project-1')?.lastOpenedAt;

    expect(await repository.get('project-1')).toMatchObject({
      updatedAt: 42,
      lastOpenedAt: 42,
    });
    expect(await repository.list()).toMatchObject([
      { id: 'project-1', updatedAt: 42, lastOpenedAt: 42 },
    ]);
    expect(PROJECT_DATABASE_VERSION).toBe(1);
  });
});

describe('createProjectRepository', () => {
  it('uses memory when IndexedDB is unsupported or explicitly disabled', async () => {
    const fallback = vi.fn();
    const repository = await createProjectRepository<TestProject>({
      forceMemory: true,
      onFallback: fallback,
    });

    expect(repository.backend).toBe('memory');
    expect(fallback).not.toHaveBeenCalled();
  });
});
