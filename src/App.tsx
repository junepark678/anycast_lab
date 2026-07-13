import { useEdgesState, useNodesState, type Connection } from '@xyflow/react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { ApplianceRuntimeRegistry } from './appliances';
import {
  createSharedV86RuntimeFactories,
  loadVerifiedV86Artifacts,
  openBrowserV86ArtifactCache,
} from './appliances/v86';
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
  type ProjectSummary,
} from './persistence';
import { BottomPanel } from './app/components/BottomPanel';
import { EmptyInspector, LinkInspector, NodeInspector } from './app/components/Inspector';
import { LabHeader } from './app/components/LabHeader';
import { Palette } from './app/components/Palette';
import { ProjectManager, type ProjectTemplate } from './app/components/ProjectManager';
import { TopologyCanvas } from './app/components/TopologyCanvas';
import {
  loadNativeRuntimeAvailability,
  nativeMemoryEstimate,
  type NativeRuntimeAvailability,
} from './app/native-runtime';
import {
  createBlankProject,
  createDefaultDemoProject,
  duplicateProject,
  validateProjectName,
} from './app/project-management';
import {
  activatePersistedProject,
  resumeProjectAutosave,
} from './app/project-replacement';
import { projectCanvas, useLabStore } from './app/store';
import { consumeTerminalChunk } from './app/terminal-stream';
import type { ConfigFileView, LabLinkViewData, LabNodeViewData, TimelineEventView, TraceHopView } from './app/view-types';
import './styles.css';

const LAST_PROJECT_KEY = 'anycast-lab:last-project';
const WORKSPACE_LAYOUT_KEY = 'anycast-lab:workspace-layout:v1';
const EMBEDDED_WORKSPACE_LAYOUT_KEY = 'anycast-lab:guide-layout:v1';
const GUIDE_FOCUS_TARGETS = new Set(['run', 'runtime', 'console', 'trace', 'topology', 'export']);
const PGO_BRIDGE_ENABLED = import.meta.env.VITE_ANYCAST_LAB_PGO_BRIDGE === '1';
const ConfigWorkspace = lazy(() => import('./app/components/ConfigWorkspace').then((module) => ({ default: module.ConfigWorkspace })));

interface BrowserPgoBridgeEngine {
  setLinkState(linkId: string, state: 'up' | 'down'): Promise<void>;
  collectPgoProfiles(): ReturnType<NativeLabEngine['collectPgoProfiles']>;
}

interface BrowserPgoBridge {
  enabled: true;
  engine?: BrowserPgoBridgeEngine;
  profiles?: unknown;
}

interface PreparedProjectTransition {
  project: LabProject;
  revision: number;
  beforeInstall?: () => Promise<void>;
  successMessage: string;
}

type PgoBridgeGlobal = typeof globalThis & { __anycastPgo?: BrowserPgoBridge };
let attachedPgoEngine: NativeLabEngine | null = null;

if (PGO_BRIDGE_ENABLED) {
  (globalThis as PgoBridgeGlobal).__anycastPgo = { enabled: true };
}

function attachPgoBridgeEngine(engine: NativeLabEngine): void {
  if (!PGO_BRIDGE_ENABLED) return;
  const bridge = (globalThis as PgoBridgeGlobal).__anycastPgo;
  if (bridge?.enabled !== true) {
    throw new Error('The instrumented PGO bridge disappeared before native engine creation.');
  }
  attachedPgoEngine = engine;
  bridge.engine = {
    setLinkState: (linkId, state) => engine.setLinkState(linkId, state),
    collectPgoProfiles: () => engine.collectPgoProfiles(),
  };
}

function detachPgoBridgeEngine(engine: NativeLabEngine | null): void {
  if (!PGO_BRIDGE_ENABLED || engine === null || attachedPgoEngine !== engine) return;
  attachedPgoEngine = null;
  const bridge = (globalThis as PgoBridgeGlobal).__anycastPgo;
  if (bridge?.enabled === true) delete bridge.engine;
}

interface WorkspaceLayout {
  paletteCollapsed: boolean;
  detailsCollapsed: boolean;
  headerCollapsed: boolean;
}

function workspaceContext(): { embedded: boolean; compact: boolean; narrowHeader: boolean } {
  const embedded = new URLSearchParams(window.location.search).get('embed') === 'guide';
  return {
    embedded,
    compact: window.matchMedia('(max-width: 700px)').matches,
    narrowHeader: window.matchMedia('(max-width: 1100px)').matches,
  };
}

