import { useEdgesState, useNodesState, type Connection } from '@xyflow/react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ApplianceRuntimeRegistry } from './appliances';
import { createV86RuntimeFactories, loadVerifiedV86Artifacts } from './appliances/v86';
import { LabEngine, parseNativeConfig, validateProject } from './core';
import type { EngineSnapshot, LabProject, PacketTrace } from './core';
import { NativeLabEngine, type NativeLabEvent, type NativeTerminalSession } from './native';
import {
  AutosaveCoordinator,
  ANYCAST_LAB_ARCHIVE_MIME,
  createLabProjectRepository,
  exportProjectArchive,
  importProjectArchive,
  projectArchiveFilename,
  requestPersistentStorage,
  type ProjectRepository,
} from './persistence';
import { BottomPanel } from './app/components/BottomPanel';
import { EmptyInspector, LinkInspector, NodeInspector } from './app/components/Inspector';
import { LabHeader } from './app/components/LabHeader';
import { Palette } from './app/components/Palette';
import { TopologyCanvas } from './app/components/TopologyCanvas';
import {
  loadNativeRuntimeAvailability,
  nativeMemoryEstimate,
  type NativeRuntimeAvailability,
} from './app/native-runtime';
import { replacePersistedProject, resumeProjectAutosave } from './app/project-replacement';
import { projectCanvas, useLabStore } from './app/store';
import { consumeTerminalChunk } from './app/terminal-stream';
import type { ConfigFileView, LabLinkViewData, LabNodeViewData, TimelineEventView, TraceHopView } from './app/view-types';
import './styles.css';

const LAST_PROJECT_KEY = 'anycast-lab:last-project';
const ConfigWorkspace = lazy(() => import('./app/components/ConfigWorkspace').then((module) => ({ default: module.ConfigWorkspace })));

