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
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useMemo } from 'react';
import type { LabCanvasEdge, LabCanvasNode, Selection } from '../view-types';
import { ApplianceNode } from './ApplianceNode';

interface Props {
  nodes: LabCanvasNode[];
  edges: LabCanvasEdge[];
  selection: Selection;
  onNodesChange: (changes: NodeChange<LabCanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<LabCanvasEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  onSelect: (selection: Selection) => void;
  structuralLocked?: boolean;
}

export function TopologyCanvas({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onSelect,
  structuralLocked = false,
}: Props) {
  const nodeTypes = useMemo(() => ({ labNode: ApplianceNode }), []);
  const styledEdges = useMemo(
    () => edges.map((edge) => ({
      ...edge,
      animated: edge.data?.enabled === false ? false : edge.animated,
      className: edge.data?.enabled === false ? 'lab-edge lab-edge--down' : 'lab-edge',
      label: edge.data
        ? `${edge.data.latencyMs} ms${edge.data.lossPercent ? ` · ${edge.data.lossPercent}% loss` : ''}`
        : edge.label,
    })),
    [edges],
  );

  const connect = useCallback((connection: Connection) => {
    onConnect(connection);
  }, [onConnect]);

  return (
    <div className="topology-canvas" data-testid="topology-canvas">
      <ReactFlow
        nodes={nodes}
        edges={styledEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={connect}
        nodesDraggable={!structuralLocked}
        nodesConnectable={!structuralLocked}
        onNodeClick={(_, node) => onSelect({ kind: 'node', id: node.id })}
        onEdgeClick={(_, edge) => onSelect({ kind: 'link', id: edge.id })}
        onPaneClick={() => onSelect(null)}
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
    </div>
  );
}
