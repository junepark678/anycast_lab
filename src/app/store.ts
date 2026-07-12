import { applyEdgeChanges, applyNodeChanges, type Connection, type EdgeChange, type NodeChange } from '@xyflow/react';
import { create } from 'zustand';
import { PINNED_BIRD_VERSION, PINNED_FRR_VERSION } from '../appliances/v86';
import type { ConfigDiagnostic, EngineSnapshot, LabFile, LabInterface, LabLink, LabNode, LabProject, PacketTrace } from '../core/types';
import { createExampleProject } from './example-project';
import type { LabCanvasEdge, LabCanvasNode, NodeKind, Selection, TerminalLine } from './view-types';

interface LabStore {
  project: LabProject;
  running: boolean;
  dirty: boolean;
  saveState: 'saved' | 'saving' | 'error';
  selection: Selection;
  editorNodeId: string | null;
  editorPath: string | null;
  diagnostics: ConfigDiagnostic[];
  snapshot: EngineSnapshot | null;
  trace: PacketTrace | null;
  terminalLinesByNode: Record<string, TerminalLine[]>;
  setProject(project: LabProject): void;
  markSaved(project: Pick<LabProject, 'id' | 'updatedAt'>): void;
  markSaving(): void;
  markSaveError(): void;
  renameProject(name: string): void;
  setRunning(running: boolean): void;
  setRuntimeMode(mode: 'simulation' | 'native'): void;
  setSelection(selection: Selection): void;
  updateNodes(changes: NodeChange<LabCanvasNode>[]): void;
  updateEdges(changes: EdgeChange<LabCanvasEdge>[]): void;
  connect(connection: Connection): void;
  addNode(kind: NodeKind, position?: { x: number; y: number }): void;
  patchNode(id: string, patch: Partial<LabNode>): void;
  setNodeInterfaces(id: string, interfaces: LabInterface[]): void;
  patchLink(id: string, patch: Partial<LabLink>): void;
  deleteSelection(): void;
  openConfig(nodeId: string): void;
  closeConfig(): void;
  selectConfig(path: string): void;
  writeConfig(nodeId: string, path: string, content: string): void;
  setDiagnostics(diagnostics: ConfigDiagnostic[]): void;
  setSnapshot(snapshot: EngineSnapshot | null): void;
  setTrace(trace: PacketTrace | null): void;
  appendTerminal(nodeId: string, stream: TerminalLine['stream'], text: string): void;
  clearTerminal(nodeId: string): void;
  resetRuntime(): void;
}

function markChanged(project: LabProject): Pick<LabStore, 'project' | 'dirty' | 'saveState'> {
  const previousTimestamp = Date.parse(project.updatedAt);
  const nextTimestamp = Number.isFinite(previousTimestamp)
    ? Math.max(Date.now(), previousTimestamp + 1)
    : Date.now();
  return { project: { ...project, updatedAt: new Date(nextTimestamp).toISOString() }, dirty: true, saveState: 'saved' };
}

function applianceTerminalLines(project: LabProject, message: string): Record<string, TerminalLine[]> {
  return Object.fromEntries(project.nodes
    .filter((node) => node.kind !== 'switch')
    .map((node) => [node.id, [{ id: `${node.id}-${newId('line')}`, stream: 'system' as const, text: message }]]));
}

function viewKind(node: LabNode): NodeKind {
  if (node.kind === 'route-server') return 'route-server';
  if (node.kind === 'router') return node.appliance.kind === 'frr' ? 'frr' : 'bird';
  return node.kind;
}

