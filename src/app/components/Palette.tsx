import { GitFork, Monitor, Network, Router, Server } from 'lucide-react';
import type { DragEvent } from 'react';
import type { NodeKind } from '../view-types';

export const APPLIANCE_DRAG_MIME = 'application/x-anycast-appliance';

interface Props {
  onAdd: (kind: NodeKind) => void;
  disabled?: boolean;
}

const items: Array<{ kind: NodeKind; label: string; note: string; icon: typeof Router }> = [
  { kind: 'bird', label: 'BIRD', note: 'Router appliance', icon: Router },
  { kind: 'frr', label: 'FRRouting', note: 'Router appliance', icon: Router },
  { kind: 'route-server', label: 'Route server', note: 'IX control plane', icon: Network },
  { kind: 'client', label: 'Client', note: 'Ping and trace', icon: Monitor },
  { kind: 'service', label: 'Service', note: 'Anycast endpoint', icon: Server },
  { kind: 'switch', label: 'Switch', note: 'Shared L2 segment', icon: GitFork },
];

export function Palette({ onAdd, disabled = false }: Props) {
  const beginDrag = (event: DragEvent<HTMLButtonElement>, kind: NodeKind) => {
    if (disabled) {
      event.preventDefault();
      return;
    }
    event.dataTransfer.effectAllowed = 'copy';
    event.dataTransfer.setData(APPLIANCE_DRAG_MIME, kind);
    event.dataTransfer.setData('text/plain', kind);
    event.currentTarget.classList.add('is-dragging');
  };

  return (
    <aside className="palette" aria-label="Appliances">
      <div className="panel-heading">
        <span>Appliances</span>
        <small>Drag to canvas</small>
      </div>
      <div className="palette__items">
        {items.map(({ kind, label, note, icon: Icon }) => (
          <button
            key={kind}
            type="button"
            className="palette-item"
            disabled={disabled}
            draggable={!disabled}
            onDragStart={(event) => beginDrag(event, kind)}
            onDragEnd={(event) => event.currentTarget.classList.remove('is-dragging')}
            onClick={() => onAdd(kind)}
            title={`Drag ${label} onto the topology or click to add`}
          >
            <Icon size={18} strokeWidth={1.8} />
            <span><strong>{label}</strong><small>{note}</small></span>
          </button>
        ))}
      </div>
      <div className="palette__help">
        {disabled ? 'Reset the native runtime before changing topology.' : 'Drag an appliance into the workspace, then connect nodes by dragging between their ports. Right-click for quick actions.'}
      </div>
      <div className="palette__license">
        <a href="https://github.com/junepark678/anycast_lab" target="_blank" rel="noreferrer">Source · AGPL-3.0</a>
        <span>Provided without warranty.</span>
      </div>
    </aside>
  );
}
