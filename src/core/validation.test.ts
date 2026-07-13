import { describe, expect, it } from 'vitest';
import { createExampleProject } from '../app/example-project';
import { assertValidProject, validateProject } from './validation';

describe('project validation', () => {
  it('accepts the complete starter topology', () => {
    const result = validateProject(createExampleProject());
    expect(result.success).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('reports duplicate nodes, reused interfaces, missing endpoints and bad addresses', () => {
    const project = createExampleProject();
    project.nodes.push(structuredClone(project.nodes[0]!));
    project.nodes[0]!.interfaces[0]!.addresses = ['not-an-address'];
    project.links.push({
      id: 'broken', state: 'up', latencyMs: -1,
      endpoints: [{ nodeId: 'missing', interfaceId: 'eth0' }, { ...project.links[0]!.endpoints[0] }],
    });
    const result = validateProject(project);
    expect(result.success).toBe(false);
    expect(result.issues.map((item) => item.code)).toEqual(expect.arrayContaining(['node.id-duplicate', 'interface.address-invalid', 'link.latency', 'link.node-missing', 'link.interface-reused']));
    expect(() => assertValidProject(project)).toThrow(/invalid/i);
  });

  it.each(['/etc/../tmp/config', '/etc//bird.conf', '/usr/local/config'])(
    'rejects appliance paths unsupported by the native runtime: %s',
    (path) => {
      const project = createExampleProject();
      const nodeIndex = project.nodes.findIndex((node) => node.files.length > 0);
      const node = project.nodes[nodeIndex]!;
      node.appliance.runtime = 'wasm';
      node.files[0]!.path = path;
      node.appliance.entrypoint = path;

      const result = validateProject(project);

      expect(result.success).toBe(false);
      expect(result.issues).toContainEqual(
        expect.objectContaining({ path: `nodes[${nodeIndex}].files[0].path`, code: 'file.path' }),
      );
    },
  );

  it('allows normalized paths outside native writable roots for compatibility appliances', () => {
    const project = createExampleProject();
    const node = project.nodes.find((candidate) => candidate.files.length > 0)!;
    node.appliance.runtime = 'compatibility';
    node.files[0]!.path = '/usr/local/config';
    node.appliance.entrypoint = '/usr/local/config';

    expect(validateProject(project)).toMatchObject({ success: true, issues: [] });
  });

  it('rejects non-finite link loss', () => {
    const project = createExampleProject();
    project.links[0]!.loss = Number.NaN;

    const result = validateProject(project);

    expect(result.success).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({ path: 'links[0].loss', code: 'link.loss' }),
    );
  });
});
