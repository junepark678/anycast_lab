import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutosaveCoordinator, MemoryProjectRepository } from '../persistence';
import {
  activatePersistedProject,
  replacePersistedProject,
  resumeProjectAutosave,
} from './project-replacement';

interface TestProject {
  id: string;
  name: string;
}

afterEach(() => vi.useRealTimers());

describe('replacePersistedProject', () => {
  it('opens an existing project without rewriting it or incrementing its revision', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    await repository.save({ id: 'current', name: 'Current project' });
    const target = await repository.save({ id: 'target', name: 'Saved target' });
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    autosave.schedule({ id: 'current', name: 'Current project with edits' });
    const installed = vi.fn();

    await activatePersistedProject({
      project: target.project,
      disposeRuntime: async () => {},
      autosave,
      install: installed,
    });

    expect(installed).toHaveBeenCalledWith(target.project);
    expect((await repository.get('target'))?.revision).toBe(target.revision);
    expect((await repository.get('current'))?.project.name).toBe('Current project with edits');
  });

  it('runs durable transition work after draining autosave and before installation', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    const order: string[] = [];
    autosave.schedule({ id: 'current', name: 'Pending current edit' });

    await activatePersistedProject({
      project: { id: 'target', name: 'Target' },
      disposeRuntime: async () => { order.push('dispose'); },
      autosave,
      beforeInstall: async () => {
        order.push((await repository.get('current')) === undefined ? 'missing' : 'saved');
      },
      install: () => { order.push('install'); },
    });

    expect(order).toEqual(['dispose', 'saved', 'install']);
  });

  it('drains an edit scheduled during delayed runtime disposal before installing a same-ID import', async () => {
    vi.useFakeTimers();
    const writes: TestProject[] = [];
    const repository = new MemoryProjectRepository<TestProject>();
    const save = repository.save.bind(repository);
    repository.save = async (project, options) => {
      writes.push(structuredClone(project));
      return save(project, options);
    };
    const autosave = new AutosaveCoordinator({ repository, delayMs: 25 });
    let finishDisposal!: () => void;
    const disposal = new Promise<void>((resolve) => { finishDisposal = resolve; });
    let installed: TestProject | undefined;
    const imported = { id: 'same-id', name: 'Imported project' };

    const replacing = replacePersistedProject({
      project: imported,
      disposeRuntime: () => disposal,
      autosave,
      repository,
      install: (project) => { installed = project; },
    });

    // This models an editor event arriving while a native VM takes time to
    // shut down. A drain placed before disposal would miss this snapshot.
    autosave.schedule({ id: 'same-id', name: 'Stale disposal-window edit' });
    finishDisposal();
    await replacing;
    await vi.advanceTimersByTimeAsync(50);

    expect(installed).toEqual(imported);
    expect(writes).toEqual([
      { id: 'same-id', name: 'Stale disposal-window edit' },
      imported,
    ]);
    expect(writes.at(-1)).toEqual(imported);
    expect(autosave.getState()).toMatchObject({ status: 'idle', dirty: false });
  });

  it('does not install an import when its durable write fails', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const save = repository.save.bind(repository);
    repository.save = async (project, options) => {
      if (project.name === 'Imported project') throw new Error('quota exceeded');
      return save(project, options);
    };
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    autosave.schedule({ id: 'same-id', name: 'Current project' });
    let installed: TestProject | undefined;

    await expect(replacePersistedProject({
      project: { id: 'same-id', name: 'Imported project' },
      disposeRuntime: async () => {},
      autosave,
      repository,
      install: (project) => { installed = project; },
    })).rejects.toThrow('quota exceeded');

    expect(installed).toBeUndefined();
    expect((await repository.get('same-id'))?.project.name).toBe('Current project');
  });

  it('reschedules a dirty mutation that completed while a failed import suspended autosave', async () => {
    const repository = new MemoryProjectRepository<TestProject>();
    const autosave = new AutosaveCoordinator({ repository, delayMs: 10_000 });
    const rememberProjectId = vi.fn();
    const lateMutation = { id: 'same-id', name: 'Late async config upload' };

    expect(resumeProjectAutosave({
      project: lateMutation,
      dirty: true,
      booted: true,
      autosave,
      rememberProjectId,
    })).toBe(true);
    await autosave.flush();

    expect((await repository.get('same-id'))?.project.name).toBe(lateMutation.name);
    expect(rememberProjectId).toHaveBeenCalledWith('same-id');
  });
});
