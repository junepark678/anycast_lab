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
});