function saveBlob(bytes: Uint8Array, filename: string, mediaType = ANYCAST_LAB_ARCHIVE_MIME): void {
  const part = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([part], { type: mediaType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function nativeEventView(event: NativeLabEvent): TimelineEventView {
  return {
    id: `native-${event.sequence}`,
    timeMs: Number(event.atNs) / 1_000_000,
    category: event.type.startsWith('link.') || event.type.startsWith('interface.') || event.type.startsWith('node.')
      ? 'link'
      : event.type.startsWith('frame.') ? 'packet'
        : event.type.startsWith('runtime.') ? 'protocol' : 'system',
    nodeId: event.nodeId,
    summary: event.message,
    detail: event.detail
      ? Object.entries(event.detail).map(([key, value]) => `${key}=${String(value)}`).join(' · ')
      : undefined,
  };
}

function safeFilename(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'anycast-lab';
}

function eventViews(snapshot: EngineSnapshot | null): TimelineEventView[] {
  if (!snapshot) return [];
  return snapshot.events.slice().reverse().map((event) => ({
    id: String(event.id),
    timeMs: event.atMs,
    category: event.type.startsWith('link.') ? 'link'
      : event.type.startsWith('session.') ? 'protocol'
        : event.type.startsWith('route.') ? 'route'
          : event.type.startsWith('packet.') ? 'packet' : 'system',
    nodeId: event.nodeId,
    summary: event.message,
    detail: event.data ? Object.entries(event.data).map(([key, value]) => `${key}=${String(value)}`).join(' · ') : undefined,
  }));
}

function traceViews(trace: PacketTrace | null): TraceHopView[] {
  if (!trace) return [];
  return trace.hops.map((hop) => ({
    index: hop.index,
    nodeId: hop.nodeId,
    nodeLabel: hop.nodeName,
    ingress: hop.ingressInterfaceId,
    egress: hop.egressInterfaceId,
    matchedPrefix: hop.matchedRoute?.prefix,
    nextHop: hop.nextHop,
    latencyMs: hop.latencyMs,
    cumulativeMs: hop.cumulativeLatencyMs,
    outcome: hop.action === 'delivered' ? 'delivered' : hop.action === 'dropped' ? trace.outcome === 'loop' ? 'loop' : 'dropped' : 'forwarded',
    explanation: hop.explanation,
  }));
}

function appendRuntimeMessage(stream: 'system' | 'error', message: string): void {
  const state = useLabStore.getState();
  for (const node of state.project.nodes) {
    if (node.kind !== 'switch') state.appendTerminal(node.id, stream, message);
  }
}

export default function App() {
  const store = useLabStore();
  const canvas = useMemo(() => projectCanvas(store.project, store.snapshot, store.running), [store.project, store.running, store.snapshot]);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState(canvas.nodes);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState(canvas.edges);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const repositoryRef = useRef<ProjectRepository<LabProject> | null>(null);
  const autosaveRef = useRef<AutosaveCoordinator<LabProject> | null>(null);
  const engineRef = useRef<LabEngine | null>(null);
  const nativeEngineRef = useRef<NativeLabEngine | null>(null);
  const nativeRegistryRef = useRef<{ key: string; registry: ApplianceRuntimeRegistry } | null>(null);
  const nativeTerminalSessionsRef = useRef(new Map<string, Promise<NativeTerminalSession>>());
  const nativeTerminalDecodersRef = useRef(new Map<string, TextDecoder>());
  const nativeTerminalLineBuffersRef = useRef(new Map<string, string>());
  const runtimeOperationRef = useRef(false);
  const projectReplacementRef = useRef(false);
  const bootedRef = useRef(false);
  const [nativeAvailability, setNativeAvailability] = useState<NativeRuntimeAvailability | null>(null);
  const [nativeEvents, setNativeEvents] = useState<TimelineEventView[]>([]);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [consoleFocusRequest, setConsoleFocusRequest] = useState(0);
  const [consoleNodeId, setConsoleNodeId] = useState(() => store.project.nodes.find((node) => node.kind !== 'switch')?.id ?? '');
  const [persistenceReady, setPersistenceReady] = useState(false);
  const [nativeProjectLocked, setNativeProjectLocked] = useState(false);
  const runtimeMode = useMemo<'simulation' | 'native'>(
    () => store.project.nodes.some((node) => node.kind !== 'switch' && node.appliance.runtime === 'wasm') ? 'native' : 'simulation',
    [store.project.nodes],
  );
  const nativeVmCount = useMemo(
    () => store.project.nodes.filter((node) => node.kind !== 'switch').length,
    [store.project.nodes],
  );

  const beginRuntimeOperation = useCallback((): boolean => {
    if (runtimeOperationRef.current) return false;
    runtimeOperationRef.current = true;
    setRuntimeBusy(true);
    return true;
  }, []);

  const finishRuntimeOperation = useCallback(() => {
    runtimeOperationRef.current = false;
    setRuntimeBusy(false);
  }, []);

  useEffect(() => { setNodes(canvas.nodes); setEdges(canvas.edges); }, [canvas, setEdges, setNodes]);

  useEffect(() => {
    const deploymentBase = new URL(import.meta.env.BASE_URL, window.location.href).href;
    void loadNativeRuntimeAvailability(deploymentBase).then(setNativeAvailability);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const repository = await createLabProjectRepository({ onFallback: () => setToast('IndexedDB unavailable; changes will last for this session.') });
      if (cancelled) { repository.close(); return; }
      repositoryRef.current = repository;
      autosaveRef.current = new AutosaveCoordinator({
        repository,
        delayMs: 500,
        onStateChange: (state) => {
          if (state.status === 'saving') store.markSaving();
          if (state.status === 'error') store.markSaveError();
        },
        onSaved: (saved) => useLabStore.getState().markSaved(saved.project),
      });
      const previousId = localStorage.getItem(LAST_PROJECT_KEY);
      const previous = previousId ? await repository.get(previousId) : undefined;
      const current = useLabStore.getState();
      if (previous && !current.dirty) current.setProject(previous.project);
      else if (!previous) await repository.save(current.project);
      const active = useLabStore.getState();
      localStorage.setItem(LAST_PROJECT_KEY, active.project.id);
      bootedRef.current = true;
      if (active.dirty) autosaveRef.current.schedule(active.project);
      // Keep persistence actions locked until the initial lookup/restore is
      // fully settled; otherwise a fast import can be replaced by stale
      // bootstrap data when the lookup resumes.
      setPersistenceReady(true);
      void requestPersistentStorage();
    })();
    return () => {
      cancelled = true;
      const autosave = autosaveRef.current;
      const repository = repositoryRef.current;
      if (autosave !== null) void autosave.dispose({ flush: true }).finally(() => repository?.close());
      else repository?.close();
      void engineRef.current?.dispose();
      void nativeEngineRef.current?.dispose();
    };
    // Store methods are stable; this intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const flushPendingSave = () => {
      if (useLabStore.getState().dirty) void autosaveRef.current?.flush();
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === 'hidden') flushPendingSave();
    };
    window.addEventListener('pagehide', flushPendingSave);
    document.addEventListener('visibilitychange', flushWhenHidden);
    return () => {
      window.removeEventListener('pagehide', flushPendingSave);
      document.removeEventListener('visibilitychange', flushWhenHidden);
    };
  }, []);

  useEffect(() => {
    if (!bootedRef.current || !store.dirty || projectReplacementRef.current) return;
    autosaveRef.current?.schedule(store.project);
    localStorage.setItem(LAST_PROJECT_KEY, store.project.id);
  }, [store.dirty, store.project]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const nativeRegistry = useCallback((): ApplianceRuntimeRegistry => {
    if (!nativeAvailability?.available) {
      throw new Error(nativeAvailability?.reason ?? 'Native VM availability is still being checked.');
    }
    const key = nativeAvailability.manifestSha256;
    if (nativeRegistryRef.current?.key === key) return nativeRegistryRef.current.registry;
    const registry = new ApplianceRuntimeRegistry();
    const artifactSource = {
      manifestUrl: nativeAvailability.manifestUrl,
      manifestSha256: nativeAvailability.manifestSha256,
    };
    let artifactPromise: ReturnType<typeof loadVerifiedV86Artifacts> | null = null;
    const factories = createV86RuntimeFactories({
      artifactSource,
      bootTimeoutMs: 120_000,
      loadArtifacts: () => {
        artifactPromise ??= loadVerifiedV86Artifacts(artifactSource);
        return artifactPromise;
      },
    });
    for (const factory of factories) registry.register(factory);
    nativeRegistryRef.current = { key, registry };
    return registry;
  }, [nativeAvailability]);

  const rebuildEngine = useCallback(async (project = store.project): Promise<LabEngine> => {
    await nativeEngineRef.current?.dispose();
    nativeEngineRef.current = null;
    setNativeProjectLocked(false);
    nativeTerminalSessionsRef.current.clear();
    nativeTerminalDecodersRef.current.clear();
    nativeTerminalLineBuffersRef.current.clear();
    await engineRef.current?.dispose();
    const engine = await LabEngine.create(structuredClone(project));
    engineRef.current = engine;
    return engine;
  }, [store.project]);

  const rebuildNativeEngine = useCallback(async (project = store.project): Promise<NativeLabEngine> => {
    await engineRef.current?.dispose();
    engineRef.current = null;
    await nativeEngineRef.current?.dispose();
    nativeTerminalSessionsRef.current.clear();
    nativeTerminalDecodersRef.current.clear();
    nativeTerminalLineBuffersRef.current.clear();
    setNativeEvents([]);
    setNativeProjectLocked(true);
    const engine = new NativeLabEngine(structuredClone(project), nativeRegistry(), {
      autoRun: true,
      onEvent: (event) => {
        if (event.type === 'engine.state' && event.detail?.state === 'failed') {
          const active = useLabStore.getState();
          active.setRunning(false);
          if (event.nodeId) active.appendTerminal(event.nodeId, 'error', event.message);
          else appendRuntimeMessage('error', event.message);
          setNativeProjectLocked(false);
          setToast('A native appliance failed. Inspect its serial output, fix the config, then reset and run again.');
        }
        if (event.type === 'frame.transmitted' || event.type === 'frame.delivered') return;
        if (event.runtimeEvent?.type === 'terminal-output') return;
        setNativeEvents((current) => [...current.slice(-299), nativeEventView(event)]);
      },
      onTerminalOutput: (output) => {
        let decoder = nativeTerminalDecodersRef.current.get(output.nodeId);
        if (decoder === undefined) {
          decoder = new TextDecoder();
          nativeTerminalDecodersRef.current.set(output.nodeId, decoder);
        }
        const consumed = consumeTerminalChunk(
          nativeTerminalLineBuffersRef.current.get(output.nodeId) ?? '',
          decoder.decode(output.data, { stream: true }),
        );
        nativeTerminalLineBuffersRef.current.set(output.nodeId, consumed.pending);
        if (consumed.complete.length > 0) {
          useLabStore.getState().appendTerminal(
            output.nodeId,
            'output',
            consumed.complete,
          );
        }
      },
    });
    nativeEngineRef.current = engine;
    return engine;
  }, [nativeRegistry, store.project]);

  const run = useCallback(async () => {
    if (!beginRuntimeOperation()) return;
    try {
      if (store.running) {
        if (runtimeMode === 'native') {
          await nativeEngineRef.current?.pause();
          appendRuntimeMessage('system', 'Native VMs paused. Their machine state is preserved in memory.');
        }
        store.setRunning(false);
        return;
      }

      if (runtimeMode === 'native') {
        if (!nativeAvailability?.available) {
          throw new Error(nativeAvailability?.reason ?? 'Native VM availability is still being checked.');
        }
        setNativeProjectLocked(true);
        store.setRunning(true);
        store.setSnapshot(null);
        store.setTrace(null);
        const estimate = nativeMemoryEstimate(nativeVmCount, nativeAvailability.memoryBytes);
        const existing = nativeEngineRef.current;
        if (existing?.state === 'paused') {
          appendRuntimeMessage('system', 'Resuming native Linux VMs…');
          await existing.resume();
        } else {
          appendRuntimeMessage('system', `Booting ${nativeVmCount} isolated Linux VMs (${estimate}) and executing each appliance project independently…`);
          const nativeEngine = await rebuildNativeEngine();
          await nativeEngine.start();
        }
        const descriptors = nativeEngineRef.current?.runtimeDescriptors() ?? {};
        appendRuntimeMessage('system', `Native fabric is running · ${Object.keys(descriptors).length} real appliances · raw Ethernet capture enabled.`);
        return;
      }

      store.setRunning(true);
      appendRuntimeMessage('system', 'Starting appliances and converging protocols…');
      const engine = await rebuildEngine();
      await engine.converge();
      const snapshot = engine.snapshot();
      store.setSnapshot(snapshot);
      appendRuntimeMessage('system', `Converged at ${(snapshot.nowMs / 1000).toFixed(3)}s · ${snapshot.sessions.filter((session) => session.state === 'established').length} sessions established.`);
    } catch (error) {
      store.setRunning(false);
      if (runtimeMode === 'native') setNativeProjectLocked(false);
      appendRuntimeMessage('error', error instanceof Error ? error.message : String(error));
      setToast('The topology could not start. Check the configuration diagnostics.');
    } finally {
      finishRuntimeOperation();
    }
  }, [beginRuntimeOperation, finishRuntimeOperation, nativeAvailability, nativeVmCount, rebuildEngine, rebuildNativeEngine, runtimeMode, store]);

  const selectedNode = store.selection?.kind === 'node' ? store.project.nodes.find((node) => node.id === store.selection?.id) : undefined;
  const selectedLink = store.selection?.kind === 'link' ? store.project.links.find((link) => link.id === store.selection?.id) : undefined;
  const selectedCanvasNode = selectedNode ? canvas.nodes.find((node) => node.id === selectedNode.id) : undefined;
  const selectedCanvasLink = selectedLink ? canvas.edges.find((edge) => edge.id === selectedLink.id) : undefined;
  const editorNode = store.editorNodeId ? store.project.nodes.find((node) => node.id === store.editorNodeId) : undefined;
  const consoleNodes = store.project.nodes.filter((node) => node.kind !== 'switch');
  const consoleNode = consoleNodes.find((node) => node.id === consoleNodeId) ?? consoleNodes[0];
  const configFiles: ConfigFileView[] = (editorNode?.files ?? []).map((file) => ({ path: file.path, contents: file.content, language: editorNode?.appliance.kind === 'bird' ? 'bird' : editorNode?.appliance.kind === 'frr' ? 'frr' : 'plaintext' }));

  useEffect(() => {
    if (consoleNode && consoleNode.id !== consoleNodeId) setConsoleNodeId(consoleNode.id);
  }, [consoleNode, consoleNodeId]);

  const onNodeChanges = useCallback((changes: Parameters<typeof onNodesChangeBase>[0]) => {
    onNodesChangeBase(changes);
    if (
      !nativeProjectLocked &&
      !runtimeOperationRef.current &&
      changes.some((change) => change.type === 'position' && !change.dragging)
    ) store.updateNodes(changes);
  }, [nativeProjectLocked, onNodesChangeBase, store]);

  const onEdgeChanges = useCallback((changes: Parameters<typeof onEdgesChangeBase>[0]) => {
    onEdgesChangeBase(changes);
    const persistentChanges = changes.filter((change) => change.type === 'remove');
    if (!nativeProjectLocked && !runtimeOperationRef.current && persistentChanges.length > 0) {
      store.updateEdges(persistentChanges);
    }
  }, [nativeProjectLocked, onEdgesChangeBase, store]);

  const onConnect = useCallback((connection: Connection) => {
    if (nativeProjectLocked || runtimeOperationRef.current) {
      setToast('Reset the native runtime before changing topology.');
      return;
    }
    store.connect(connection);
  }, [nativeProjectLocked, store]);

  const validateConfig = useCallback(() => {
    if (!editorNode) return;
    const parsed = parseNativeConfig(editorNode);
    store.setDiagnostics(parsed.diagnostics);
    setToast(parsed.diagnostics.some((item) => item.severity === 'error')
      ? 'Configuration has errors in the fast syntax preflight.'
      : runtimeMode === 'native' ? 'Preflight passed; the native daemon remains authoritative.' : 'Configuration parsed successfully.');
  }, [editorNode, runtimeMode, store]);

  const sendNativeCommand = useCallback(async (nodeId: string, command: string): Promise<void> => {
    const engine = nativeEngineRef.current;
    if (engine?.state !== 'running') throw new Error('Start the native VM lab before opening a serial shell.');
    let sessionPromise = nativeTerminalSessionsRef.current.get(nodeId);
    if (sessionPromise === undefined) {
      sessionPromise = engine.openTerminal(nodeId).catch((error) => {
        nativeTerminalSessionsRef.current.delete(nodeId);
        throw error;
      });
      nativeTerminalSessionsRef.current.set(nodeId, sessionPromise);
    }
    const session = await sessionPromise;
    await engine.writeTerminal(session.id, `${command}\n`);
  }, []);

  const runCommand = useCallback(async (command: string) => {
    const node = consoleNode;
    if (!node) return;
    store.appendTerminal(node.id, 'input', `${node.name}$ ${command}`);
    try {
      if (runtimeMode === 'native') {
        await sendNativeCommand(node.id, command);
        return;
      }
      const engine = engineRef.current ?? await rebuildEngine();
      if (!store.snapshot) { await engine.converge(); store.setSnapshot(engine.snapshot()); }
      const result = await engine.terminal(node.id, command);
      store.appendTerminal(node.id, result.exitCode === 0 ? 'output' : 'error', result.output || '(no output)');
    } catch (error) { store.appendTerminal(node.id, 'error', error instanceof Error ? error.message : String(error)); }
  }, [consoleNode, rebuildEngine, runtimeMode, sendNativeCommand, store]);

  const runTrace = useCallback(async (sourceNodeId: string, destination: string) => {
    try {
      if (runtimeMode === 'native') {
        if (!/^[a-zA-Z0-9_.:%-]+$/.test(destination)) throw new Error('Enter an IP address or hostname to trace.');
        const source = store.project.nodes.find((node) => node.id === sourceNodeId);
        store.appendTerminal(sourceNodeId, 'input', `${source?.name ?? sourceNodeId}$ traceroute -n -m 16 ${destination}`);
        await sendNativeCommand(sourceNodeId, `traceroute -n -m 16 ${destination}`);
        store.setTrace(null);
        setToast('Native traceroute started. Raw Ethernet frames are being captured for PCAPNG export.');
        return;
      }
      const engine = engineRef.current ?? await rebuildEngine();
      if (!store.snapshot) await engine.converge();
      const result = engine.trace({ sourceNodeId, destination, protocol: 'icmp' });
      store.setTrace(result); store.setSnapshot(engine.snapshot());
      setToast(result.outcome === 'delivered' ? `Delivered in ${result.totalLatencyMs.toFixed(1)} ms.` : `Trace ended: ${result.outcome}.`);
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  }, [rebuildEngine, runtimeMode, sendNativeCommand, store]);

  const patchSelectedNode = useCallback((patch: Partial<LabNodeViewData>) => {
    if (!selectedNode) return;
    store.patchNode(selectedNode.id, {
      name: patch.label ?? selectedNode.name,
      asn: patch.asn ?? selectedNode.asn,
      tags: patch.location !== undefined ? patch.location ? [patch.location, ...(selectedNode.tags?.slice(1) ?? [])] : selectedNode.tags?.slice(1) : selectedNode.tags,
    });
  }, [selectedNode, store]);

  const patchLink = useCallback((linkId: string, patch: Partial<LabLinkViewData>) => {
    if (runtimeOperationRef.current) return;
    const link = useLabStore.getState().project.links.find((candidate) => candidate.id === linkId);
    if (!link) return;
    store.patchLink(linkId, {
      state: patch.enabled === undefined ? link.state : patch.enabled ? 'up' : 'down',
      latencyMs: patch.latencyMs ?? link.latencyMs,
      jitterMs: patch.jitterMs ?? link.jitterMs,
      loss: patch.lossPercent === undefined ? link.loss : patch.lossPercent / 100,
      bandwidthMbps: patch.bandwidthMbps ?? link.bandwidthMbps,
    });
    if (
      nativeEngineRef.current &&
      ['running', 'paused', 'stopped'].includes(nativeEngineRef.current.state) &&
      patch.enabled !== undefined
    ) {
      void nativeEngineRef.current.setLinkState(linkId, patch.enabled ? 'up' : 'down')
        .catch((error: unknown) => appendRuntimeMessage('error', error instanceof Error ? error.message : String(error)));
    } else if (engineRef.current && patch.enabled !== undefined) {
      engineRef.current.setLinkState(linkId, patch.enabled ? 'up' : 'down');
      void engineRef.current.converge().then(() => store.setSnapshot(engineRef.current?.snapshot() ?? null));
    }
    if ((patch.latencyMs !== undefined || patch.jitterMs !== undefined || patch.lossPercent !== undefined || patch.bandwidthMbps !== undefined) && (engineRef.current || nativeEngineRef.current)) {
      setToast('Restart the runtime to apply changed link characteristics.');
    }
  }, [store]);

  const patchSelectedLink = useCallback((patch: Partial<LabLinkViewData>) => {
    if (selectedLink) patchLink(selectedLink.id, patch);
  }, [patchLink, selectedLink]);

  const toggleNodeState = useCallback((nodeId: string, enabled: boolean) => {
    if (runtimeOperationRef.current) return;
    const state = enabled ? 'up' : 'down';
    store.patchNode(nodeId, { state });
    if (nativeEngineRef.current && ['running', 'paused', 'stopped'].includes(nativeEngineRef.current.state)) {
      void nativeEngineRef.current.setNodeState(nodeId, state)
        .catch((error: unknown) => store.appendTerminal(nodeId, 'error', error instanceof Error ? error.message : String(error)));
    } else if (engineRef.current) {
      engineRef.current.setNodeState(nodeId, state);
      void engineRef.current.converge().then(() => store.setSnapshot(engineRef.current?.snapshot() ?? null));
    }
  }, [store]);

  const disposeRuntime = useCallback(async (): Promise<void> => {
    const compatibility = engineRef.current;
    const native = nativeEngineRef.current;
    engineRef.current = null;
    nativeEngineRef.current = null;
    nativeTerminalSessionsRef.current.clear();
    nativeTerminalDecodersRef.current.clear();
    nativeTerminalLineBuffersRef.current.clear();
    setNativeProjectLocked(false);
    await compatibility?.dispose();
    await native?.dispose();
  }, []);

  const resetRuntime = useCallback(async (): Promise<void> => {
    if (!beginRuntimeOperation()) return;
    try {
      await disposeRuntime();
      setNativeEvents([]);
      setNativeProjectLocked(false);
      store.resetRuntime();
    } catch (error) {
      appendRuntimeMessage('error', error instanceof Error ? error.message : String(error));
    } finally {
      finishRuntimeOperation();
    }
  }, [beginRuntimeOperation, disposeRuntime, finishRuntimeOperation, store]);

  const changeRuntimeMode = useCallback(async (mode: 'simulation' | 'native'): Promise<void> => {
    if (mode === runtimeMode) return;
    if (mode === 'native' && !nativeAvailability?.available) {
      setToast(nativeAvailability?.reason ?? 'Native VM availability is still being checked.');
      return;
    }
    if (!beginRuntimeOperation()) return;
    try {
      await disposeRuntime();
      setNativeEvents([]);
      setNativeProjectLocked(false);
      store.resetRuntime();
      store.setRuntimeMode(mode);
      appendRuntimeMessage('system', mode === 'native'
        ? 'Native VM mode selected. Run boots real BIRD, FRR, client, and service appliances; there is no compatibility fallback.'
        : 'Simulation mode selected. This deterministic compatibility engine is fast, but does not execute the upstream daemons.');
      if (mode === 'native' && nativeAvailability?.available) {
        setToast(`Native mode selected · ${nativeMemoryEstimate(nativeVmCount, nativeAvailability.memoryBytes)}. Run when ready.`);
      }
    } finally {
      finishRuntimeOperation();
    }
  }, [beginRuntimeOperation, disposeRuntime, finishRuntimeOperation, nativeAvailability, nativeVmCount, runtimeMode, store]);

  const exportCapture = useCallback(() => {
    const engine = nativeEngineRef.current;
    if (engine === null) {
      setToast('Start the native VM lab before exporting a packet capture.');
      return;
    }
    const bytes = engine.exportPcapng();
    saveBlob(bytes, `${safeFilename(store.project.name)}.pcapng`, 'application/x-pcapng');
    setToast(`Exported ${engine.getCapture().frames.length} captured Ethernet observations.`);
  }, [store.project.name]);

  const exportProject = useCallback(() => {
    const bytes = exportProjectArchive(store.project);
    saveBlob(bytes, projectArchiveFilename(store.project.name));
    setToast('Portable project archive created.');
  }, [store.project]);

  const importProject = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!beginRuntimeOperation()) {
      setToast('Wait for the current runtime operation to finish before importing.');
      return;
    }
    projectReplacementRef.current = true;
    try {
      const imported = await importProjectArchive<LabProject>(file);
      const validation = validateProject(imported.project);
      if (!validation.success || !validation.value) throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
      const repository = repositoryRef.current;
      if (repository === null) throw new Error('Local project storage is still starting. Try the import again in a moment.');
      await replacePersistedProject({
        project: validation.value,
        disposeRuntime,
        autosave: autosaveRef.current,
        repository,
        install: store.setProject,
      });
      setNativeEvents([]);
      store.resetRuntime();
      localStorage.setItem(LAST_PROJECT_KEY, validation.value.id);
      setToast(`Imported ${validation.value.name}.`);
    } catch (error) { setToast(error instanceof Error ? error.message : 'Could not import project.'); }
    finally {
      projectReplacementRef.current = false;
      const active = useLabStore.getState();
      resumeProjectAutosave({
        project: active.project,
        dirty: active.dirty,
        booted: bootedRef.current,
        autosave: autosaveRef.current,
        rememberProjectId: (projectId) => localStorage.setItem(LAST_PROJECT_KEY, projectId),
      });
      finishRuntimeOperation();
    }
  }, [beginRuntimeOperation, disposeRuntime, finishRuntimeOperation, store]);

  const saveNow = useCallback(async () => {
    try { autosaveRef.current?.schedule(store.project); await autosaveRef.current?.flush(); setToast('Project saved locally.'); }
    catch { setToast('Local save failed. Export a copy before leaving.'); }
  }, [store.project]);

  const nativeRuntimeState = nativeAvailability === null ? 'loading' : nativeAvailability.available ? 'available' : 'unavailable';
  const nativeRuntimeDetail = nativeAvailability === null
    ? 'Checking for the verified native VM image…'
    : nativeAvailability.available
      ? `${nativeAvailability.buildId} · ${nativeMemoryEstimate(nativeVmCount, nativeAvailability.memoryBytes)}`
      : nativeAvailability.reason;
  const projectMutationLocked = nativeProjectLocked || runtimeBusy;

  const selectTopologyItem = useCallback((selection: Parameters<typeof store.setSelection>[0]) => {
    store.setSelection(selection);
    if (selection?.kind === 'node') {
      const node = useLabStore.getState().project.nodes.find((candidate) => candidate.id === selection.id);
      if (node?.kind !== 'switch') setConsoleNodeId(selection.id);
    }
  }, [store]);

  const addAppliance = useCallback((kind: Parameters<typeof store.addNode>[0], position?: { x: number; y: number }) => {
    store.addNode(kind, position);
    const added = useLabStore.getState().project.nodes.at(-1);
    if (added && added.kind !== 'switch') setConsoleNodeId(added.id);
  }, [store]);

  const openNodeConsole = useCallback((nodeId: string) => {
    const node = useLabStore.getState().project.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.kind === 'switch') return;
    store.setSelection({ kind: 'node', id: nodeId });
    setConsoleNodeId(nodeId);
    setConsoleFocusRequest((current) => current + 1);
  }, [store]);

  return (
    <div className={`lab-shell${editorNode ? ' is-editor-open' : ''}`}>
      <LabHeader
        projectName={store.project.name}
        running={store.running}
        runtimeBusy={runtimeBusy}
        projectMutationLocked={projectMutationLocked}
        persistenceReady={persistenceReady}
        dirty={store.dirty}
        saveState={store.saveState}
        runtimeMode={runtimeMode}
        nativeRuntimeState={nativeRuntimeState}
        nativeRuntimeDetail={nativeRuntimeDetail}
        fileInputRef={fileInputRef}
        onProjectNameChange={store.renameProject}
        onRuntimeModeChange={(mode) => void changeRuntimeMode(mode)}
        onRunToggle={() => void run()}
        onReset={() => void resetRuntime()}
        onSave={() => void saveNow()}
        onExport={exportProject}
        onImport={(event) => void importProject(event)}
      />
      <main className={`lab-main${editorNode ? ' has-editor' : ''}`}>
        <Palette onAdd={addAppliance} disabled={projectMutationLocked} />
        <TopologyCanvas
          nodes={nodes}
          edges={edges}
          selection={store.selection}
          onNodesChange={onNodeChanges}
          onEdgesChange={onEdgeChanges}
          onConnect={onConnect}
          onSelect={selectTopologyItem}
          onAddNode={addAppliance}
          onOpenNodeConfig={store.openConfig}
          onOpenNodeConsole={openNodeConsole}
          onToggleNode={toggleNodeState}
          onToggleLink={(linkId, enabled) => patchLink(linkId, { enabled })}
          onDeleteItem={(selection) => {
            store.setSelection(selection);
            useLabStore.getState().deleteSelection();
          }}
          structuralLocked={projectMutationLocked}
          operationsLocked={runtimeBusy}
        />
        {editorNode ? (
          <Suspense fallback={<section className="config-workspace"><div className="empty-editor">Loading configuration editor…</div></section>}><ConfigWorkspace
            nodeLabel={editorNode.name}
            files={configFiles}
            activePath={store.editorPath ?? configFiles[0]?.path ?? ''}
            diagnostics={store.diagnostics}
            readOnly={projectMutationLocked}
            onSelect={store.selectConfig}
            onChange={(path, contents) => store.writeConfig(editorNode.id, path, contents)}
            onAdd={(path, contents) => {
              if (!path.startsWith('/')) { setToast('Appliance file paths must be absolute.'); return; }
              if (editorNode.files.some((candidate) => candidate.path === path)) { setToast(`${path} already exists.`); return; }
              store.patchNode(editorNode.id, { files: [...editorNode.files, { path, content: contents, encoding: 'utf-8' }] });
              store.selectConfig(path);
            }}
            onDelete={(path) => {
              const remaining = editorNode.files.filter((candidate) => candidate.path !== path);
              const entrypoint = editorNode.appliance.entrypoint === path ? remaining[0]?.path : editorNode.appliance.entrypoint;
              store.patchNode(editorNode.id, { files: remaining, appliance: { ...editorNode.appliance, entrypoint } });
              store.selectConfig(entrypoint ?? remaining[0]?.path ?? '');
            }}
            onClose={store.closeConfig}
            onValidate={validateConfig}
          /></Suspense>
        ) : selectedCanvasNode && selectedNode ? (
          <NodeInspector
            node={selectedCanvasNode}
            interfaces={selectedNode.interfaces}
            defaultGateway={selectedNode.client?.defaultGateway}
            serviceAddresses={selectedNode.service?.addresses}
            enabled={selectedNode.state === 'up'}
            locked={projectMutationLocked}
            operationalDisabled={runtimeBusy}
            onPatch={patchSelectedNode}
            onInterfacesChange={(interfaces) => store.setNodeInterfaces(selectedNode.id, interfaces)}
            onDefaultGatewayChange={(defaultGateway) => store.patchNode(selectedNode.id, { client: { ...selectedNode.client, defaultGateway: defaultGateway || undefined } })}
            onServiceAddressesChange={(addresses) => store.patchNode(selectedNode.id, { service: { addresses, protocols: selectedNode.service?.protocols ?? ['icmp'] } })}
            onDelete={store.deleteSelection}
            onOpenConfig={() => store.openConfig(selectedNode.id)}
            onToggleState={() => toggleNodeState(selectedNode.id, selectedNode.state !== 'up')}
          />
        ) : selectedCanvasLink && selectedLink ? (
          <LinkInspector edge={selectedCanvasLink} onPatch={patchSelectedLink} onDelete={store.deleteSelection} locked={projectMutationLocked} operationalDisabled={runtimeBusy} />
        ) : <EmptyInspector />}
      </main>
      <BottomPanel
        terminalTitle={consoleNode
          ? `${consoleNode.name} · ${runtimeMode === 'native' ? 'isolated serial shell' : consoleNode.appliance.kind === 'frr' ? 'isolated vtysh-compatible console' : consoleNode.appliance.kind === 'bird' ? 'isolated birdc-compatible console' : 'isolated shell'}`
          : 'No appliance console'}
        terminalLines={consoleNode ? store.terminalLinesByNode[consoleNode.id] ?? [] : []}
        consoleTargets={consoleNodes.map((node) => ({ id: node.id, label: node.name }))}
        activeConsoleId={consoleNode?.id ?? ''}
        onConsoleChange={setConsoleNodeId}
        trace={runtimeMode === 'native' ? [] : traceViews(store.trace)}
        events={runtimeMode === 'native' ? [...nativeEvents].reverse() : eventViews(store.snapshot)}
        runtimeMode={runtimeMode}
        onCommand={(command) => void runCommand(command)}
        onClearTerminal={() => { if (consoleNode) store.clearTerminal(consoleNode.id); }}
        onTrace={(source, destination) => void runTrace(source, destination)}
        onExportCapture={exportCapture}
        clients={store.project.nodes.filter((node) => node.kind === 'client').map((node) => ({ id: node.id, label: node.name }))}
        focusRequest={consoleFocusRequest}
      />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
