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
});
