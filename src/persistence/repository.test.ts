import { describe, expect, it, vi } from 'vitest';

import {
  createProjectRepository,
  MemoryProjectRepository,
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

    expect(first).toMatchObject({ revision: 1, createdAt: 100, updatedAt: 100 });
    expect(first.project.name).toBe('Seoul lab');
    expect(first.project.nodes[0]!.bytes).toEqual(new Uint8Array([0, 1, 255]));
    expect(second).toMatchObject({ revision: 2, createdAt: 100, updatedAt: 200 });

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

  it('lists newest projects first and deletes them', async () => {
    let now = 10;
    const repository = new MemoryProjectRepository<TestProject>({
      now: () => now,
    });
    await repository.save(project('old', 'Old'));
    now = 20;
    await repository.save(project('new', 'New'));

    expect((await repository.list()).map(({ id }) => id)).toEqual(['new', 'old']);
    expect(await repository.delete('new')).toBe(true);
    expect(await repository.delete('new')).toBe(false);
    expect((await repository.list()).map(({ id }) => id)).toEqual(['old']);
    await repository.clear();
    expect(await repository.list()).toEqual([]);
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
