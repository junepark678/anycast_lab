import {
  Activity,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Download,
  Eraser,
  Maximize2,
  Route,
  TerminalSquare,
} from 'lucide-react';
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { TerminalLine, TimelineEventView, TraceHopView } from '../view-types';

type ActivityTab = 'trace' | 'events';
type CompactPane = 'console' | 'activity';

interface Props {
  terminalTitle: string;
  terminalLines: TerminalLine[];
  consoleTargets: Array<{ id: string; label: string }>;
  activeConsoleId: string;
  onConsoleChange: (nodeId: string) => void;
  trace: TraceHopView[];
  events: TimelineEventView[];
  onCommand: (command: string) => void;
  onClearTerminal: () => void;
  onTrace: (source: string, destination: string) => void;
  runtimeMode: 'simulation' | 'native';
  onExportCapture?: () => void;
  clients: Array<{ id: string; label: string }>;
  focusRequest?: number;
  guideFocusTarget?: string | null;
}

const DEFAULT_DOCK_HEIGHT = 272;
const COLLAPSED_DOCK_HEIGHT = 39;
const MIN_DOCK_HEIGHT = 176;

function maximumDockHeight(): number {
  return Math.max(MIN_DOCK_HEIGHT, Math.min(560, window.innerHeight * 0.68));
}

