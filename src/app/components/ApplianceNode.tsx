import { Handle, Position, type NodeProps } from '@xyflow/react';
import {
  CircleDot,
  Cloud,
  GitFork,
  Monitor,
  Network,
  Router,
  Server,
} from 'lucide-react';
import type { LabCanvasNode, NodeKind } from '../view-types';

const icons: Record<NodeKind, typeof Router> = {
  bird: Router,
  frr: Router,
  client: Monitor,
  service: Server,
  switch: GitFork,
  'route-server': Network,
};

const kindNames: Record<NodeKind, string> = {
  bird: 'BIRD router',
  frr: 'FRR router',
  client: 'Client',
  service: 'Service',
  switch: 'Ethernet switch',
  'route-server': 'Route server',
};

export function ApplianceNode({ data, selected }: NodeProps<LabCanvasNode>) {
  const Icon = icons[data.kind] ?? Cloud;
  const handles = data.kind === 'switch' ? ['top', 'right', 'bottom', 'left'] : ['left', 'right'];

  return (
    <div className={`appliance-node appliance-node--${data.kind}${selected ? ' is-selected' : ''}`}>
      {handles.includes('top') && <Handle type="source" position={Position.Top} id="top" />}
      {handles.includes('left') && <Handle type="target" position={Position.Left} id="left" />}
      <div className="appliance-node__icon"><Icon size={20} strokeWidth={1.8} /></div>
      <div className="appliance-node__body">
        <strong>{data.label}</strong>
        <span>{data.location || kindNames[data.kind]}</span>
      </div>
      <span className={`status-dot status-dot--${data.status}`} title={data.status}>
        <CircleDot size={12} />
      </span>
      <span className={`runtime-chip runtime-chip--${data.runtime}`} title={`Runtime: ${data.runtimeLabel}`}>
        {data.runtime === 'native-wasm' ? 'VM' : data.runtime === 'compatibility' ? 'SIM' : 'HOST'}
      </span>
      {handles.includes('right') && <Handle type="source" position={Position.Right} id="right" />}
      {handles.includes('bottom') && <Handle type="target" position={Position.Bottom} id="bottom" />}
    </div>
  );
}