function nodeToCanvas(node: LabNode, snapshot?: EngineSnapshot | null, engineRunning = false): LabCanvasNode {
  const runtimeState = snapshot?.nodes.find((candidate) => candidate.nodeId === node.id);
  return {
    id: node.id,
    type: 'labNode',
    position: node.position ?? { x: 100, y: 100 },
    data: {
      label: node.name,
      kind: viewKind(node),
      location: node.tags?.[0],
      enabled: node.state === 'up',
      status: node.state === 'down' ? 'stopped' : engineRunning
        ? runtimeState?.running || (runtimeState === undefined && node.appliance.runtime === 'wasm') ? 'running' : 'starting'
        : 'stopped',
      runtime: node.appliance.runtime === 'wasm' ? 'native-wasm' : node.kind === 'router' || node.kind === 'route-server' ? 'compatibility' : 'builtin',
      runtimeLabel: node.appliance.runtime === 'wasm'
        ? node.kind === 'client' || node.kind === 'service'
          ? `Linux ${node.kind} · native namespace in shared VM`
          : `${node.appliance.kind.toUpperCase()} ${node.appliance.version ?? ''} · native namespace in shared VM`
        : node.kind === 'router' || node.kind === 'route-server'
          ? `${node.appliance.kind.toUpperCase()} compatibility runtime`
          : `${node.appliance.kind} appliance`,
      asn: node.asn,
      addresses: node.interfaces.flatMap((networkInterface) => networkInterface.addresses),
    },
  };
}

function edgeToCanvas(link: LabLink): LabCanvasEdge {
  return {
    id: link.id,
    source: link.endpoints[0].nodeId,
    target: link.endpoints[1].nodeId,
    type: 'smoothstep',
    data: {
      latencyMs: link.latencyMs,
      jitterMs: link.jitterMs ?? 0,
      lossPercent: (link.loss ?? 0) * 100,
      bandwidthMbps: link.bandwidthMbps ?? 1000,
      enabled: link.state === 'up',
    },
  };
}

export function projectCanvas(project: LabProject, snapshot?: EngineSnapshot | null, engineRunning = false): { nodes: LabCanvasNode[]; edges: LabCanvasEdge[] } {
  return { nodes: project.nodes.map((node) => nodeToCanvas(node, snapshot, engineRunning)), edges: project.links.map(edgeToCanvas) };
}

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function baseInterface(nodeId: string, index = 0): LabInterface {
  return { id: `${nodeId}-eth${index}`, name: `eth${index}`, addresses: [], state: 'up', mtu: 1500 };
}

function starterFile(kind: NodeKind): LabFile[] {
  if (kind === 'bird' || kind === 'route-server') {
    return [{
      path: '/etc/bird/bird.conf', entrypoint: true, encoding: 'utf-8',
      content: `router id 192.0.2.1;\n\nprotocol device {}\nprotocol direct { ipv4; ipv6; }\n\n# Add BGP, OSPF, or static protocols here.\n`,
    }];
  }
  if (kind === 'frr') {
    return [{
      path: '/etc/frr/frr.conf', entrypoint: true, encoding: 'utf-8',
      content: `frr defaults traditional\nhostname router\nservice integrated-vtysh-config\n!\nrouter bgp 65001\n bgp router-id 192.0.2.1\n!\nline vty\n`,
    }];
  }
  return [];
}

function makeNode(kind: NodeKind, index: number): LabNode {
  const id = newId(kind);
  const appliance = kind === 'frr' ? 'frr' : kind === 'bird' || kind === 'route-server' ? 'bird' : kind;
  const nodeKind = kind === 'bird' || kind === 'frr' ? 'router' : kind;
  const labels: Record<NodeKind, string> = { bird: 'BIRD router', frr: 'FRR router', client: 'Client', service: 'Service', switch: 'Switch', 'route-server': 'Route server' };
  return {
    id, name: labels[kind], kind: nodeKind,
    appliance: {
      kind: appliance,
      runtime: nodeKind === 'router' || nodeKind === 'route-server' ? 'compatibility' : 'compatibility',
      version: kind === 'frr' ? '10.4' : kind === 'bird' || kind === 'route-server' ? '2.17.1' : '1',
      entrypoint: kind === 'frr' ? '/etc/frr/frr.conf' : kind === 'bird' || kind === 'route-server' ? '/etc/bird/bird.conf' : undefined,
    },
    interfaces: [baseInterface(id)], files: starterFile(kind), state: 'up', position: { x: 250 + (index % 3) * 190, y: 110 + Math.floor(index / 3) * 150 },
    asn: nodeKind === 'router' || nodeKind === 'route-server' ? 65001 : undefined,
    client: kind === 'client' ? {} : undefined,
    service: kind === 'service' ? { addresses: [], protocols: ['icmp'] } : undefined,
  };
}

