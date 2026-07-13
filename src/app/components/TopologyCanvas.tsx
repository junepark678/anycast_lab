import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MiniMap,
  ReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type ReactFlowInstance,
  type XYPosition,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  FileCode2,
  Focus,
  GitFork,
  Link,
  Link2Off,
  Maximize2,
  Monitor,
  Network,
  Power,
  PowerOff,
  Router,
  Server,
  SlidersHorizontal,
  TerminalSquare,
  Trash2,
} from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import type { LabCanvasEdge, LabCanvasNode, NodeKind, Selection } from '../view-types';
import { ApplianceNode } from './ApplianceNode';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';

export const APPLIANCE_DRAG_TYPE = 'application/x-anycast-appliance';

const nodeKinds: NodeKind[] = ['bird', 'frr', 'client', 'service', 'switch', 'route-server'];

const nodeKindDetails: Record<NodeKind, { label: string; icon: typeof Router }> = {
  bird: { label: 'BIRD router', icon: Router },
  frr: { label: 'FRR router', icon: Router },
  client: { label: 'Client', icon: Monitor },
  service: { label: 'Service', icon: Server },
  switch: { label: 'Ethernet switch', icon: GitFork },
  'route-server': { label: 'Route server', icon: Network },
};

type MenuRequest =
  | { kind: 'node'; id: string; position: XYPosition }
  | { kind: 'edge'; id: string; position: XYPosition }
  | { kind: 'pane'; position: XYPosition; flowPosition: XYPosition };

type MenuState = MenuRequest & { instance: number };

function isNodeKind(value: string): value is NodeKind {
  return nodeKinds.includes(value as NodeKind);
}

function eventPosition(event: { clientX: number; clientY: number; currentTarget: EventTarget | null }): XYPosition {
  if (event.clientX !== 0 || event.clientY !== 0) return { x: event.clientX, y: event.clientY };
  if (event.currentTarget instanceof Element) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  }
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

