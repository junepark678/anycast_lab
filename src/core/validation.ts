import { tryParseIp, tryParsePrefix } from './ip';
import {
  CURRENT_SCHEMA_VERSION,
  type ApplianceKind,
  type LabNode,
  type LabProject,
  type ValidationIssue,
  type ValidationResult,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issue(
  issues: ValidationIssue[],
  path: string,
  code: string,
  message: string,
  severity: ValidationIssue['severity'] = 'error',
): void {
  issues.push({ path, code, message, severity });
}

const NODE_KINDS = new Set(['router', 'route-server', 'client', 'service', 'switch']);
const APPLIANCE_KINDS = new Set<ApplianceKind>(['bird', 'frr', 'client', 'service', 'switch']);
const WRITABLE_APPLIANCE_ROOTS = ['/etc', '/home', '/root', '/run', '/tmp', '/var'];

function isNormalizedAppliancePath(path: string): boolean {
  if (path === '/' || !path.startsWith('/') || path.endsWith('/') || new TextEncoder().encode(path).length >= 4096) {
    return false;
  }
  return !path.split('/').slice(1).some((component) => component === '' || component === '.' || component === '..');
}

function isWritableAppliancePath(path: string): boolean {
  if (!isNormalizedAppliancePath(path)) return false;
  return WRITABLE_APPLIANCE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

function validateNodeShape(node: unknown, index: number, issues: ValidationIssue[]): node is LabNode {
  const path = `nodes[${index}]`;
  if (!isRecord(node)) {
    issue(issues, path, 'node.type', 'Node must be an object.');
    return false;
  }
  for (const key of ['id', 'name'] as const) {
    if (typeof node[key] !== 'string' || node[key].trim() === '') {
      issue(issues, `${path}.${key}`, `node.${key}`, `${key} must be a non-empty string.`);
    }
  }
  if (!NODE_KINDS.has(String(node.kind))) {
    issue(issues, `${path}.kind`, 'node.kind', `Unsupported node kind: ${String(node.kind)}.`);
  }
  if (node.state !== 'up' && node.state !== 'down') {
    issue(issues, `${path}.state`, 'node.state', "Node state must be 'up' or 'down'.");
  }
  if (!isRecord(node.appliance)) {
    issue(issues, `${path}.appliance`, 'appliance.type', 'Appliance must be an object.');
  } else {
    if (!APPLIANCE_KINDS.has(node.appliance.kind as ApplianceKind)) {
      issue(
        issues,
        `${path}.appliance.kind`,
        'appliance.kind',
        `Unsupported appliance kind: ${String(node.appliance.kind)}.`,
      );
    }
    if (node.appliance.runtime !== 'compatibility' && node.appliance.runtime !== 'wasm') {
      issue(
        issues,
        `${path}.appliance.runtime`,
        'appliance.runtime',
        "Runtime must be 'compatibility' or 'wasm'.",
      );
    }
  }

  if (node.asn !== undefined && (typeof node.asn !== 'number' || !Number.isInteger(node.asn) || node.asn < 1 || node.asn > 4_294_967_295)) {
    issue(issues, `${path}.asn`, 'node.asn', 'ASN must be an integer between 1 and 4294967295.');
  }
  if (node.routerId !== undefined) {
    const routerId = typeof node.routerId === 'string' ? tryParseIp(node.routerId) : undefined;
    if (!routerId || routerId.family !== 'ipv4') {
      issue(issues, `${path}.routerId`, 'node.router-id', 'Router ID must be an IPv4 address.');
    }
  }

  if (!Array.isArray(node.interfaces)) {
    issue(issues, `${path}.interfaces`, 'interfaces.type', 'Interfaces must be an array.');
  } else {
    const interfaceIds = new Set<string>();
    const interfaceNames = new Set<string>();
    node.interfaces.forEach((candidate, interfaceIndex) => {
      const interfacePath = `${path}.interfaces[${interfaceIndex}]`;
      if (!isRecord(candidate)) {
        issue(issues, interfacePath, 'interface.type', 'Interface must be an object.');
        return;
      }
      if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
        issue(issues, `${interfacePath}.id`, 'interface.id', 'Interface ID is required.');
      } else if (interfaceIds.has(candidate.id)) {
        issue(issues, `${interfacePath}.id`, 'interface.id-duplicate', 'Interface IDs must be unique per node.');
      } else {
        interfaceIds.add(candidate.id);
      }
      if (typeof candidate.name !== 'string' || candidate.name.trim() === '') {
        issue(issues, `${interfacePath}.name`, 'interface.name', 'Interface name is required.');
      } else if (interfaceNames.has(candidate.name)) {
        issue(
          issues,
          `${interfacePath}.name`,
          'interface.name-duplicate',
          'Interface names must be unique per node.',
        );
      } else {
        interfaceNames.add(candidate.name);
      }
      if (candidate.state !== 'up' && candidate.state !== 'down') {
        issue(issues, `${interfacePath}.state`, 'interface.state', "State must be 'up' or 'down'.");
      }
      if (!Array.isArray(candidate.addresses)) {
        issue(issues, `${interfacePath}.addresses`, 'interface.addresses', 'Addresses must be an array.');
      } else {
        candidate.addresses.forEach((address, addressIndex) => {
          if (typeof address !== 'string' || !tryParsePrefix(address)) {
            issue(
              issues,
              `${interfacePath}.addresses[${addressIndex}]`,
              'interface.address-invalid',
              `Invalid IP interface prefix: ${String(address)}.`,
            );
          }
        });
      }
      if (candidate.gateway !== undefined && (typeof candidate.gateway !== 'string' || !tryParseIp(candidate.gateway))) {
        issue(issues, `${interfacePath}.gateway`, 'interface.gateway', 'Gateway must be an IP address.');
      }
      if (
        candidate.mtu !== undefined &&
        (typeof candidate.mtu !== 'number' || !Number.isInteger(candidate.mtu) || candidate.mtu < 576 || candidate.mtu > 65_535)
      ) {
        issue(issues, `${interfacePath}.mtu`, 'interface.mtu', 'MTU must be between 576 and 65535.');
      }
    });
  }

  if (!Array.isArray(node.files)) {
    issue(issues, `${path}.files`, 'files.type', 'Files must be an array.');
  } else {
    const paths = new Set<string>();
    let entrypoints = 0;
    const nativeRuntime = isRecord(node.appliance) && node.appliance.runtime === 'wasm';
    node.files.forEach((candidate, fileIndex) => {
      const filePath = `${path}.files[${fileIndex}]`;
      if (!isRecord(candidate)) {
        issue(issues, filePath, 'file.type', 'File must be an object.');
        return;
      }
      const candidatePath = typeof candidate.path === 'string' ? candidate.path : undefined;
      const validPath = candidatePath !== undefined && (
        nativeRuntime ? isWritableAppliancePath(candidatePath) : isNormalizedAppliancePath(candidatePath)
      );
      if (!validPath) {
        issue(
          issues,
          `${filePath}.path`,
          'file.path',
          nativeRuntime
            ? 'Native appliance file paths must be normalized absolute paths under /etc, /home, /root, /run, /tmp, or /var.'
            : 'Appliance file paths must be normalized and absolute.',
        );
      } else if (paths.has(candidatePath)) {
        issue(issues, `${filePath}.path`, 'file.path-duplicate', 'File paths must be unique per appliance.');
      } else {
        paths.add(candidatePath);
      }
      if (typeof candidate.content !== 'string') {
        issue(issues, `${filePath}.content`, 'file.content', 'File content must be text.');
      }
      if (candidate.entrypoint === true) entrypoints += 1;
    });
    if (entrypoints > 1) {
      issue(issues, `${path}.files`, 'file.entrypoint-duplicate', 'Only one file can be marked as the entrypoint.');
    }
    if (isRecord(node.appliance) && typeof node.appliance.entrypoint === 'string' && !paths.has(node.appliance.entrypoint)) {
      issue(
        issues,
        `${path}.appliance.entrypoint`,
        'file.entrypoint-missing',
        `Entrypoint ${node.appliance.entrypoint} does not exist in the appliance files.`,
      );
    }
  }

  if (node.kind === 'service') {
    if (!isRecord(node.service) || !Array.isArray(node.service.addresses)) {
      issue(issues, `${path}.service`, 'service.options', 'Service nodes require a service.addresses array.');
    } else {
      node.service.addresses.forEach((address, addressIndex) => {
        if (typeof address !== 'string' || !tryParsePrefix(address)) {
          issue(
            issues,
            `${path}.service.addresses[${addressIndex}]`,
            'service.address-invalid',
            `Invalid service address or prefix: ${String(address)}.`,
          );
        }
      });
    }
  }

  return true;
}

export function validateProject(value: unknown): ValidationResult<LabProject> {
  const issues: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return {
      success: false,
      issues: [{ path: '', code: 'project.type', message: 'Project must be an object.', severity: 'error' }],
    };
  }

  if (value.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    issue(
      issues,
      'schemaVersion',
      'project.schema-version',
      `Expected schema version ${CURRENT_SCHEMA_VERSION}; received ${String(value.schemaVersion)}.`,
    );
  }
  for (const key of ['id', 'name', 'createdAt', 'updatedAt'] as const) {
    if (typeof value[key] !== 'string' || value[key].trim() === '') {
      issue(issues, key, `project.${key}`, `${key} must be a non-empty string.`);
    }
  }
  for (const key of ['createdAt', 'updatedAt'] as const) {
    if (typeof value[key] === 'string' && Number.isNaN(Date.parse(value[key]))) {
      issue(issues, key, `project.${key}-invalid`, `${key} must be an ISO-compatible timestamp.`);
    }
  }
  if (!Number.isInteger(value.seed)) {
    issue(issues, 'seed', 'project.seed', 'Seed must be an integer.');
  }

  const nodes = Array.isArray(value.nodes) ? value.nodes : [];
  if (!Array.isArray(value.nodes)) issue(issues, 'nodes', 'nodes.type', 'Nodes must be an array.');
  const nodeIds = new Set<string>();
  const typedNodes = new Map<string, LabNode>();
  nodes.forEach((node, index) => {
    if (validateNodeShape(node, index, issues) && typeof node.id === 'string') {
      if (nodeIds.has(node.id)) {
        issue(issues, `nodes[${index}].id`, 'node.id-duplicate', `Duplicate node ID: ${node.id}.`);
      }
      nodeIds.add(node.id);
      typedNodes.set(node.id, node);
    }
  });

  const links = Array.isArray(value.links) ? value.links : [];
  if (!Array.isArray(value.links)) issue(issues, 'links', 'links.type', 'Links must be an array.');
  const linkIds = new Set<string>();
  const usedEndpoints = new Set<string>();
  links.forEach((candidate, index) => {
    const path = `links[${index}]`;
    if (!isRecord(candidate)) {
      issue(issues, path, 'link.type', 'Link must be an object.');
      return;
    }
    if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
      issue(issues, `${path}.id`, 'link.id', 'Link ID is required.');
    } else if (linkIds.has(candidate.id)) {
      issue(issues, `${path}.id`, 'link.id-duplicate', `Duplicate link ID: ${candidate.id}.`);
    } else {
      linkIds.add(candidate.id);
    }
    if (candidate.state !== 'up' && candidate.state !== 'down') {
      issue(issues, `${path}.state`, 'link.state', "Link state must be 'up' or 'down'.");
    }
    if (typeof candidate.latencyMs !== 'number' || !Number.isFinite(candidate.latencyMs) || candidate.latencyMs < 0) {
      issue(issues, `${path}.latencyMs`, 'link.latency', 'Link latency must be a non-negative number.');
    }
    if (
      candidate.loss !== undefined &&
      (typeof candidate.loss !== 'number' || !Number.isFinite(candidate.loss) || candidate.loss < 0 || candidate.loss > 1)
    ) {
      issue(issues, `${path}.loss`, 'link.loss', 'Loss must be between 0 and 1.');
    }
    if (!Array.isArray(candidate.endpoints) || candidate.endpoints.length !== 2) {
      issue(issues, `${path}.endpoints`, 'link.endpoints', 'A link must have exactly two endpoints.');
      return;
    }
    const endpointKeys: string[] = [];
    candidate.endpoints.forEach((endpoint, endpointIndex) => {
      const endpointPath = `${path}.endpoints[${endpointIndex}]`;
      if (!isRecord(endpoint) || typeof endpoint.nodeId !== 'string' || typeof endpoint.interfaceId !== 'string') {
        issue(issues, endpointPath, 'link.endpoint', 'Endpoint requires nodeId and interfaceId.');
        return;
      }
      const node = typedNodes.get(endpoint.nodeId);
      if (!node) {
        issue(issues, `${endpointPath}.nodeId`, 'link.node-missing', `Unknown node: ${endpoint.nodeId}.`);
        return;
      }
      if (!node.interfaces.some((iface) => iface.id === endpoint.interfaceId)) {
        issue(
          issues,
          `${endpointPath}.interfaceId`,
          'link.interface-missing',
          `Node ${endpoint.nodeId} has no interface ${endpoint.interfaceId}.`,
        );
      }
      const key = `${endpoint.nodeId}:${endpoint.interfaceId}`;
      endpointKeys.push(key);
      if (usedEndpoints.has(key)) {
        issue(
          issues,
          endpointPath,
          'link.interface-reused',
          `Interface ${key} is already connected to another link.`,
        );
      }
      usedEndpoints.add(key);
    });
    if (endpointKeys.length === 2 && endpointKeys[0] === endpointKeys[1]) {
      issue(issues, `${path}.endpoints`, 'link.self', 'A link cannot connect an interface to itself.');
    }
  });

  const scenarioEvents = Array.isArray(value.scenarioEvents) ? value.scenarioEvents : [];
  if (!Array.isArray(value.scenarioEvents)) {
    issue(issues, 'scenarioEvents', 'scenario-events.type', 'Scenario events must be an array.');
  }
  const eventIds = new Set<string>();
  scenarioEvents.forEach((candidate, index) => {
    const path = `scenarioEvents[${index}]`;
    if (!isRecord(candidate)) {
      issue(issues, path, 'scenario-event.type', 'Scenario event must be an object.');
      return;
    }
    if (typeof candidate.id !== 'string' || candidate.id.trim() === '') {
      issue(issues, `${path}.id`, 'scenario-event.id', 'Scenario event ID is required.');
    } else if (eventIds.has(candidate.id)) {
      issue(issues, `${path}.id`, 'scenario-event.id-duplicate', `Duplicate event ID: ${candidate.id}.`);
    } else {
      eventIds.add(candidate.id);
    }
    if (typeof candidate.atMs !== 'number' || !Number.isFinite(candidate.atMs) || candidate.atMs < 0) {
      issue(issues, `${path}.atMs`, 'scenario-event.time', 'Event time must be non-negative.');
    }
    if (!isRecord(candidate.action)) {
      issue(issues, `${path}.action`, 'scenario-event.action', 'Event action is required.');
    } else if (candidate.action.type === 'link-state') {
      if (typeof candidate.action.linkId !== 'string' || !linkIds.has(candidate.action.linkId)) {
        issue(issues, `${path}.action.linkId`, 'scenario-event.link-missing', 'Event references an unknown link.');
      }
    } else if (candidate.action.type === 'node-state') {
      if (typeof candidate.action.nodeId !== 'string' || !nodeIds.has(candidate.action.nodeId)) {
        issue(issues, `${path}.action.nodeId`, 'scenario-event.node-missing', 'Event references an unknown node.');
      }
    } else {
      issue(issues, `${path}.action.type`, 'scenario-event.action-unknown', 'Unknown scenario action.');
    }
  });

  if (!isRecord(value.settings)) {
    issue(issues, 'settings', 'settings.type', 'Settings must be an object.');
  } else {
    if (!Number.isInteger(value.settings.defaultTtl) || Number(value.settings.defaultTtl) < 1 || Number(value.settings.defaultTtl) > 255) {
      issue(issues, 'settings.defaultTtl', 'settings.ttl', 'Default TTL must be between 1 and 255.');
    }
    if (!Number.isInteger(value.settings.maxConvergenceIterations) || Number(value.settings.maxConvergenceIterations) < 1) {
      issue(
        issues,
        'settings.maxConvergenceIterations',
        'settings.convergence',
        'Maximum convergence iterations must be a positive integer.',
      );
    }
    if (!Number.isInteger(value.settings.captureLimit) || Number(value.settings.captureLimit) < 1) {
      issue(issues, 'settings.captureLimit', 'settings.capture-limit', 'Capture limit must be a positive integer.');
    }
  }

  const hasErrors = issues.some((candidate) => candidate.severity === 'error');
  return {
    success: !hasErrors,
    value: hasErrors ? undefined : (value as unknown as LabProject),
    issues,
  };
}

export class ProjectValidationError extends Error {
  constructor(readonly issues: ValidationIssue[]) {
    super(issues.map((candidate) => `${candidate.path}: ${candidate.message}`).join('\n'));
    this.name = 'ProjectValidationError';
  }
}

export function assertValidProject(value: unknown): asserts value is LabProject {
  const result = validateProject(value);
  if (!result.success) throw new ProjectValidationError(result.issues);
}