export function BottomPanel({
  terminalTitle,
  terminalLines,
  consoleTargets,
  activeConsoleId,
  onConsoleChange,
  trace,
  events,
  onCommand,
  onClearTerminal,
  onTrace,
  runtimeMode,
  onExportCapture,
  clients,
  focusRequest = 0,
  guideFocusTarget = null,
}: Props) {
  const [tab, setTab] = useState<ActivityTab>('trace');
  const [compactPane, setCompactPane] = useState<CompactPane>('console');
  const [command, setCommand] = useState('');
  const [source, setSource] = useState(clients[0]?.id ?? '');
  const [destination, setDestination] = useState('203.0.113.53');
  const [dockHeight, setDockHeight] = useState(DEFAULT_DOCK_HEIGHT);
  const [collapsed, setCollapsed] = useState(false);
  const [copyLabel, setCopyLabel] = useState('Copy output');
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight });
  }, [terminalLines]);

  useEffect(() => {
    if (!clients.some((client) => client.id === source)) setSource(clients[0]?.id ?? '');
  }, [clients, source]);

  useEffect(() => {
    if (focusRequest === 0) return;
    setCollapsed(false);
    setCompactPane('console');
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [focusRequest]);

  useEffect(() => {
    if (guideFocusTarget === 'console') {
      setCollapsed(false);
      setCompactPane('console');
    }
    if (guideFocusTarget === 'trace') {
      setCollapsed(false);
      setCompactPane('activity');
      setTab('trace');
    }
  }, [guideFocusTarget]);

  useEffect(() => {
    const toggleDock = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === '`') {
        event.preventDefault();
        setCollapsed((current) => !current);
      }
    };
    window.addEventListener('keydown', toggleDock);
    return () => window.removeEventListener('keydown', toggleDock);
  }, []);

  const submitCommand = (event: FormEvent) => {
    event.preventDefault();
    if (!command.trim()) return;
    onCommand(command.trim());
    setCommand('');
  };

  const resizeDock = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (collapsed) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = dockHeight;
    const move = (moveEvent: PointerEvent) => {
      const nextHeight = startHeight + startY - moveEvent.clientY;
      setDockHeight(Math.max(MIN_DOCK_HEIGHT, Math.min(maximumDockHeight(), nextHeight)));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? 20 : -20;
    setDockHeight((current) => Math.max(MIN_DOCK_HEIGHT, Math.min(maximumDockHeight(), current + delta)));
  };

  const copyTerminal = async () => {
    const text = terminalLines.map((line) => line.text).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopyLabel('Copied');
    } catch {
      setCopyLabel('Copy unavailable');
    }
    window.setTimeout(() => setCopyLabel('Copy output'), 1500);
  };

  const toggleMaximumHeight = () => {
    const maximum = maximumDockHeight();
    setDockHeight((current) => current >= maximum - 8 ? DEFAULT_DOCK_HEIGHT : maximum);
  };

  return (
    <section
      className={`bottom-panel${collapsed ? ' is-collapsed' : ''}`}
      style={{ height: collapsed ? COLLAPSED_DOCK_HEIGHT : dockHeight }}
      aria-label="Console and activity dock"
    >
      <div
        className="dock-resize-handle"
        role="separator"
        aria-label="Resize console and activity dock"
        aria-orientation="horizontal"
        aria-valuemin={MIN_DOCK_HEIGHT}
        aria-valuemax={Math.round(typeof window === 'undefined' ? 560 : maximumDockHeight())}
        aria-valuenow={Math.round(dockHeight)}
        tabIndex={collapsed ? -1 : 0}
        onPointerDown={resizeDock}
        onKeyDown={resizeWithKeyboard}
        onDoubleClick={() => setDockHeight(DEFAULT_DOCK_HEIGHT)}
      />

      {collapsed ? (
        <div className="dock-collapsed-bar">
          <span><TerminalSquare size={15} /> Console</span>
          <small>{terminalTitle}</small>
          <span className="dock-collapsed-counts">{trace.length} hops · {events.length} events</span>
          <button type="button" className="dock-icon-button" onClick={() => setCollapsed(false)} aria-label="Expand console dock" title="Expand dock (Ctrl+`)"><ChevronUp size={15} /></button>
        </div>
      ) : (
        <>
        <nav className="dock-compact-tabs" aria-label="Compact dock views">
          <button type="button" className={compactPane === 'console' ? 'is-active' : ''} aria-pressed={compactPane === 'console'} onClick={() => setCompactPane('console')}><TerminalSquare size={14} /> Console</button>
          <button type="button" className={compactPane === 'activity' ? 'is-active' : ''} aria-pressed={compactPane === 'activity'} onClick={() => setCompactPane('activity')}><Activity size={14} /> Activity</button>
        </nav>
        <div className="dock-grid" data-compact-pane={compactPane}>
          <section className="console-panel" aria-label="Console" data-guide-target="console">
            <header className="dock-header">
              <span className="dock-header__title">
                <TerminalSquare size={15} />
                <label>
                  <span className="visually-hidden">Console appliance</span>
                  <select aria-label="Console appliance" value={activeConsoleId} onChange={(event) => onConsoleChange(event.target.value)} disabled={consoleTargets.length === 0}>
                    {consoleTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
                  </select>
                </label>
                <i>{runtimeMode === 'native' ? 'VM' : 'SIM'}</i>
              </span>
              <span className="dock-header__actions">
                <button type="button" className="dock-icon-button" onClick={() => void copyTerminal()} aria-label="Copy console output" title={copyLabel}><Clipboard size={14} /></button>
                <button type="button" className="dock-icon-button" onClick={onClearTerminal} aria-label="Clear console" title="Clear console"><Eraser size={14} /></button>
                <button type="button" className="dock-icon-button" onClick={toggleMaximumHeight} aria-label="Toggle maximum dock height" title="Toggle maximum height"><Maximize2 size={14} /></button>
                <button type="button" className="dock-icon-button" onClick={() => setCollapsed(true)} aria-label="Collapse console dock" title="Collapse dock (Ctrl+`)"><ChevronDown size={15} /></button>
              </span>
            </header>
            <div className="terminal-view">
              <div className="terminal-title">{terminalTitle}</div>
              <div className="terminal-output" ref={outputRef} aria-live="polite">
                {terminalLines.length === 0
                  ? <div className="terminal-empty">Console cleared. Run the lab or enter a command.</div>
                  : terminalLines.map((line) => <pre key={line.id} className={`terminal-line terminal-line--${line.stream}`}>{line.text}</pre>)}
              </div>
              <form className="terminal-input" onSubmit={submitCommand}>
                <span aria-hidden="true">$</span>
                <input
                  ref={inputRef}
                  aria-label="Terminal command"
                  value={command}
                  onChange={(event) => setCommand(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!activeConsoleId}
                  placeholder={!activeConsoleId ? 'Select an appliance to open a console.' : runtimeMode === 'native' ? 'birdc show protocols, vtysh -c "show bgp summary", ping …' : 'show protocols, show bgp summary, ping …'}
                />
              </form>
            </div>
          </section>

          <section className="activity-panel" aria-label="Network activity" data-guide-target="trace">
            <nav className="bottom-tabs" aria-label="Network activity views">
              <button type="button" className={tab === 'trace' ? 'is-active' : ''} onClick={() => setTab('trace')}><Route size={15} /> Packet trace {trace.length > 0 && <b>{trace.length}</b>}</button>
              <button type="button" className={tab === 'events' ? 'is-active' : ''} onClick={() => setTab('events')}><Activity size={15} /> Events {events.length > 0 && <b>{events.length}</b>}</button>
            </nav>
            {tab === 'trace' && (
              <div className="trace-view">
                <form className="trace-form" onSubmit={(event) => { event.preventDefault(); onTrace(source, destination); }}>
                  <label>From<select value={source} onChange={(event) => setSource(event.target.value)}>{clients.map((client) => <option key={client.id} value={client.id}>{client.label}</option>)}</select></label>
                  <span aria-hidden="true">→</span>
                  <label>Destination<input value={destination} onChange={(event) => setDestination(event.target.value)} /></label>
                  <button className="button button--run" type="submit" disabled={!source}>{runtimeMode === 'native' ? 'Run traceroute' : 'Trace packet'}</button>
                </form>
                <div className="trace-hops">
                  {trace.length === 0 ? <div className="empty-inline">{runtimeMode === 'native' ? 'Run traceroute inside a client namespace. Output stays visible in the separate console; Ethernet frames remain available as PCAPNG.' : 'Run a trace to see each forwarding decision.'}</div> : trace.map((hop) => (
                    <article key={`${hop.index}-${hop.nodeId}`} className={`trace-hop trace-hop--${hop.outcome}`}>
                      <span className="trace-hop__index">{hop.index}</span>
                      <div><strong>{hop.nodeLabel}</strong><p>{hop.explanation}</p><small>{hop.ingress ?? 'local'} → {hop.egress ?? hop.outcome}{hop.matchedPrefix && <> · <code>{hop.matchedPrefix}</code></>}</small></div>
                      <output>+{hop.latencyMs.toFixed(1)} ms<strong>{hop.cumulativeMs.toFixed(1)} ms</strong></output>
                    </article>
                  ))}
                </div>
              </div>
            )}
            {tab === 'events' && (
              <div className="event-view">
                {runtimeMode === 'native' && onExportCapture && <div className="capture-toolbar"><span>Native fabric events and packet drops</span><button type="button" className="button button--secondary" onClick={onExportCapture}><Download size={13} /> Export PCAPNG</button></div>}
                {events.length === 0 ? <div className="empty-inline">Protocol and topology events will appear here.</div> : events.map((event) => (
                  <article className={`timeline-event timeline-event--${event.category}`} key={event.id}><time>{(event.timeMs / 1000).toFixed(3)}s</time><span>{event.category}</span><div><strong>{event.summary}</strong>{event.detail && <p>{event.detail}</p>}</div></article>
                ))}
              </div>
            )}
          </section>
        </div>
        </>
      )}
    </section>
  );
}
