import { AlertTriangle, Plus, Power, Trash2, X } from 'lucide-react';
import type { LabInterface } from '../../core';
import type { LabCanvasEdge, LabCanvasNode } from '../view-types';

interface NodeInspectorProps {
  node: LabCanvasNode;
  interfaces: LabInterface[];
  defaultGateway?: string;
  serviceAddresses?: string[];
  enabled: boolean;
  onPatch: (patch: Partial<LabCanvasNode['data']>) => void;
  onInterfacesChange: (interfaces: LabInterface[]) => void;
  onDefaultGatewayChange: (gateway: string) => void;
  onServiceAddressesChange: (addresses: string[]) => void;
  onDelete: () => void;
  onOpenConfig: () => void;
  onToggleState: () => void;
  locked?: boolean;
  operationalDisabled?: boolean;
}

interface LinkInspectorProps {
  edge: LabCanvasEdge;
  onPatch: (patch: Partial<NonNullable<LabCanvasEdge['data']>>) => void;
  onDelete: () => void;
  locked?: boolean;
  operationalDisabled?: boolean;
}

export function EmptyInspector() {
  return (
    <aside className="inspector inspector--empty">
      <div>
        <span className="empty-glyph">⌁</span>
        <strong>Nothing selected</strong>
        <p>Select an appliance or link to inspect and configure it.</p>
      </div>
    </aside>
  );
}

export function NodeInspector({ node, interfaces, defaultGateway, serviceAddresses, enabled, onPatch, onInterfacesChange, onDefaultGatewayChange, onServiceAddressesChange, onDelete, onOpenConfig, onToggleState, locked = false, operationalDisabled = false }: NodeInspectorProps) {
  const patchInterface = (id: string, patch: Partial<LabInterface>) => {
    onInterfacesChange(interfaces.map((networkInterface) => networkInterface.id === id ? { ...networkInterface, ...patch } : networkInterface));
  };
  const addInterface = () => {
    const index = interfaces.length;
    onInterfacesChange([...interfaces, { id: `${node.id}-eth${index}-${Date.now().toString(36)}`, name: `eth${index}`, addresses: [], state: 'up', mtu: 1500 }]);
  };
  return (
    <aside className="inspector">
      <div className="panel-heading"><span>Appliance</span><small>{node.data.kind}</small></div>
      <div className="inspector__content">
        <label className="field"><span>Name</span><input disabled={locked} value={node.data.label} onChange={(event) => onPatch({ label: event.target.value })} /></label>
        <label className="field"><span>Location</span><input disabled={locked} value={node.data.location ?? ''} placeholder="e.g. Seoul" onChange={(event) => onPatch({ location: event.target.value })} /></label>
        {(node.data.kind === 'bird' || node.data.kind === 'frr' || node.data.kind === 'route-server') && (
          <label className="field"><span>Local ASN</span><input disabled={locked} type="number" value={node.data.asn ?? ''} placeholder="65001" onChange={(event) => onPatch({ asn: event.target.value ? Number(event.target.value) : undefined })} /></label>
        )}
        <div className="field">
          <span>Runtime</span>
          <div className="runtime-card">
            <strong>{node.data.runtimeLabel}</strong>
            <span className={`runtime-badge runtime-badge--${node.data.runtime}`}>
              {node.data.runtime === 'native-wasm' ? 'Native daemon · isolated namespace' : node.data.runtime === 'compatibility' ? 'Compatibility engine' : 'Built in'}
            </span>
          </div>
        </div>
        <div className="field"><span>Interfaces <button type="button" className="mini-action" disabled={locked} onClick={addInterface}><Plus size={11} /> Add</button></span>
          <div className="interface-list">
            {interfaces.map((networkInterface) => (
              <div className="interface-card" key={networkInterface.id}>
                <div className="interface-card__header">
                  <input aria-label="Interface name" disabled={locked} value={networkInterface.name} onChange={(event) => patchInterface(networkInterface.id, { name: event.target.value })} />
                  <label title="Interface state"><input type="checkbox" disabled={locked} checked={networkInterface.state === 'up'} onChange={(event) => patchInterface(networkInterface.id, { state: event.target.checked ? 'up' : 'down' })} /> up</label>
                  <button type="button" disabled={locked} title="Remove interface" onClick={() => onInterfacesChange(interfaces.filter((candidate) => candidate.id !== networkInterface.id))}><X size={12} /></button>
                </div>
                <input aria-label={`${networkInterface.name} addresses`} disabled={locked} placeholder="192.0.2.1/31, 2001:db8::1/64" value={networkInterface.addresses.join(', ')} onChange={(event) => patchInterface(networkInterface.id, { addresses: event.target.value.split(/[ ,\n]+/).map((value) => value.trim()).filter(Boolean) })} />
                <input aria-label={`${networkInterface.name} gateway`} disabled={locked} placeholder="Optional gateway, e.g. 192.0.2.1" value={networkInterface.gateway ?? ''} onChange={(event) => patchInterface(networkInterface.id, { gateway: event.target.value.trim() || undefined })} />
              </div>
            ))}
          </div>
        </div>
        {node.data.kind === 'client' && <label className="field"><span>Default gateway</span><input disabled={locked} value={defaultGateway ?? ''} placeholder="10.0.0.1" onChange={(event) => onDefaultGatewayChange(event.target.value)} /></label>}
        {node.data.kind === 'service' && <label className="field"><span>Service / anycast addresses</span><input disabled={locked} value={(serviceAddresses ?? []).join(', ')} placeholder="203.0.113.53/32" onChange={(event) => onServiceAddressesChange(event.target.value.split(/[ ,\n]+/).map((value) => value.trim()).filter(Boolean))} /></label>}
        {(node.data.kind === 'bird' || node.data.kind === 'frr' || node.data.kind === 'route-server') && (
          <button type="button" className="button button--wide" onClick={onOpenConfig}>Open native configuration</button>
        )}
        {node.data.runtime === 'compatibility' && (
          <div className="notice notice--warning"><AlertTriangle size={15} /><span>This router uses the fast compatibility engine. Its files use native syntax, but a compiled daemon is not executing in this mode.</span></div>
        )}
        {locked && <div className="notice notice--warning"><AlertTriangle size={15} /><span>The shared native runtime owns this project state. Reset it before editing topology, interfaces, or files.</span></div>}
        {node.data.kind === 'service' && node.data.runtime === 'native-wasm' && <div className="notice"><AlertTriangle size={15} /><span>Native service nodes configure addresses and kernel ICMP. Start DNS, HTTP, TCP, or UDP servers yourself from the node terminal.</span></div>}
      </div>
      <div className="inspector__footer">
        <button type="button" className="button button--danger" disabled={locked} onClick={onDelete}><Trash2 size={15} /> Delete</button>
        <button type="button" className="button button--secondary" disabled={operationalDisabled} onClick={onToggleState}><Power size={15} /> {enabled ? 'Disable' : 'Enable'}</button>
      </div>
    </aside>
  );
}

