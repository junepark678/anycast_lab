import { afterEach, describe, expect, it, vi } from 'vitest';

import { AutosaveCoordinator } from './autosave';
import { MemoryProjectRepository } from './repository';

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