function defaultWorkspaceLayout(context: ReturnType<typeof workspaceContext>): WorkspaceLayout {
  return {
    paletteCollapsed: context.embedded || context.compact,
    detailsCollapsed: context.embedded || context.compact,
    headerCollapsed: context.embedded || context.narrowHeader,
  };
}

function initialWorkspaceLayout(context: ReturnType<typeof workspaceContext>, storageKey: string): WorkspaceLayout {
  const fallback = defaultWorkspaceLayout(context);
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? 'null') as Partial<WorkspaceLayout> | null;
    if (!saved) return fallback;
    return {
      paletteCollapsed: typeof saved.paletteCollapsed === 'boolean' ? saved.paletteCollapsed : fallback.paletteCollapsed,
      detailsCollapsed: typeof saved.detailsCollapsed === 'boolean' ? saved.detailsCollapsed : fallback.detailsCollapsed,
      headerCollapsed: typeof saved.headerCollapsed === 'boolean' ? saved.headerCollapsed : fallback.headerCollapsed,
    };
  } catch {
    return fallback;
  }
}

function saveBlob(bytes: Uint8Array, filename: string, mediaType = ANYCAST_LAB_ARCHIVE_MIME): void {
  const part = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([part], { type: mediaType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function readLastProjectId(): string | null {
  try { return localStorage.getItem(LAST_PROJECT_KEY); }
  catch { return null; }
}

function rememberLastProjectId(projectId: string): void {
  try { localStorage.setItem(LAST_PROJECT_KEY, projectId); }
  catch { /* IndexedDB remains authoritative when preference storage is denied. */ }
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

function sameProjectRevision(first: LabProject, second: LabProject): boolean {
  return first.id === second.id && first.updatedAt === second.updatedAt;
}

export default function App() {
  const context = useMemo(workspaceContext, []);
  const workspaceLayoutKey = context.embedded ? EMBEDDED_WORKSPACE_LAYOUT_KEY : WORKSPACE_LAYOUT_KEY;
  const [workspaceLayout, setWorkspaceLayout] = useState(() => initialWorkspaceLayout(context, workspaceLayoutKey));
  const [guideFocusTarget, setGuideFocusTarget] = useState<string | null>(null);
  const store = useLabStore();
  const canvas = useMemo(() => projectCanvas(store.project, store.snapshot, store.running), [store.project, store.running, store.snapshot]);
  const [nodes, setNodes, onNodesChangeBase] = useNodesState(canvas.nodes);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState(canvas.edges);
  const [toast, setToast] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const repositoryRef = useRef<ProjectRepository<LabProject> | null>(null);
  const autosaveRef = useRef<AutosaveCoordinator<LabProject> | null>(null);
  const engineRef = useRef<LabEngine | null>(null);
  const simulationEngineSyncRef = useRef<Promise<LabEngine> | null>(null);
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
  const [projectManagerOpen, setProjectManagerOpen] = useState(false);
  const [projectManagerLoading, setProjectManagerLoading] = useState(false);
  const [projectManagerError, setProjectManagerError] = useState<string | null>(null);
  const [projectSummaries, setProjectSummaries] = useState<ProjectSummary[]>([]);
  const [repositoryBackend, setRepositoryBackend] = useState<'indexeddb' | 'memory'>('indexeddb');
  const [nativeProjectLocked, setNativeProjectLocked] = useState(false);
  const runtimeMode = useMemo<'simulation' | 'native'>(
    () => store.project.nodes.some((node) => node.kind !== 'switch' && node.appliance.runtime === 'wasm') ? 'native' : 'simulation',
    [store.project.nodes],
  );
  const nativeNodeCount = useMemo(
    () => store.project.nodes.filter((node) => node.kind !== 'switch').length,
    [store.project.nodes],
  );

  const refreshProjectSummaries = useCallback(async (): Promise<boolean> => {
    const repository = repositoryRef.current;
    if (repository === null) return false;
    setProjectManagerLoading(true);
    try {
      setProjectSummaries(await repository.list());
      return true;
    } catch (error) {
      setProjectManagerError(error instanceof Error ? error.message : 'Could not load saved projects.');
      return false;
    } finally {
      setProjectManagerLoading(false);
    }
  }, []);

  const updateWorkspaceLayout = useCallback((patch: Partial<WorkspaceLayout>, persist = true) => {
    setWorkspaceLayout((current) => {
      const next = { ...current, ...patch };
      if (persist) {
        try { localStorage.setItem(workspaceLayoutKey, JSON.stringify(next)); }
        catch { /* Layout preferences are optional when storage is unavailable. */ }
      }
      return next;
    });
  }, [workspaceLayoutKey]);

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
    if (!context.embedded) return;
    const receiveGuideStep = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin || event.data?.type !== 'anycast-guide:focus') return;
      const target = typeof event.data.target === 'string' ? event.data.target : '';
      if (!GUIDE_FOCUS_TARGETS.has(target)) return;
      setGuideFocusTarget(target);
      if (target === 'runtime' || target === 'export') updateWorkspaceLayout({ headerCollapsed: false }, false);
    };
    window.addEventListener('message', receiveGuideStep);
    window.parent.postMessage({ type: 'anycast-lab:ready' }, window.location.origin);
    return () => window.removeEventListener('message', receiveGuideStep);
  }, [context.embedded, updateWorkspaceLayout]);

  useEffect(() => {
    const deploymentBase = new URL(import.meta.env.BASE_URL, window.location.href).href;
    void loadNativeRuntimeAvailability(deploymentBase).then(setNativeAvailability);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let revisionSeeded = false;
    let unsubscribeAutosave: (() => void) | undefined;
    void (async () => {
      let repository: ProjectRepository<LabProject> | null = null;
      try {
        repository = await createLabProjectRepository({ onFallback: () => setToast('IndexedDB unavailable; changes will last for this session.') });
        if (cancelled) { repository.close(); return; }
        repositoryRef.current = repository;
        setRepositoryBackend(repository.backend);
        autosaveRef.current = new AutosaveCoordinator({
          repository,
          delayMs: 0,
          onStateChange: (state) => {
            if (state.status === 'saving') store.markSaving();
            if (state.status === 'error') store.markSaveError();
          },
          onSaved: (saved) => {
            useLabStore.getState().markSaved(saved.project);
            if (!cancelled) {
              void repository!.list().then(setProjectSummaries).catch((error: unknown) => {
                if (!cancelled) setProjectManagerError(error instanceof Error ? error.message : 'Could not refresh saved projects.');
              });
            }
          },
        });
        unsubscribeAutosave = useLabStore.subscribe((current, previous) => {
          if (
            !bootedRef.current ||
            !current.dirty ||
            current.project === previous.project ||
            projectReplacementRef.current
          ) return;
          const autosave = autosaveRef.current;
          if (autosave === null) return;
          // Start the IndexedDB transaction in the same call stack as the edit.
          // A page lifecycle event cannot reliably await an asynchronous flush.
          autosave.schedule(current.project);
          rememberLastProjectId(current.project.id);
        });
        const previousId = readLastProjectId();
        const previous = previousId ? await repository.get(previousId) : undefined;
        const current = useLabStore.getState();
        if (previous && !current.dirty) {
          current.setProject(previous.project);
        } else if (!current.dirty) {
          const recent = (await repository.list())[0];
          const fallback = recent ? await repository.get(recent.id) : undefined;
          const latest = useLabStore.getState();
          if (fallback && !latest.dirty) latest.setProject(fallback.project);
        }
        const active = useLabStore.getState();
        let activeStored = await repository.get(active.project.id);
        if (!active.dirty && activeStored === undefined) {
          activeStored = await repository.save(active.project, { expectedRevision: 0 });
        }
        autosaveRef.current.setExpectedRevision(active.project.id, activeStored?.revision ?? 0);
        revisionSeeded = true;
        await repository.markOpened(active.project.id);
        rememberLastProjectId(active.project.id);
        setProjectSummaries(await repository.list());
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'Local project storage could not be initialized.';
          setProjectManagerError(message);
          setToast('The default demo is open, but the saved-project catalog needs attention.');
        }
      } finally {
        if (!cancelled && repositoryRef.current !== null && revisionSeeded) {
          bootedRef.current = true;
          // The user can edit the initially rendered demo while IndexedDB startup
          // is still awaiting its first reads. Re-read the store after boot so an
          // edit that the dirty-state effect intentionally skipped is not lost.
          const latest = useLabStore.getState();
          resumeProjectAutosave({
            project: latest.project,
            dirty: latest.dirty,
            booted: bootedRef.current,
            autosave: autosaveRef.current,
            rememberProjectId: rememberLastProjectId,
          });
          // Keep persistence actions locked until the initial lookup/restore is
          // fully settled; otherwise a fast import can be replaced by stale
          // bootstrap data when the lookup resumes.
          setPersistenceReady(true);
          void requestPersistentStorage();
        }
      }
    })();
    return () => {
      cancelled = true;
      unsubscribeAutosave?.();
      const autosave = autosaveRef.current;
      const repository = repositoryRef.current;
      if (autosave !== null) void autosave.dispose({ flush: true }).finally(() => repository?.close());
      else repository?.close();
      void engineRef.current?.dispose();
      const native = nativeEngineRef.current;
      nativeEngineRef.current = null;
      detachPgoBridgeEngine(native);
      void native?.dispose();
    };
    // Store methods are stable; this intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    const cachePromise = openBrowserV86ArtifactCache();
    const factories = createSharedV86RuntimeFactories({
      artifactSource,
      bootTimeoutMs: 120_000,
      loadArtifacts: async () => {
        const cache = await cachePromise;
        const attempt = artifactPromise ?? loadVerifiedV86Artifacts(
          artifactSource,
          cache === null ? {} : { cache },
        );
        artifactPromise = attempt;
        try {
          return await attempt;
        } catch (error) {
          if (artifactPromise === attempt) artifactPromise = null;
          throw error;
        }
      },
    });
    for (const factory of factories) registry.register(factory);
    nativeRegistryRef.current = { key, registry };
    return registry;
  }, [nativeAvailability]);

  const rebuildEngine = useCallback(async (project: LabProject): Promise<LabEngine> => {
    const native = nativeEngineRef.current;
    nativeEngineRef.current = null;
    detachPgoBridgeEngine(native);
    await native?.dispose();
    setNativeProjectLocked(false);
    nativeTerminalSessionsRef.current.clear();
    nativeTerminalDecodersRef.current.clear();
    nativeTerminalLineBuffersRef.current.clear();
    await engineRef.current?.dispose();
    const engine = await LabEngine.create(structuredClone(project));
    engineRef.current = engine;
    return engine;
  }, []);

  const ensureSimulationEngine = useCallback(async (): Promise<LabEngine> => {
    const pending = simulationEngineSyncRef.current;
    if (pending !== null) return pending;

    const operation = (async () => {
      while (true) {
        const project = useLabStore.getState().project;
        let engine = engineRef.current;
        if (!engine || !sameProjectRevision(engine.project, project)) {
          engine = await rebuildEngine(project);
        }
        let snapshot = engine.snapshot();
        if (!snapshot.converged) snapshot = await engine.converge();

        const current = useLabStore.getState();
        if (!sameProjectRevision(engine.project, current.project)) continue;
        current.setSnapshot(snapshot);
        return engine;
      }
    })();
    simulationEngineSyncRef.current = operation;
    try {
      return await operation;
    } finally {
      if (simulationEngineSyncRef.current === operation) simulationEngineSyncRef.current = null;
    }
  }, [rebuildEngine]);

  const rebuildNativeEngine = useCallback(async (project = store.project): Promise<NativeLabEngine> => {
    await engineRef.current?.dispose();
    engineRef.current = null;
    const previousNative = nativeEngineRef.current;
    nativeEngineRef.current = null;
    detachPgoBridgeEngine(previousNative);
    await previousNative?.dispose();
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
    try {
      attachPgoBridgeEngine(engine);
    } catch (error) {
      nativeEngineRef.current = null;
      await engine.dispose();
      throw error;
    }
    return engine;
  }, [nativeRegistry, store.project]);

  const run = useCallback(async () => {
    if (!beginRuntimeOperation()) return;
    try {
      if (store.running) {
        if (runtimeMode === 'native') {
          await nativeEngineRef.current?.pause();
          appendRuntimeMessage('system', 'The shared native VM is paused. All namespace state remains in memory.');
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
        const estimate = nativeMemoryEstimate(nativeNodeCount, nativeAvailability.memoryBytes);
        const existing = nativeEngineRef.current;
        if (existing?.state === 'paused') {
          appendRuntimeMessage('system', 'Resuming the shared native Linux VM…');
          await existing.resume();
        } else {
          appendRuntimeMessage('system', `Booting one native Linux VM with ${nativeNodeCount} isolated node namespaces (${estimate})…`);
          const nativeEngine = await rebuildNativeEngine();
          await nativeEngine.start();
        }
        const descriptors = nativeEngineRef.current?.runtimeDescriptors() ?? {};
        appendRuntimeMessage('system', `Native fabric is running · ${Object.keys(descriptors).length} real appliances · raw Ethernet capture enabled.`);
        return;
      }

      store.setRunning(true);
      appendRuntimeMessage('system', 'Starting appliances and converging protocols…');
      const engine = await rebuildEngine(store.project);
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
  }, [beginRuntimeOperation, finishRuntimeOperation, nativeAvailability, nativeNodeCount, rebuildEngine, rebuildNativeEngine, runtimeMode, store]);

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
    if (engine?.state !== 'running') throw new Error('Start the native VM lab before opening a node terminal.');
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
      const engine = await ensureSimulationEngine();
      const result = await engine.terminal(node.id, command);
      store.setSnapshot(engine.snapshot());
      store.appendTerminal(node.id, result.exitCode === 0 ? 'output' : 'error', result.output || '(no output)');
    } catch (error) { store.appendTerminal(node.id, 'error', error instanceof Error ? error.message : String(error)); }
  }, [consoleNode, ensureSimulationEngine, runtimeMode, sendNativeCommand, store]);

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
      const engine = await ensureSimulationEngine();
      const result = engine.trace({ sourceNodeId, destination, protocol: 'icmp' });
      store.setTrace(result); store.setSnapshot(engine.snapshot());
      setToast(result.outcome === 'delivered' ? `Delivered in ${result.totalLatencyMs.toFixed(1)} ms.` : `Trace ended: ${result.outcome}.`);
    } catch (error) { setToast(error instanceof Error ? error.message : String(error)); }
  }, [ensureSimulationEngine, runtimeMode, sendNativeCommand, store]);

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
    detachPgoBridgeEngine(native);
    nativeTerminalSessionsRef.current.clear();
    nativeTerminalDecodersRef.current.clear();
    nativeTerminalLineBuffersRef.current.clear();
    setNativeProjectLocked(false);
    await compatibility?.dispose();
    await native?.dispose();
  }, []);

  const performProjectTransition = useCallback(async (
    prepare: (repository: ProjectRepository<LabProject>) => Promise<PreparedProjectTransition>,
  ): Promise<boolean> => {
    if (!beginRuntimeOperation()) {
      setProjectManagerError('Wait for the current project operation to finish.');
      return false;
    }
    projectReplacementRef.current = true;
    setProjectManagerError(null);
    let runtimeDisposalStarted = false;
    try {
      const repository = repositoryRef.current;
      if (repository === null) throw new Error('Local project storage is still starting.');
      const transition = await prepare(repository);
      await activatePersistedProject({
        project: transition.project,
        disposeRuntime: async () => {
          runtimeDisposalStarted = true;
          await disposeRuntime();
        },
        autosave: autosaveRef.current,
        install: store.setProject,
        beforeInstall: transition.beforeInstall,
      });
      autosaveRef.current?.setExpectedRevision(transition.project.id, transition.revision);
      setNativeEvents([]);
      store.resetRuntime();
      let metadataWarning: string | null = null;
      try {
        await repository.markOpened(transition.project.id);
      } catch (error) {
        metadataWarning = error instanceof Error ? error.message : 'Could not update project recency.';
        setProjectManagerError(metadataWarning);
      }
      rememberLastProjectId(transition.project.id);
      await refreshProjectSummaries();
      setToast(metadataWarning === null
        ? transition.successMessage
        : `${transition.successMessage} Project recency could not be updated.`);
      return true;
    } catch (error) {
      if (runtimeDisposalStarted) store.resetRuntime();
      const message = error instanceof Error ? error.message : 'Could not change projects.';
      setProjectManagerError(message);
      setToast(message);
      return false;
    } finally {
      projectReplacementRef.current = false;
      const active = useLabStore.getState();
      resumeProjectAutosave({
        project: active.project,
        dirty: active.dirty,
        booted: bootedRef.current,
        autosave: autosaveRef.current,
        rememberProjectId: rememberLastProjectId,
      });
      finishRuntimeOperation();
    }
  }, [beginRuntimeOperation, disposeRuntime, finishRuntimeOperation, refreshProjectSummaries, store]);

  const openSavedProject = useCallback(async (projectId: string): Promise<boolean> => (
    performProjectTransition(async (repository) => {
      const stored = await repository.get(projectId);
      if (stored === undefined) throw new Error('That project no longer exists in local storage.');
      return {
        project: stored.project,
        revision: stored.revision,
        successMessage: `Opened ${stored.project.name}.`,
      };
    })
  ), [performProjectTransition]);

  const createManagedProject = useCallback(async (
    template: ProjectTemplate,
    requestedName: string,
  ): Promise<boolean> => (
    performProjectTransition(async (repository) => {
      const name = validateProjectName(requestedName);
      const project = template === 'demo'
        ? { ...createDefaultDemoProject(), name }
        : createBlankProject(name);
      return {
        project,
        revision: 1,
        beforeInstall: async () => { await repository.save(project, { expectedRevision: 0 }); },
        successMessage: `Created ${project.name}.`,
      };
    })
  ), [performProjectTransition]);

  const duplicateManagedProject = useCallback(async (projectId: string): Promise<boolean> => (
    performProjectTransition(async (repository) => {
      const source = projectId === useLabStore.getState().project.id
        ? useLabStore.getState().project
        : (await repository.get(projectId))?.project;
      if (source === undefined) throw new Error('That project no longer exists in local storage.');
      const summaries = await repository.list();
      const project = duplicateProject(source, summaries);
      return {
        project,
        revision: 1,
        beforeInstall: async () => { await repository.save(project, { expectedRevision: 0 }); },
        successMessage: `Created ${project.name}.`,
      };
    })
  ), [performProjectTransition]);

  const renameManagedProject = useCallback(async (projectId: string, requestedName: string): Promise<boolean> => {
    setProjectManagerError(null);
    try {
      const repository = repositoryRef.current;
      if (repository === null) throw new Error('Local project storage is still starting.');
      const name = validateProjectName(requestedName);
      const active = useLabStore.getState();
      if (projectId === active.project.id) {
        projectReplacementRef.current = true;
        try {
          active.renameProject(name);
          const updated = useLabStore.getState().project;
          autosaveRef.current?.schedule(updated);
          await autosaveRef.current?.flush();
        } finally {
          // The manual flush above owns this mutation. Suppressing the normal
          // dirty effect prevents an identical second revision from being
          // enqueued while the IndexedDB transaction is in flight.
          projectReplacementRef.current = false;
        }
      } else {
        const stored = await repository.get(projectId);
        if (stored === undefined) throw new Error('That project no longer exists in local storage.');
        const previousTimestamp = Date.parse(stored.project.updatedAt);
        const timestamp = Number.isFinite(previousTimestamp)
          ? Math.max(Date.now(), previousTimestamp + 1)
          : Date.now();
        await repository.save({
          ...stored.project,
          name,
          updatedAt: new Date(timestamp).toISOString(),
        }, { expectedRevision: stored.revision });
      }
      await refreshProjectSummaries();
      setToast(`Renamed project to ${name}.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not rename that project.';
      setProjectManagerError(message);
      return false;
    }
  }, [refreshProjectSummaries]);

  const exportManagedProject = useCallback(async (projectId: string): Promise<boolean> => {
    setProjectManagerError(null);
    try {
      const repository = repositoryRef.current;
      if (repository === null) throw new Error('Local project storage is still starting.');
      const project = projectId === useLabStore.getState().project.id
        ? useLabStore.getState().project
        : (await repository.get(projectId))?.project;
      if (project === undefined) throw new Error('That project no longer exists in local storage.');
      saveBlob(exportProjectArchive(project), projectArchiveFilename(project.name));
      setToast(`Exported ${project.name}.`);
      return true;
    } catch (error) {
      setProjectManagerError(error instanceof Error ? error.message : 'Could not export that project.');
      return false;
    }
  }, []);

  const deleteManagedProject = useCallback(async (projectId: string): Promise<boolean> => {
    const activeId = useLabStore.getState().project.id;
    if (projectId !== activeId) {
      setProjectManagerError(null);
      try {
        const repository = repositoryRef.current;
        if (repository === null) throw new Error('Local project storage is still starting.');
        if (!await repository.delete(projectId)) throw new Error('That project no longer exists in local storage.');
        await refreshProjectSummaries();
        setToast('Project deleted.');
        return true;
      } catch (error) {
        setProjectManagerError(error instanceof Error ? error.message : 'Could not delete that project.');
        return false;
      }
    }

    return performProjectTransition(async (repository) => {
      const remaining = (await repository.list()).filter((summary) => summary.id !== projectId);
      const storedReplacement = remaining[0] ? await repository.get(remaining[0].id) : undefined;
      const replacement = storedReplacement?.project ?? createBlankProject();
      return {
        project: replacement,
        revision: storedReplacement?.revision ?? 1,
        beforeInstall: async () => {
          if (storedReplacement === undefined) {
            await repository.save(replacement, { expectedRevision: 0 });
          }
          if (!await repository.delete(projectId)) {
            throw new Error('That project no longer exists in local storage.');
          }
        },
        successMessage: `Deleted the project and opened ${replacement.name}.`,
      };
    });
  }, [performProjectTransition, refreshProjectSummaries]);

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
        ? 'Native VM mode selected. One shared Linux VM runs real BIRD, FRR, client, and service nodes in isolated namespaces; there is no compatibility fallback.'
        : 'Simulation mode selected. This deterministic compatibility engine is fast, but does not execute the upstream daemons.');
      if (mode === 'native' && nativeAvailability?.available) {
        setToast(`Native mode selected · ${nativeMemoryEstimate(nativeNodeCount, nativeAvailability.memoryBytes)}. Run when ready.`);
      }
    } finally {
      finishRuntimeOperation();
    }
  }, [beginRuntimeOperation, disposeRuntime, finishRuntimeOperation, nativeAvailability, nativeNodeCount, runtimeMode, store]);

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
    try {
      const imported = await importProjectArchive<LabProject>(file);
      const validation = validateProject(imported.project);
      if (!validation.success || !validation.value) throw new Error(validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
      validateProjectName(validation.value.name);
      await performProjectTransition(async (repository) => {
        const collision = await repository.get(validation.value!.id);
        const project = collision === undefined
          ? validation.value!
          : duplicateProject(validation.value!, await repository.list());
        return {
          project,
          revision: 1,
          beforeInstall: async () => { await repository.save(project, { expectedRevision: 0 }); },
          successMessage: collision === undefined
            ? `Imported ${project.name}.`
            : `Imported ${project.name} as a separate project; the existing project was kept.`,
        };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not import project.';
      setProjectManagerError(message);
      setToast(message);
    }
  }, [performProjectTransition]);

  const saveNow = useCallback(async () => {
    try { autosaveRef.current?.schedule(store.project); await autosaveRef.current?.flush(); setToast('Project saved locally.'); }
    catch { setToast('Local save failed. Export a copy before leaving.'); }
  }, [store.project]);

  const nativeRuntimeState = nativeAvailability === null ? 'loading' : nativeAvailability.available ? 'available' : 'unavailable';
  const nativeRuntimeDetail = nativeAvailability === null
    ? 'Checking for the verified native VM image…'
    : nativeAvailability.available
      ? `${nativeAvailability.buildId} · ${nativeMemoryEstimate(nativeNodeCount, nativeAvailability.memoryBytes)}`
      : nativeAvailability.reason;
  const projectMutationLocked = nativeProjectLocked || runtimeBusy;

  useEffect(() => {
    const handleWorkspaceShortcut = (event: KeyboardEvent) => {
      if (projectManagerOpen) return;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (modifier && key === 's') {
        event.preventDefault();
        if (persistenceReady && !runtimeBusy) void saveNow();
        return;
      }

      if (modifier && key === 'o') {
        event.preventDefault();
        if (persistenceReady && !runtimeBusy) fileInputRef.current?.click();
        return;
      }

      const target = event.target;
      const editingText = target instanceof HTMLElement
        && (target.isContentEditable || target.matches('input, textarea, select'));
      if ((event.key === 'Delete' || event.key === 'Backspace')
        && !editingText && store.selection && !projectMutationLocked) {
        event.preventDefault();
        store.deleteSelection();
      }
    };

    window.addEventListener('keydown', handleWorkspaceShortcut);
    return () => window.removeEventListener('keydown', handleWorkspaceShortcut);
  }, [persistenceReady, projectManagerOpen, projectMutationLocked, runtimeBusy, saveNow, store]);

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

  const openNodeConfig = useCallback((nodeId: string) => {
    updateWorkspaceLayout({ detailsCollapsed: false });
    store.openConfig(nodeId);
  }, [store, updateWorkspaceLayout]);

  return (
    <>
    <div
      className={`lab-shell${editorNode ? ' is-editor-open' : ''}${context.embedded ? ' is-embedded' : ''}${workspaceLayout.headerCollapsed ? ' is-header-collapsed' : ''}`}
      data-guide-focus={guideFocusTarget ?? undefined}
      inert={projectManagerOpen ? true : undefined}
    >
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
        collapsed={workspaceLayout.headerCollapsed}
        embedded={context.embedded}
        onProjectNameChange={store.renameProject}
        onManageProjects={() => {
          setProjectManagerError(null);
          setProjectManagerOpen(true);
          void refreshProjectSummaries();
        }}
        onRuntimeModeChange={(mode) => void changeRuntimeMode(mode)}
        onRunToggle={() => void run()}
        onReset={() => void resetRuntime()}
        onSave={() => void saveNow()}
        onExport={exportProject}
        onImport={(event) => void importProject(event)}
        onToggleCollapsed={() => updateWorkspaceLayout({ headerCollapsed: !workspaceLayout.headerCollapsed })}
        selectionType={store.selection?.kind ?? null}
        paletteCollapsed={workspaceLayout.paletteCollapsed}
        detailsCollapsed={workspaceLayout.detailsCollapsed}
        onDeleteSelection={store.deleteSelection}
        onTogglePalette={() => updateWorkspaceLayout({ paletteCollapsed: !workspaceLayout.paletteCollapsed })}
        onToggleDetails={() => updateWorkspaceLayout({ detailsCollapsed: !workspaceLayout.detailsCollapsed })}
        onResetWorkspace={() => updateWorkspaceLayout(defaultWorkspaceLayout(workspaceContext()))}
      />
      <main className={`lab-main${editorNode ? ' has-editor' : ''}${workspaceLayout.paletteCollapsed ? ' is-palette-collapsed' : ''}${workspaceLayout.detailsCollapsed ? ' is-details-collapsed' : ''}`}>
        <Palette
          onAdd={addAppliance}
          disabled={projectMutationLocked}
          collapsed={workspaceLayout.paletteCollapsed}
          onToggle={() => updateWorkspaceLayout({ paletteCollapsed: !workspaceLayout.paletteCollapsed })}
        />
        <TopologyCanvas
          nodes={nodes}
          edges={edges}
          selection={store.selection}
          onNodesChange={onNodeChanges}
          onEdgesChange={onEdgeChanges}
          onConnect={onConnect}
          onSelect={selectTopologyItem}
          onAddNode={addAppliance}
          onOpenNodeConfig={openNodeConfig}
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
        <div className={`details-panel${workspaceLayout.detailsCollapsed ? ' is-collapsed' : ''}`}>
          <button
            type="button"
            className="details-panel__toggle"
            aria-label={workspaceLayout.detailsCollapsed ? 'Expand details panel' : 'Collapse details panel'}
            aria-expanded={!workspaceLayout.detailsCollapsed}
            onClick={() => updateWorkspaceLayout({ detailsCollapsed: !workspaceLayout.detailsCollapsed })}
            title={workspaceLayout.detailsCollapsed ? 'Expand details panel' : 'Collapse details panel'}
          >
            {workspaceLayout.detailsCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
            <span>Details</span>
          </button>
        {!workspaceLayout.detailsCollapsed && (editorNode ? (
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
            onOpenConfig={() => openNodeConfig(selectedNode.id)}
            onToggleState={() => toggleNodeState(selectedNode.id, selectedNode.state !== 'up')}
          />
        ) : selectedCanvasLink && selectedLink ? (
          <LinkInspector edge={selectedCanvasLink} onPatch={patchSelectedLink} onDelete={store.deleteSelection} locked={projectMutationLocked} operationalDisabled={runtimeBusy} />
        ) : <EmptyInspector />)}
        </div>
      </main>
      <BottomPanel
        terminalTitle={consoleNode
          ? `${consoleNode.name} · ${runtimeMode === 'native' ? 'isolated namespace shell' : consoleNode.appliance.kind === 'frr' ? 'isolated vtysh-compatible console' : consoleNode.appliance.kind === 'bird' ? 'isolated birdc-compatible console' : 'isolated shell'}`
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
        guideFocusTarget={guideFocusTarget}
      />
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
    <ProjectManager
      open={projectManagerOpen}
      onClose={() => setProjectManagerOpen(false)}
      projects={projectSummaries}
      activeProjectId={store.project.id}
      backend={repositoryBackend}
      busy={runtimeBusy}
      loading={projectManagerLoading}
      error={projectManagerError}
      clearError={() => setProjectManagerError(null)}
      onOpen={openSavedProject}
      onCreate={createManagedProject}
      onRename={renameManagedProject}
      onDuplicate={duplicateManagedProject}
      onDelete={deleteManagedProject}
      onExport={exportManagedProject}
      onImportClick={() => fileInputRef.current?.click()}
    />
    </>
  );
}
