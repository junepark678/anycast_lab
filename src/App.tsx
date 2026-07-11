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
    const nodeNames = new Map(project.nodes.map((node) => [node.id, node.name]));
    const engine = new NativeLabEngine(structuredClone(project), nativeRegistry(), {
      autoRun: true,
      onEvent: (event) => {
        if (event.type === 'engine.state' && event.detail?.state === 'failed') {
          const active = useLabStore.getState();
          active.setRunning(false);
          active.appendTerminal('error', event.message);
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
            'output',
            `[${nodeNames.get(output.nodeId) ?? output.nodeId}] ${consumed.complete}`,
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
          store.appendTerminal('system', 'Native VMs paused. Their machine state is preserved in memory.');
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
          store.appendTerminal('system', 'Resuming native Linux VMs…');
          await existing.resume();
        } else {
          store.appendTerminal('system', `Booting ${nativeVmCount} isolated Linux VMs (${estimate}) and executing the project files unchanged…`);
          const nativeEngine = await rebuildNativeEngine();
          await nativeEngine.start();
        }
        const descriptors = nativeEngineRef.current?.runtimeDescriptors() ?? {};
        store.appendTerminal('system', `Native fabric is running · ${Object.keys(descriptors).length} real appliances · raw Ethernet capture enabled.`);
        return;
      }

      store.setRunning(true);
      store.appendTerminal('system', 'Starting appliances and converging protocols…');
      const engine = await rebuildEngine();
      await engine.converge();
      const snapshot = engine.snapshot();
      store.setSnapshot(snapshot);
      store.appendTerminal('system', `Converged at ${(snapshot.nowMs / 1000).toFixed(3)}s · ${snapshot.sessions.filter((session) => session.state === 'established').length} sessions established.`);
    } catch (error) {
      store.setRunning(false);
      if (runtimeMode === 'native') setNativeProjectLocked(false);
      store.appendTerminal('error', error instanceof Error ? error.message : String(error));
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
  const configFiles: ConfigFileView[] = (editorNode?.files ?? []).map((file) => ({ path: file.path, contents: file.content, language: editorNode?.appliance.kind === 'bird' ? 'bird' : editorNode?.appliance.kind === 'frr' ? 'frr' : 'plaintext' }));

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
    const node = selectedNode && selectedNode.kind !== 'switch' ? selectedNode
      : store.project.nodes.find((candidate) => candidate.kind === 'router' || candidate.kind === 'route-server')
        ?? store.project.nodes.find((candidate) => candidate.kind !== 'switch');
    if (!node) return;
    store.appendTerminal('input', `${node.name}$ ${command}`);
    try {
      if (runtimeMode === 'native') {
        await sendNativeCommand(node.id, command);
        return;
      }
      const engine = engineRef.current ?? await rebuildEngine();
      if (!store.snapshot) { await engine.converge(); store.setSnapshot(engine.snapshot()); }
      const result = await engine.terminal(node.id, command);
      store.appendTerminal(result.exitCode === 0 ? 'output' : 'error', result.output || '(no output)');
    } catch (error) { store.appendTerminal('error', error instanceof Error ? error.message : String(error)); }
  }, [rebuildEngine, runtimeMode, selectedNode, sendNativeCommand, store]);

  const runTrace = useCallback(async (sourceNodeId: string, destination: string) => {
    try {
      if (runtimeMode === 'native') {
        if (!/^[a-zA-Z0-9_.:%-]+$/.test(destination)) throw new Error('Enter an IP address or hostname to trace.');
        const source = store.project.nodes.find((node) => node.id === sourceNodeId);
        store.appendTerminal('input', `${source?.name ?? sourceNodeId}$ traceroute -n -m 16 ${destination}`);
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

  const patchSelectedLink = useCallback((patch: Partial<LabLinkViewData>) => {
    if (!selectedLink || runtimeOperationRef.current) return;
    store.patchLink(selectedLink.id, {
      state: patch.enabled === undefined ? selectedLink.state : patch.enabled ? 'up' : 'down',
      latencyMs: patch.latencyMs ?? selectedLink.latencyMs,
      jitterMs: patch.jitterMs ?? selectedLink.jitterMs,
      loss: patch.lossPercent === undefined ? selectedLink.loss : patch.lossPercent / 100,
      bandwidthMbps: patch.bandwidthMbps ?? selectedLink.bandwidthMbps,
    });
    if (
      nativeEngineRef.current &&
      ['running', 'paused', 'stopped'].includes(nativeEngineRef.current.state) &&
      patch.enabled !== undefined
    ) {
      void nativeEngineRef.current.setLinkState(selectedLink.id, patch.enabled ? 'up' : 'down')
        .catch((error: unknown) => store.appendTerminal('error', error instanceof Error ? error.message : String(error)));
    } else if (engineRef.current && patch.enabled !== undefined) {
      engineRef.current.setLinkState(selectedLink.id, patch.enabled ? 'up' : 'down');
      void engineRef.current.converge().then(() => store.setSnapshot(engineRef.current?.snapshot() ?? null));
    }
    if ((patch.latencyMs !== undefined || patch.jitterMs !== undefined || patch.lossPercent !== undefined || patch.bandwidthMbps !== undefined) && (engineRef.current || nativeEngineRef.current)) {
      setToast('Restart the runtime to apply changed link characteristics.');
    }
  }, [selectedLink, store]);

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
      store.appendTerminal('error', error instanceof Error ? error.message : String(error));
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
      store.appendTerminal('system', mode === 'native'
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
        <Palette onAdd={store.addNode} disabled={projectMutationLocked} />
        <TopologyCanvas nodes={nodes} edges={edges} selection={store.selection} onNodesChange={onNodeChanges} onEdgesChange={onEdgeChanges} onConnect={onConnect} onSelect={store.setSelection} structuralLocked={projectMutationLocked} />
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
            onToggleState={() => {
              if (runtimeOperationRef.current) return;
              const state = selectedNode.state === 'up' ? 'down' : 'up';
              store.patchNode(selectedNode.id, { state });
              if (nativeEngineRef.current && ['running', 'paused', 'stopped'].includes(nativeEngineRef.current.state)) {
                void nativeEngineRef.current.setNodeState(selectedNode.id, state)
                  .catch((error: unknown) => store.appendTerminal('error', error instanceof Error ? error.message : String(error)));
              } else if (engineRef.current) {
                engineRef.current.setNodeState(selectedNode.id, state);
                void engineRef.current.converge().then(() => store.setSnapshot(engineRef.current?.snapshot() ?? null));
              }
            }}
          />
        ) : selectedCanvasLink && selectedLink ? (
          <LinkInspector edge={selectedCanvasLink} onPatch={patchSelectedLink} onDelete={store.deleteSelection} locked={projectMutationLocked} operationalDisabled={runtimeBusy} />
        ) : <EmptyInspector />}
      </main>
      <BottomPanel
        terminalTitle={selectedNode
          ? `${selectedNode.name} · ${runtimeMode === 'native' ? 'serial shell' : selectedNode.appliance.kind === 'frr' ? 'vtysh-compatible console' : selectedNode.appliance.kind === 'bird' ? 'birdc-compatible console' : 'shell'}`
          : runtimeMode === 'native' ? 'Native VM console' : 'Lab console'}
        terminalLines={store.terminalLines}
        trace={runtimeMode === 'native' ? [] : traceViews(store.trace)}
        events={runtimeMode === 'native' ? [...nativeEvents].reverse() : eventViews(store.snapshot)}
        runtimeMode={runtimeMode}
        onCommand={(command) => void runCommand(command)}
        onTrace={(source, destination) => void runTrace(source, destination)}
        onExportCapture={exportCapture}
        clients={store.project.nodes.filter((node) => node.kind === 'client').map((node) => ({ id: node.id, label: node.name }))}
      />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}
