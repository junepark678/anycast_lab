import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutosaveCoordinator } from './autosave';
import {
  MemoryProjectRepository,
  ProjectRevisionConflictError,
} from './repository';

interface TestProject {
  id: string;
  name: string;
  schemaVersion: number;
}

function project(name: string): TestProject {
  return { id: 'project-1', name, schemaVersion: 1 };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AutosaveCoordinator', () => {
  it('debounces edits and saves the latest immutable snapshot', async () => {
    vi.useFakeTimers();
    const repository = new MemoryProjectRepository<TestProject>();
    const saved = vi.fn();
    const autosave = new AutosaveCoordinator({
      repository,
      delayMs: 50,
      onSaved: saved,
    });

    const first = project('first');
    autosave.schedule(first);
    first.name = 'mutated after scheduling';
    autosave.schedule(project('latest'));

    await vi.advanceTimersByTimeAsync(49);
    expect(await repository.get('project-1')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);

    expect((await repository.get('project-1'))?.project.name).toBe('latest');
    expect(saved).toHaveBeenCalledTimes(1);
    expect(autosave.getState()).toMatchObject({
      status: 'saved',
      dirty: false,
      revision: 1,
    });
  });

  it('flushes immediately and can cancel a pending save', async () => {
    vi.useFakeTimers();
    const repository = new MemoryProjectRepository<TestProject>();
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });

    autosave.schedule(project('flushed'));
    const stored = await autosave.flush();
    expect(stored?.project.name).toBe('flushed');

    autosave.schedule(project('cancelled'));
    autosave.cancel();
    await vi.runAllTimersAsync();
    expect((await repository.get('project-1'))?.project.name).toBe('flushed');
  });

  it('preserves last-writer-wins saves when no revision is seeded', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const save = vi.spyOn(repository, 'save');
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });

    autosave.schedule(project('without CAS'));
    await autosave.flush();
    autosave.schedule(project('still without CAS'));
    await autosave.flush();

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0]).toHaveLength(1);
    expect(save.mock.calls[0]?.[0]).toMatchObject({ name: 'without CAS' });
    expect(save.mock.calls[1]).toHaveLength(1);
    expect(save.mock.calls[1]?.[0]).toMatchObject({
      name: 'still without CAS',
    });
  });

  it('uses a seeded revision and advances it after every successful save', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const original = await repository.save(project('original'));
    const save = vi.spyOn(repository, 'save');
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    autosave.setExpectedRevision('project-1', original.revision);

    autosave.schedule(project('first CAS edit'));
    await expect(autosave.flush()).resolves.toMatchObject({ revision: 2 });
    autosave.schedule(project('second CAS edit'));
    await expect(autosave.flush()).resolves.toMatchObject({ revision: 3 });

    expect(save).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: 'first CAS edit' }),
      { expectedRevision: 1 },
    );
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'second CAS edit' }),
      { expectedRevision: 2 },
    );
  });

  it('uses revision zero to protect creation of a new project', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const save = vi.spyOn(repository, 'save');
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    autosave.setExpectedRevision('project-1', 0);

    autosave.schedule(project('new project'));
    await expect(autosave.flush()).resolves.toMatchObject({ revision: 1 });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new project' }),
      { expectedRevision: 0 },
    );
  });

  it('can clear a seeded revision to restore last-writer-wins behavior', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    await repository.save(project('original'));
    const save = vi.spyOn(repository, 'save');
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    autosave.setExpectedRevision('project-1', 1);
    autosave.setExpectedRevision('project-1', undefined);

    autosave.schedule(project('unconditional edit'));
    await autosave.flush();

    expect(save.mock.calls[0]).toHaveLength(1);
    expect((await repository.get('project-1'))?.project.name).toBe(
      'unconditional edit',
    );
  });

  it('rejects invalid expected revisions without changing save behavior', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const save = vi.spyOn(repository, 'save');
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });

    expect(() => autosave.setExpectedRevision('project-1', -1)).toThrow(
      RangeError,
    );
    expect(() => autosave.setExpectedRevision('project-1', 1.5)).toThrow(
      RangeError,
    );
    expect(() =>
      autosave.setExpectedRevision('project-1', Number.MAX_SAFE_INTEGER + 1),
    ).toThrow(RangeError);

    autosave.schedule(project('still unconditional'));
    await autosave.flush();
    expect(save.mock.calls[0]).toHaveLength(1);
  });

  it('does not overwrite a replacement revision set while a save is in flight', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const originalSave = repository.save.bind(repository);
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const save = vi.fn(async (...args: Parameters<typeof originalSave>) => {
      await gate;
      return originalSave(...args);
    });
    repository.save = save;
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    autosave.setExpectedRevision('project-1', 0);

    autosave.schedule(project('in flight'));
    const flushing = autosave.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    autosave.setExpectedRevision('project-1', 7);
    releaseSave();
    await flushing;

    autosave.schedule(project('uses replacement'));
    await expect(autosave.flush()).rejects.toMatchObject({
      expectedRevision: 7,
      actualRevision: 1,
    });
    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'uses replacement' }),
      { expectedRevision: 7 },
    );
  });

  it('persists an edit that arrives while a write is in flight', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const originalSave = repository.save.bind(repository);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    repository.save = async (...args) => {
      calls += 1;
      if (calls === 1) {
        await gate;
      }
      return originalSave(...args);
    };
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });

    autosave.schedule(project('first'));
    const flushing = autosave.flush();
    await Promise.resolve();
    autosave.schedule(project('second'));
    releaseFirst();
    const stored = await flushing;

    expect(calls).toBe(2);
    expect(stored?.project.name).toBe('second');
    expect((await repository.get('project-1'))?.project.name).toBe('second');
  });

  it('flushes by default when disposed', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    autosave.schedule(project('before close'));

    await autosave.dispose();

    expect((await repository.get('project-1'))?.project.name).toBe('before close');
    expect(autosave.getState().status).toBe('disposed');
    expect(() => autosave.schedule(project('too late'))).toThrow(/disposed/);
  });

  it('retains a failed snapshot and recovers on the next flush', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const save = repository.save.bind(repository);
    const saved = vi.fn();
    const states: string[] = [];
    let fail = true;
    repository.save = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error('temporary quota failure');
      }
      return save(...args);
    };
    const autosave = new AutosaveCoordinator({
      repository,
      delayMs: 10_000,
      onSaved: saved,
      onStateChange: (state) => states.push(state.status),
    });

    autosave.schedule(project('retry me'));
    await expect(autosave.flush()).rejects.toThrow('temporary quota failure');
    expect(autosave.getState()).toMatchObject({
      status: 'error',
      dirty: true,
      projectId: 'project-1',
    });
    expect(await repository.get('project-1')).toBeUndefined();
    expect(saved).not.toHaveBeenCalled();

    await expect(autosave.flush()).resolves.toMatchObject({
      project: { name: 'retry me' },
      revision: 1,
    });
    expect(autosave.getState()).toMatchObject({ status: 'saved', dirty: false, revision: 1 });
    expect(saved).toHaveBeenCalledOnce();
    expect(states).toEqual(['scheduled', 'saving', 'error', 'saving', 'saved']);
  });

  it('retains a stale cross-tab edit, reports the conflict, and recovers after reseeding', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const first = await repository.save(project('first tab baseline'));
    const saved = vi.fn();
    const observedErrors: unknown[] = [];
    const autosave = new AutosaveCoordinator({
      repository,
      delayMs: 10_000,
      onSaved: saved,
      onStateChange: (state) => {
        if (state.status === 'error') observedErrors.push(state.error);
      },
    });
    autosave.setExpectedRevision('project-1', first.revision);

    const otherTab = await repository.save(project('other tab edit'), {
      expectedRevision: first.revision,
    });
    autosave.schedule(project('pending stale edit'));

    await expect(autosave.flush()).rejects.toMatchObject({
      name: 'ProjectRevisionConflictError',
      projectId: 'project-1',
      expectedRevision: 1,
      actualRevision: 2,
    });
    expect(autosave.getState()).toMatchObject({
      status: 'error',
      dirty: true,
      projectId: 'project-1',
      error: expect.any(ProjectRevisionConflictError),
    });
    expect(observedErrors).toEqual([expect.any(ProjectRevisionConflictError)]);
    expect(saved).not.toHaveBeenCalled();
    expect((await repository.get('project-1'))?.project.name).toBe(
      'other tab edit',
    );

    // The failed snapshot remains pending, so retrying with the stale revision
    // reports the same conflict instead of silently dropping the local edit.
    await expect(autosave.flush()).rejects.toBeInstanceOf(
      ProjectRevisionConflictError,
    );
    expect(observedErrors).toHaveLength(2);

    autosave.setExpectedRevision('project-1', otherTab.revision);
    await expect(autosave.flush()).resolves.toMatchObject({
      revision: 3,
      project: { name: 'pending stale edit' },
    });
    expect(autosave.getState()).toMatchObject({
      status: 'saved',
      dirty: false,
      revision: 3,
      error: undefined,
    });
    expect(saved).toHaveBeenCalledOnce();
  });

  it('lets a newer edit supersede a failed in-flight snapshot', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const save = repository.save.bind(repository);
    let rejectFirst!: (reason: Error) => void;
    const firstWrite = new Promise<never>((_, reject) => { rejectFirst = reject; });
    let calls = 0;
    repository.save = async (...args) => {
      calls += 1;
      if (calls === 1) return firstWrite;
      return save(...args);
    };
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });

    autosave.schedule(project('outdated'));
    const failedFlush = autosave.flush();
    await Promise.resolve();
    autosave.schedule(project('newest'));
    rejectFirst(new Error('first write failed'));
    await expect(failedFlush).rejects.toThrow('first write failed');

    await autosave.flush();
    expect(calls).toBe(2);
    expect((await repository.get('project-1'))?.project.name).toBe('newest');
    expect(autosave.getState()).toMatchObject({ status: 'saved', dirty: false });
  });

  it('can dispose without flushing a pending mutation', async () => {
    vi.useFakeTimers();
    const repository = new MemoryProjectRepository<TestProject>();
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    autosave.schedule(project('discard me'));

    await autosave.dispose({ flush: false });
    await vi.runAllTimersAsync();

    expect(await repository.get('project-1')).toBeUndefined();
    expect(autosave.getState()).toMatchObject({ status: 'disposed', dirty: false });
  });
});