interface Props {
  nodes: LabCanvasNode[];
  edges: LabCanvasEdge[];
  selection: Selection;
  onNodesChange: (changes: NodeChange<LabCanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<LabCanvasEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  onSelect: (selection: Selection) => void;
  onAddNode?: (kind: NodeKind, position: XYPosition) => void;
  onOpenNodeConfig?: (nodeId: string) => void;
  onOpenNodeConsole?: (nodeId: string) => void;
  onToggleNode?: (nodeId: string, enabled: boolean) => void;
  onToggleLink?: (linkId: string, enabled: boolean) => void;
  onDeleteItem?: (selection: Exclude<Selection, null>) => void;
  structuralLocked?: boolean;
  operationsLocked?: boolean;
}

export function TopologyCanvas({
  nodes,
  edges,
  selection,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelect,
  onAddNode,
  onOpenNodeConfig,
  onOpenNodeConsole,
  onToggleNode,
  onToggleLink,
  onDeleteItem,
  structuralLocked = false,
  operationsLocked = false,
}: Props) {
  const flowRef = useRef<Pick<ReactFlowInstance<LabCanvasNode>, 'fitView' | 'screenToFlowPosition'> | null>(null);
  const menuInstanceRef = useRef(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const nodeTypes = useMemo(() => ({ labNode: ApplianceNode }), []);
  const selectedNodes = useMemo<LabCanvasNode[]>(
    () => nodes.map((node) => ({
      ...node,
      selected: selection?.kind === 'node' && selection.id === node.id,
    })),
    [nodes, selection],
  );
  const styledEdges = useMemo<LabCanvasEdge[]>(
    () => edges.map((edge) => ({
      ...edge,
      selected: selection?.kind === 'link' && selection.id === edge.id,
      animated: edge.data?.enabled === false ? false : edge.animated,
      className: edge.data?.enabled === false ? 'lab-edge lab-edge--down' : 'lab-edge',
      label: edge.data
        ? `${edge.data.latencyMs} ms${edge.data.lossPercent ? ` · ${edge.data.lossPercent}% loss` : ''}`
        : edge.label,
    })),
    [edges, selection],
  );

  const connect = useCallback((connection: Connection) => {
    onConnect(connection);
  }, [onConnect]);

  const openMenu = useCallback((next: MenuRequest) => {
    menuInstanceRef.current += 1;
    setMenu({ ...next, instance: menuInstanceRef.current } as MenuState);
  }, []);

  const selectNodeThen = useCallback((nodeId: string, action: () => void) => {
    onSelect({ kind: 'node', id: nodeId });
    action();
  }, [onSelect]);

  const selectLinkThen = useCallback((linkId: string, action: () => void) => {
    onSelect({ kind: 'link', id: linkId });
    action();
  }, [onSelect]);

  const activeMenu = useMemo((): { ariaLabel: string; entries: ContextMenuEntry[] } | null => {
    if (!menu) return null;

    if (menu.kind === 'node') {
      const node = nodes.find((candidate) => candidate.id === menu.id);
      if (!node) return null;
      const entries: ContextMenuEntry[] = [];
      if (onOpenNodeConsole && node.data.kind !== 'switch') entries.push({
        id: 'open-console',
        label: 'Open console',
        icon: <TerminalSquare size={15} />,
        onSelect: () => selectNodeThen(node.id, () => onOpenNodeConsole(node.id)),
      });
      if (onOpenNodeConfig && ['bird', 'frr', 'route-server'].includes(node.data.kind)) entries.push({
        id: 'open-config',
        label: 'Open configuration',
        icon: <FileCode2 size={15} />,
        onSelect: () => selectNodeThen(node.id, () => onOpenNodeConfig(node.id)),
      });
      if (entries.length > 0) entries.push({ type: 'separator', id: 'node-open-separator' });
      if (onToggleNode) entries.push({
        id: 'toggle-node',
        label: node.data.enabled ? 'Disable node' : 'Enable node',
        icon: node.data.enabled ? <PowerOff size={15} /> : <Power size={15} />,
        disabled: operationsLocked,
        onSelect: () => selectNodeThen(node.id, () => onToggleNode(node.id, !node.data.enabled)),
      });
      entries.push({
        id: 'focus-node',
        label: 'Center in view',
        icon: <Focus size={15} />,
        onSelect: () => {
          onSelect({ kind: 'node', id: node.id });
          void flowRef.current?.fitView({ nodes: [{ id: node.id }], padding: 1.5, maxZoom: 1.35, duration: 250 });
        },
      });
      if (onDeleteItem) {
        entries.push({ type: 'separator', id: 'node-delete-separator' });
        entries.push({
          id: 'delete-node',
          label: 'Delete node',
          icon: <Trash2 size={15} />,
          disabled: structuralLocked,
          tone: 'danger',
          onSelect: () => selectNodeThen(node.id, () => onDeleteItem({ kind: 'node', id: node.id })),
        });
      }
      return { ariaLabel: `${node.data.label} actions`, entries };
    }

    if (menu.kind === 'edge') {
      const edge = edges.find((candidate) => candidate.id === menu.id);
      if (!edge) return null;
      const enabled = edge.data?.enabled !== false;
      const entries: ContextMenuEntry[] = [{
        id: 'inspect-link',
        label: 'Inspect link',
        icon: <SlidersHorizontal size={15} />,
        onSelect: () => onSelect({ kind: 'link', id: edge.id }),
      }];
      if (onToggleLink) entries.push({
        id: 'toggle-link',
        label: enabled ? 'Disable link' : 'Enable link',
        icon: enabled ? <Link2Off size={15} /> : <Link size={15} />,
        disabled: operationsLocked,
        onSelect: () => selectLinkThen(edge.id, () => onToggleLink(edge.id, !enabled)),
      });
      if (onDeleteItem) {
        entries.push({ type: 'separator', id: 'link-delete-separator' });
        entries.push({
          id: 'delete-link',
          label: 'Delete link',
          icon: <Trash2 size={15} />,
          disabled: structuralLocked,
          tone: 'danger',
          onSelect: () => selectLinkThen(edge.id, () => onDeleteItem({ kind: 'link', id: edge.id })),
        });
      }
      return { ariaLabel: `${edge.source} to ${edge.target} link actions`, entries };
    }

    const entries: ContextMenuEntry[] = [{
      id: 'fit-topology',
      label: 'Fit topology to view',
      icon: <Maximize2 size={15} />,
      onSelect: () => void flowRef.current?.fitView({ padding: 0.2, maxZoom: 1.15, duration: 250 }),
    }];
    if (onAddNode) {
      entries.push({ type: 'separator', id: 'add-node-separator' });
      for (const kind of nodeKinds) {
        const details = nodeKindDetails[kind];
        const Icon = details.icon;
        entries.push({
          id: `add-${kind}`,
          label: `Add ${details.label}`,
          icon: <Icon size={15} />,
          disabled: structuralLocked,
          onSelect: () => onAddNode(kind, menu.flowPosition),
        });
      }
    }
    return { ariaLabel: 'Canvas actions', entries };
  }, [edges, menu, nodes, onAddNode, onDeleteItem, onOpenNodeConfig, onOpenNodeConsole, onSelect, onToggleLink, onToggleNode, operationsLocked, selectLinkThen, selectNodeThen, structuralLocked]);

  const acceptsAppliance = (event: DragEvent<HTMLDivElement>) => {
    const types = Array.from(event.dataTransfer.types);
    return Boolean(onAddNode) && !structuralLocked
      && (types.includes(APPLIANCE_DRAG_TYPE) || types.includes('text/plain'));
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!acceptsAppliance(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setMenu(null);
    setIsDropTarget(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setIsDropTarget(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!acceptsAppliance(event)) return;
    event.preventDefault();
    setIsDropTarget(false);
    if (structuralLocked || !onAddNode) return;
    const rawKind = event.dataTransfer.getData(APPLIANCE_DRAG_TYPE)
      || event.dataTransfer.getData('text/plain');
    const kind = rawKind.trim();
    if (!isNodeKind(kind)) return;
    const position = flowRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (position) onAddNode(kind, position);
  };

  return (
    <div
      className={`topology-canvas${isDropTarget ? ' topology-canvas--drag-over' : ''}`}
      data-testid="topology-canvas"
      data-guide-target="topology"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <ReactFlow
        nodes={selectedNodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        onInit={(instance) => { flowRef.current = instance; }}
        nodesDraggable={!structuralLocked}
        nodesConnectable={!structuralLocked}
        onNodeClick={(_, node) => { setMenu(null); onSelect({ kind: 'node', id: node.id }); }}
        onNodeDoubleClick={(_, node) => {
          setMenu(null);
          onSelect({ kind: 'node', id: node.id });
          if (node.data.kind !== 'switch') onOpenNodeConsole?.(node.id);
        }}
        onEdgeClick={(_, edge) => { setMenu(null); onSelect({ kind: 'link', id: edge.id }); }}
        onPaneClick={() => { setMenu(null); onSelect(null); }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault();
          event.stopPropagation();
          if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true });
          const position = eventPosition(event);
          onSelect({ kind: 'node', id: node.id });
          openMenu({ kind: 'node', id: node.id, position });
        }}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault();
          event.stopPropagation();
          const position = eventPosition(event);
          onSelect({ kind: 'link', id: edge.id });
          openMenu({ kind: 'edge', id: edge.id, position });
        }}
        onPaneContextMenu={(event) => {
          event.preventDefault();
          const position = eventPosition(event);
          const flowPosition = flowRef.current?.screenToFlowPosition(position) ?? position;
          onSelect(null);
          openMenu({ kind: 'pane', position, flowPosition });
        }}
        onMoveStart={() => setMenu(null)}
        connectionLineType={ConnectionLineType.SmoothStep}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1.15 }}
        minZoom={0.25}
        maxZoom={2}
        deleteKeyCode={null}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeColor={(node) => node.data?.kind === 'client' ? '#f2c879' : '#79baa0'}
          maskColor="rgba(10, 12, 16, 0.7)"
        />
      </ReactFlow>
      {menu && activeMenu && (
        <ContextMenu
          key={menu.instance}
          ariaLabel={activeMenu.ariaLabel}
          entries={activeMenu.entries}
          position={menu.position}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
