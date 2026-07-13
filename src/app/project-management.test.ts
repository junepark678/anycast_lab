import { describe, expect, it } from 'vitest';

import {
  createBlankProject,
  createDefaultDemoProject,
  createDuplicateProjectName,
  duplicateProject,
  filterProjectSummaries,
  MAX_PROJECT_NAME_LENGTH,
  ProjectNameError,
  validateProjectName,
} from './project-management';

const FIRST_UUID = '00000000-0000-4000-8000-000000000001';
const SECOND_UUID = '00000000-0000-4000-8000-000000000002';
const THIRD_UUID = '00000000-0000-4000-8000-000000000003';
const NOW = new Date('2026-07-13T01:02:03.456Z');

function ids(...values: string[]): () => string {
  let index = 0;
  return () => values[index++] ?? values.at(-1)!;
}

describe('managed project factories', () => {
  it('trims and validates project names', () => {
    expect(validateProjectName('  Seoul edge lab  ')).toBe('Seoul edge lab');
    expect(() => validateProjectName(' \t ')).toThrow(
      expect.objectContaining({
        name: 'ProjectNameError',
        reason: 'empty',
      } satisfies Partial<ProjectNameError>),
    );
    expect(() => validateProjectName('one\nproject')).toThrow(
      expect.objectContaining({ reason: 'control-character' }),
    );
    expect(() => validateProjectName('🍉'.repeat(MAX_PROJECT_NAME_LENGTH + 1))).toThrow(
      expect.objectContaining({ reason: 'too-long' }),
    );
  });

  it('creates a UUID-backed blank project with deterministic timestamps', () => {
    const project = createBlankProject('  New network  ', {
      now: () => NOW,
      randomUUID: () => FIRST_UUID,
    });

    expect(project).toMatchObject({
      id: FIRST_UUID,
      name: 'New network',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      seed: 1,
      nodes: [],
      links: [],
      scenarioEvents: [],
      settings: {
        defaultTtl: 32,
        maxConvergenceIterations: 64,
        captureLimit: 10_000,
      },
    });
  });

  it('creates independent UUID-backed clones of the default demo', () => {
    const first = createDefaultDemoProject({
      now: () => NOW,
      randomUUID: () => FIRST_UUID,
    });
    first.nodes[0]!.name = 'Changed outside the template';
    first.nodes[1]!.files[0]!.content = 'changed';

    const second = createDefaultDemoProject({
      now: () => NOW,
      randomUUID: () => SECOND_UUID,
    });
    expect(second).toMatchObject({
      id: SECOND_UUID,
      name: 'Two-PoP anycast lab',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(second.nodes[0]!.name).toBe('Client · Seoul');
    expect(second.nodes[1]!.files[0]!.content).not.toBe('changed');
    expect(second.nodes).not.toBe(first.nodes);
    expect(second.links).not.toBe(first.links);
  });

  it('deep-duplicates with fresh identity, time, and a collision-safe name', () => {
    const source = createDefaultDemoProject({
      now: () => new Date('2025-01-01T00:00:00Z'),
      randomUUID: () => FIRST_UUID,
    });
    source.name = 'Café core';
    const sourceConfig = source.nodes[1]!.files[0]!.content;
    const existing = [
      { id: FIRST_UUID, name: source.name },
      { id: SECOND_UUID, name: 'CAFÉ CORE COPY' },
      { id: 'legacy-id', name: 'Cafe\u0301 core copy 2' },
    ];

    const copy = duplicateProject(source, existing, {
      now: () => NOW,
      randomUUID: ids(FIRST_UUID, SECOND_UUID, THIRD_UUID),
    });

    expect(copy).toMatchObject({
      id: THIRD_UUID,
      name: 'Café core copy 3',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    copy.nodes[1]!.files[0]!.content = 'copy changed';
    copy.links[0]!.latencyMs = 999;
    expect(source.nodes[1]!.files[0]!.content).toBe(sourceConfig);
    expect(source.links[0]!.latencyMs).not.toBe(999);
    expect(copy.nodes).not.toBe(source.nodes);
  });

  it('keeps generated copy names within the validated name limit', () => {
    const sourceName = 'n'.repeat(MAX_PROJECT_NAME_LENGTH);
    const first = createDuplicateProjectName(sourceName, []);
    const second = createDuplicateProjectName(sourceName, [{ name: first }]);

    expect(Array.from(first)).toHaveLength(MAX_PROJECT_NAME_LENGTH);
    expect(first).toMatch(/ copy$/);
    expect(Array.from(second)).toHaveLength(MAX_PROJECT_NAME_LENGTH);
    expect(second).toMatch(/ copy 2$/);
  });

  it('rejects invalid factory dependencies rather than creating unstable metadata', () => {
    expect(() => createBlankProject('Broken', {
      now: () => new Date(Number.NaN),
      randomUUID: () => FIRST_UUID,
    })).toThrow('invalid date');
    expect(() => createBlankProject('Broken', {
      now: () => NOW,
      randomUUID: () => 'not-a-uuid',
    })).toThrow('invalid UUID');
  });
});

describe('project catalog search', () => {
  const projects = [
    { id: 'one', name: 'Café backbone' },
    { id: 'two', name: 'Róuter · São Paulo' },
    { id: 'three', name: 'Frankfurt Straße' },
    { id: 'four', name: '東京 edge' },
  ];

  it('matches case, composed/decomposed Unicode, accents, and multiple terms', () => {
    expect(filterProjectSummaries(projects, 'CAFE\u0301')).toEqual([projects[0]]);
    expect(filterProjectSummaries(projects, 'sao ROUTER')).toEqual([projects[1]]);
    expect(filterProjectSummaries(projects, 'strasse')).toEqual([projects[2]]);
    expect(filterProjectSummaries(projects, '京')).toEqual([projects[3]]);
  });

  it('preserves recent-first input order and returns a new list for blank search', () => {
    const results = filterProjectSummaries(projects, '  ');
    expect(results).toEqual(projects);
    expect(results).not.toBe(projects);
  });
});
