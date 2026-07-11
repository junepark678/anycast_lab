import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutosaveCoordinator, MemoryProjectRepository } from '../persistence';
import { replacePersistedProject, resumeProjectAutosave } from './project-replacement';

interface TestProject {
  id: string;
  name: string;
}

afterEach(() => vi.useRealTimers());

describe('replacePersistedProject', () => {
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
