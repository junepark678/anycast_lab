import { Activity, Download, Route, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { TerminalLine, TimelineEventView, TraceHopView } from '../view-types';

type Tab = 'terminal' | 'trace' | 'events';

interface Props {
  terminalTitle: string;
  terminalLines: TerminalLine[];
  trace: TraceHopView[];
  events: TimelineEventView[];
  onCommand: (command: string) => void;
  onTrace: (source: string, destination: string) => void;
  runtimeMode: 'simulation' | 'native';
  onExportCapture?: () => void;
  clients: Array<{ id: string; label: string }>;
}

export function BottomPanel({ terminalTitle, terminalLines, trace, events, onCommand, onTrace, runtimeMode, onExportCapture, clients }: Props) {
  const [tab, setTab] = useState<Tab>('terminal');
  const [command, setCommand] = useState('');
  const [source, setSource] = useState(clients[0]?.id ?? '');
  const [destination, setDestination] = useState('203.0.113.53');
  const outputRef = useRef<HTMLDivElement>(null);
  useEffect(() => { outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight }); }, [terminalLines]);
  useEffect(() => {
    if (!clients.some((client) => client.id === source)) setSource(clients[0]?.id ?? '');
  }, [clients, source]);

  const submitCommand = (event: FormEvent) => {
    event.preventDefault();
    if (!command.trim()) return;
    onCommand(command.trim());
    setCommand('');
  };

  return (
    <section className="bottom-panel">
      <nav className="bottom-tabs">
        <button type="button" className={tab === 'terminal' ? 'is-active' : ''} onClick={() => setTab('terminal')}><TerminalSquare size={15} /> Terminal</button>
        <button type="button" className={tab === 'trace' ? 'is-active' : ''} onClick={() => setTab('trace')}><Route size={15} /> Packet trace {trace.length > 0 && <b>{trace.length}</b>}</button>
        <button type="button" className={tab === 'events' ? 'is-active' : ''} onClick={() => setTab('events')}><Activity size={15} /> Events {events.length > 0 && <b>{events.length}</b>}</button>
      </nav>
      {tab === 'terminal' && (
        <div className="terminal-view">
          <div className="terminal-title">{terminalTitle}</div>
          <div className="terminal-output" ref={outputRef}>
            {terminalLines.map((line) => <pre key={line.id} className={`terminal-line terminal-line--${line.stream}`}>{line.text}</pre>)}
          </div>
          <form className="terminal-input" onSubmit={submitCommand}><span>$</span><input aria-label="Terminal command" value={command} onChange={(event) => setCommand(event.target.value)} autoComplete="off" spellCheck={false} placeholder={runtimeMode === 'native' ? 'birdc show protocols, vtysh -c "show bgp summary", ping …' : 'show protocols, show bgp summary, ping …'} /></form>
        </div>
      )}
      {tab === 'trace' && (
        <div className="trace-view">
          <form className="trace-form" onSubmit={(event) => { event.preventDefault(); onTrace(source, destination); if (runtimeMode === 'native') setTab('terminal'); }}>
            <label>From<select value={source} onChange={(event) => setSource(event.target.value)}>{clients.map((client) => <option key={client.id} value={client.id}>{client.label}</option>)}</select></label>
            <span>→</span>
            <label>Destination<input value={destination} onChange={(event) => setDestination(event.target.value)} /></label>
            <button className="button button--run" type="submit" disabled={!source}>{runtimeMode === 'native' ? 'Run native traceroute' : 'Trace packet'}</button>
          </form>
          <div className="trace-hops">
            {trace.length === 0 ? <div className="empty-inline">{runtimeMode === 'native' ? 'Runs traceroute inside the selected Linux client VM. Output opens in Terminal; byte-exact Ethernet frames remain available as PCAPNG.' : 'Run a trace to see each forwarding decision.'}</div> : trace.map((hop) => (
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
  );
}
