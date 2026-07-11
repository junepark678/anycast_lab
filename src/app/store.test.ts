import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createExampleProject } from './example-project';
import { projectCanvas, useLabStore } from './store';

describe('lab editor store', () => {
  beforeEach(() => {
    useLabStore.getState().setProject(createExampleProject());
    useLabStore.getState().resetRuntime();
  });

  afterEach(() => vi.useRealTimers());

  it('maps the starter project to canvas nodes and links', () => {
    const project = useLabStore.getState().project;
    const canvas = projectCanvas(project);
    expect(canvas.nodes).toHaveLength(project.nodes.length);
    expect(canvas.edges).toHaveLength(project.links.length);
    expect(canvas.nodes.find((node) => node.id === 'pop-seoul')?.data.runtime).toBe('compatibility');
  });

  it('adds a router with a real native config path', () => {
    const before = useLabStore.getState().project.nodes.length;
    useLabStore.getState().addNode('bird');
    const state = useLabStore.getState();
    expect(state.project.nodes).toHaveLength(before + 1);
    const added = state.project.nodes.at(-1);
    expect(added?.appliance.entrypoint).toBe('/etc/bird/bird.conf');
    expect(added?.files[0]?.content).toContain('protocol device');
    expect(state.dirty).toBe(true);
  });

  it('preserves config text exactly while editing', () => {
    const node = useLabStore.getState().project.nodes.find((candidate) => candidate.id === 'pop-seoul');
    const path = node?.files[0]?.path;
    expect(path).toBeTruthy();
    const contents = 'router id 192.0.2.7;\n# spacing stays\n';
    useLabStore.getState().writeConfig('pop-seoul', path!, contents);
    expect(useLabStore.getState().project.nodes.find((candidate) => candidate.id === 'pop-seoul')?.files[0]?.content).toBe(contents);
  });

  it('removes links when a connected interface is deleted', () => {
    const state = useLabStore.getState();
    const transit = state.project.nodes.find((node) => node.id === 'transit')!;
    const removed = transit.interfaces.find((networkInterface) => networkInterface.id === 'transit-seoul')!;
    state.setNodeInterfaces('transit', transit.interfaces.filter((networkInterface) => networkInterface.id !== removed.id));
    expect(useLabStore.getState().project.links.some((link) => link.id === 'link-transit-seoul')).toBe(false);
  });

  it('switches every appliance between compatibility and version-pinned native VMs', () => {
    useLabStore.getState().setRuntimeMode('native');
    let state = useLabStore.getState();
    expect(state.project.nodes.filter((node) => node.kind !== 'switch').every((node) => node.appliance.runtime === 'wasm')).toBe(true);
    expect(state.project.nodes.find((node) => node.id === 'pop-seoul')?.appliance.version).toBe('2.15.1');
    expect(state.project.nodes.find((node) => node.id === 'pop-frankfurt')?.appliance.version).toBe('10.5.1');
    expect(projectCanvas(state.project).nodes.find((node) => node.id === 'pop-seoul')?.data.runtimeLabel).toContain('native Linux VM');
    expect(state.dirty).toBe(true);

    state.setRuntimeMode('simulation');
    state = useLabStore.getState();
    expect(state.project.nodes.filter((node) => node.kind !== 'switch').every((node) => node.appliance.runtime === 'compatibility')).toBe(true);
  });

  it('does not let a stale save acknowledgement clear a newer same-tick edit', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-11T00:00:00.000Z'));
    const state = useLabStore.getState();

    state.renameProject('Snapshot being saved');
    const savedSnapshot = structuredClone(useLabStore.getState().project);
    state.renameProject('Newer unsaved edit');
    const newerSnapshot = structuredClone(useLabStore.getState().project);

    expect(newerSnapshot.updatedAt).not.toBe(savedSnapshot.updatedAt);
    useLabStore.getState().markSaved(savedSnapshot);
    expect(useLabStore.getState().dirty).toBe(true);
    expect(useLabStore.getState().project.name).toBe('Newer unsaved edit');

    useLabStore.getState().markSaved(newerSnapshot);
    expect(useLabStore.getState().dirty).toBe(false);
  });
});
