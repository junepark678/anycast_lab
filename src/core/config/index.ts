import type { LabNode, ParsedApplianceConfig } from '../types';
import { parseBirdConfig } from './bird';
import { parseFrrConfig } from './frr';

export { parseBirdConfig } from './bird';
export { parseFrrConfig } from './frr';

export function parseNativeConfig(node: LabNode): ParsedApplianceConfig {
  if (node.appliance.kind === 'bird') return parseBirdConfig(node);
  if (node.appliance.kind === 'frr') return parseFrrConfig(node);
  return {
    daemon: node.appliance.kind,
    routerId: node.routerId,
    interfaces: [],
    staticRoutes: [],
    bgp: [],
    ospf: [],
    diagnostics: [],
    sourceFiles: node.files.map((file) => ({ ...file })),
  };
}