export function LinkInspector({ edge, onPatch, onDelete, locked = false, operationalDisabled = false }: LinkInspectorProps) {
  const data = edge.data ?? { latencyMs: 10, jitterMs: 0, lossPercent: 0, bandwidthMbps: 1000, enabled: true };
  return (
    <aside className="inspector">
      <div className="panel-heading"><span>Link</span><small>{edge.source} ↔ {edge.target}</small></div>
      <div className="inspector__content">
        <label className="switch-row"><span><strong>Link state</strong><small>Take the connection up or down</small></span><input type="checkbox" disabled={operationalDisabled} checked={data.enabled} onChange={(event) => onPatch({ enabled: event.target.checked })} /></label>
        <label className="field"><span>Latency <output>{data.latencyMs} ms</output></span><input disabled={locked} type="range" min="0" max="500" step="1" value={data.latencyMs} onChange={(event) => onPatch({ latencyMs: Number(event.target.value) })} /></label>
        <label className="field"><span>Jitter <output>{data.jitterMs} ms</output></span><input disabled={locked} type="range" min="0" max="100" step="1" value={data.jitterMs} onChange={(event) => onPatch({ jitterMs: Number(event.target.value) })} /></label>
        <label className="field"><span>Packet loss <output>{data.lossPercent}%</output></span><input disabled={locked} type="range" min="0" max="100" step="0.1" value={data.lossPercent} onChange={(event) => onPatch({ lossPercent: Number(event.target.value) })} /></label>
        <label className="field"><span>Bandwidth</span><div className="input-with-unit"><input disabled={locked} type="number" min="0.1" value={data.bandwidthMbps} onChange={(event) => onPatch({ bandwidthMbps: Number(event.target.value) })} /><span>Mbps</span></div></label>
      </div>
      <div className="inspector__footer"><button type="button" className="button button--danger" disabled={locked} onClick={onDelete}><Trash2 size={15} /> Delete link</button></div>
    </aside>
  );
}