function availableInterface(node: LabNode, links: LabLink[]): { node: LabNode; interfaceId: string } {
  const used = new Set(links.flatMap((link) => link.endpoints.filter((endpoint) => endpoint.nodeId === node.id).map((endpoint) => endpoint.interfaceId)));
  const existing = node.interfaces.find((networkInterface) => !used.has(networkInterface.id));
  if (existing) return { node, interfaceId: existing.id };
  const created = baseInterface(node.id, node.interfaces.length);
  return { node: { ...node, interfaces: [...node.interfaces, created] }, interfaceId: created.id };
}

export const useLabStore = create<LabStore>((set, get) => ({
  project: createExampleProject(), running: false, dirty: false, saveState: 'saved', selection: null,
  editorNodeId: null, editorPath: null, diagnostics: [], snapshot: null, trace: null,
  terminalLinesByNode: applianceTerminalLines(createExampleProject(), 'Appliance console ready. Try “show protocols”, “show route”, or “ip addr”.'),
  setProject: (project) => set({
    project,
    dirty: false,
    saveState: 'saved',
    selection: null,
    editorNodeId: null,
    editorPath: null,
    snapshot: null,
    trace: null,
    terminalLinesByNode: applianceTerminalLines(project, 'Appliance console ready.'),
  }),
  markSaved: (savedProject) => set((state) => (
    state.project.id === savedProject.id && state.project.updatedAt === savedProject.updatedAt
      ? { dirty: false, saveState: 'saved' }
      : {}
  )),
  markSaving: () => set({ saveState: 'saving' }),
  markSaveError: () => set({ saveState: 'error' }),
  renameProject: (name) => set(({ project }) => markChanged({ ...project, name })),
  setRunning: (running) => set({ running }),
  setRuntimeMode: (mode) => set(({ project }) => markChanged({
    ...project,
    nodes: project.nodes.map((node) => {
      if (node.kind === 'switch') return node;
      const version = mode === 'native'
        ? node.appliance.kind === 'bird' ? PINNED_BIRD_VERSION
          : node.appliance.kind === 'frr' ? PINNED_FRR_VERSION
            : node.appliance.version
        : node.appliance.version;
      return {
        ...node,
        appliance: {
          ...node.appliance,
          runtime: mode === 'native' ? 'wasm' : 'compatibility',
          version,
        },
      };
    }),
  })),
  setSelection: (selection) => set({ selection }),
  updateNodes: (changes) => set(({ project }) => {
    const current = project.nodes.map((node) => nodeToCanvas(node));
    const changed = applyNodeChanges(changes, current);
    const positions = new Map(changed.map((node) => [node.id, node.position]));
    return markChanged({ ...project, nodes: project.nodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })) });
  }),
  updateEdges: (changes) => set(({ project }) => {
    const removed = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
    applyEdgeChanges(changes, project.links.map(edgeToCanvas));
    return markChanged({ ...project, links: project.links.filter((link) => !removed.has(link.id)) });
  }),
  connect: (connection) => set(({ project }) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return {};
    let source = project.nodes.find((node) => node.id === connection.source);
    let target = project.nodes.find((node) => node.id === connection.target);
    if (!source || !target) return {};
    const sourceResult = availableInterface(source, project.links); source = sourceResult.node;
    const targetResult = availableInterface(target, project.links); target = targetResult.node;
    const link: LabLink = { id: newId('link'), endpoints: [{ nodeId: source.id, interfaceId: sourceResult.interfaceId }, { nodeId: target.id, interfaceId: targetResult.interfaceId }], state: 'up', latencyMs: 10, jitterMs: 0, loss: 0, bandwidthMbps: 1000 };
    return markChanged({ ...project, nodes: project.nodes.map((node) => node.id === source?.id ? source : node.id === target?.id ? target : node), links: [...project.links, link] });
  }),
  addNode: (kind, position) => set(({ project, terminalLinesByNode }) => {
    const node = { ...makeNode(kind, project.nodes.length), ...(position ? { position } : {}) };
    return {
      ...markChanged({ ...project, nodes: [...project.nodes, node] }),
      selection: { kind: 'node', id: node.id } as Selection,
      terminalLinesByNode: node.kind === 'switch' ? terminalLinesByNode : {
        ...terminalLinesByNode,
        [node.id]: [{ id: `${node.id}-${newId('line')}`, stream: 'system', text: 'Appliance console ready.' }],
      },
    };
  }),
  patchNode: (id, patch) => set(({ project }) => markChanged({ ...project, nodes: project.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) })),
  setNodeInterfaces: (id, interfaces) => set(({ project }) => {
    const validIds = new Set(interfaces.map((networkInterface) => networkInterface.id));
    return markChanged({
      ...project,
      nodes: project.nodes.map((node) => node.id === id ? { ...node, interfaces } : node),
      links: project.links.filter((link) => link.endpoints.every((endpoint) => endpoint.nodeId !== id || validIds.has(endpoint.interfaceId))),
    });
  }),
  patchLink: (id, patch) => set(({ project }) => markChanged({ ...project, links: project.links.map((link) => link.id === id ? { ...link, ...patch } : link) })),
  deleteSelection: () => set(({ project, selection, terminalLinesByNode }) => {
    if (!selection) return {};
    if (selection.kind === 'node') {
      const { [selection.id]: _removedTerminal, ...remainingTerminals } = terminalLinesByNode;
      return {
        ...markChanged({ ...project, nodes: project.nodes.filter((node) => node.id !== selection.id), links: project.links.filter((link) => link.endpoints.every((endpoint) => endpoint.nodeId !== selection.id)) }),
        selection: null,
        editorNodeId: null,
        editorPath: null,
        terminalLinesByNode: remainingTerminals,
      };
    }
    return { ...markChanged({ ...project, links: project.links.filter((link) => link.id !== selection.id) }), selection: null };
  }),
  openConfig: (nodeId) => {
    const node = get().project.nodes.find((candidate) => candidate.id === nodeId);
    set({ editorNodeId: nodeId, editorPath: node?.appliance.entrypoint ?? node?.files[0]?.path ?? null, selection: { kind: 'node', id: nodeId }, diagnostics: [] });
  },
  closeConfig: () => set({ editorNodeId: null, editorPath: null, diagnostics: [] }),
  selectConfig: (path) => set({ editorPath: path }),
  writeConfig: (nodeId, path, content) => set(({ project }) => markChanged({ ...project, nodes: project.nodes.map((node) => node.id === nodeId ? { ...node, files: node.files.map((candidate) => candidate.path === path ? { ...candidate, content } : candidate) } : node) })),
  setDiagnostics: (diagnostics) => set({ diagnostics }),
  setSnapshot: (snapshot) => set({ snapshot }),
  setTrace: (trace) => set({ trace }),
  appendTerminal: (nodeId, stream, text) => set(({ terminalLinesByNode }) => ({
    terminalLinesByNode: {
      ...terminalLinesByNode,
      [nodeId]: [...(terminalLinesByNode[nodeId] ?? []).slice(-499), { id: newId('line'), stream, text }],
    },
  })),
  clearTerminal: (nodeId) => set(({ terminalLinesByNode }) => ({
    terminalLinesByNode: { ...terminalLinesByNode, [nodeId]: [] },
  })),
  resetRuntime: () => set(({ project }) => ({
    running: false,
    snapshot: null,
    trace: null,
    diagnostics: [],
    terminalLinesByNode: applianceTerminalLines(project, 'Runtime reset. Appliance console ready.'),
  })),
}));
