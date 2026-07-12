import {
  Download,
  FolderOpen,
  Pause,
  PanelTopClose,
  PanelTopOpen,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import type { ChangeEvent, RefObject } from 'react';

interface Props {
  projectName: string;
  running: boolean;
  runtimeBusy: boolean;
  projectMutationLocked: boolean;
  persistenceReady: boolean;
  dirty: boolean;
  saveState: 'saved' | 'saving' | 'error';
  runtimeMode: 'simulation' | 'native';
  nativeRuntimeState: 'loading' | 'available' | 'unavailable';
  nativeRuntimeDetail: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onProjectNameChange: (name: string) => void;
  onRuntimeModeChange: (mode: 'simulation' | 'native') => void;
  onRunToggle: () => void;
  onReset: () => void;
  onSave: () => void;
  onExport: () => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
  collapsed?: boolean;
  embedded?: boolean;
  onToggleCollapsed?: () => void;
}

export function LabHeader(props: Props) {
  const collapsed = props.collapsed ?? false;
  return (
    <header className={`lab-header${collapsed ? ' is-toolbar-collapsed' : ''}`}>
      <a
        className="brand"
        href={props.embedded ? '/lab/about/' : '/'}
        target={props.embedded ? '_top' : undefined}
        title={props.embedded ? 'Back to the Anycast Lab guide' : 'Back to anycast.guide'}
      >
        <span className="brand__mark">A</span>
        <span><strong>anycast</strong><em>lab</em></span>
        {props.embedded && <i className="brand__guide-badge">guide</i>}
      </a>
      <div className="project-name">
        <input
          aria-label="Project name"
          value={props.projectName}
          disabled={props.projectMutationLocked}
          onChange={(event) => props.onProjectNameChange(event.target.value)}
        />
        <span className={`save-state save-state--${props.saveState}`}>
          {props.saveState === 'saving' ? 'Saving…' : props.saveState === 'error' ? 'Save failed' : props.dirty ? 'Unsaved' : 'Saved locally'}
        </span>
      </div>
      <button
        type="button"
        disabled={props.runtimeBusy}
        className={props.running ? 'button button--stop lab-header__run' : 'button button--run lab-header__run'}
        onClick={props.onRunToggle}
        data-guide-target="run"
      >
        {props.running ? <Pause size={16} /> : <Play size={16} />}
        {props.runtimeBusy ? 'Working…' : props.running ? 'Pause' : 'Run'}
      </button>
      <div className="lab-header__actions" id="workspace-toolbar-actions" role="toolbar" aria-label="Workspace actions">
        <div className="runtime-mode" role="radiogroup" aria-label="Runtime mode" data-guide-target="runtime">
          <button
            type="button"
            role="radio"
            aria-checked={props.runtimeMode === 'simulation'}
            className={props.runtimeMode === 'simulation' ? 'is-active' : ''}
            disabled={props.running || props.runtimeBusy}
            onClick={() => props.onRuntimeModeChange('simulation')}
            title="Fast deterministic compatibility engine"
          >SIM</button>
          <button
            type="button"
            role="radio"
            aria-checked={props.runtimeMode === 'native'}
            className={props.runtimeMode === 'native' ? 'is-active runtime-mode__native' : 'runtime-mode__native'}
            disabled={props.running || props.runtimeBusy || props.nativeRuntimeState !== 'available'}
            onClick={() => props.onRuntimeModeChange('native')}
            title={props.nativeRuntimeDetail}
          >{props.nativeRuntimeState === 'loading' ? 'VM…' : 'NATIVE VM'}</button>
        </div>
        <button type="button" disabled={props.runtimeBusy} className="icon-button" title="Reset runtime" onClick={props.onReset}><RotateCcw size={17} /></button>
        <span className="toolbar-divider" />
        <button type="button" disabled={props.runtimeBusy || !props.persistenceReady} className="icon-button" title={props.persistenceReady ? 'Save now' : 'Preparing local storage…'} onClick={props.onSave}><Save size={17} /></button>
        <button type="button" disabled={props.runtimeBusy || !props.persistenceReady} className="icon-button" title={props.persistenceReady ? 'Import project' : 'Preparing local storage…'} onClick={() => props.fileInputRef.current?.click()}><FolderOpen size={17} /></button>
        <input ref={props.fileInputRef} disabled={props.runtimeBusy || !props.persistenceReady} className="visually-hidden" type="file" accept=".anycastlab,.zip,application/zip" onChange={props.onImport} />
        <button type="button" disabled={props.runtimeBusy} className="button button--secondary" onClick={props.onExport} data-guide-target="export"><Download size={16} /> Export</button>
        <a className="icon-button" href="https://github.com/junepark678/anycast_lab" target="_blank" rel="noreferrer" aria-label="Source code and AGPL license" title="Source code · AGPL-3.0 · no warranty"><ShieldCheck size={17} /></a>
      </div>
      <button
        type="button"
        className="icon-button lab-header__toggle"
        aria-label={collapsed ? 'Expand workspace toolbar' : 'Collapse workspace toolbar'}
        aria-expanded={!collapsed}
        aria-controls="workspace-toolbar-actions"
        title={collapsed ? 'Expand workspace toolbar' : 'Collapse workspace toolbar'}
        onClick={props.onToggleCollapsed}
      >
        {collapsed ? <PanelTopOpen size={17} /> : <PanelTopClose size={17} />}
      </button>
    </header>
  );
}
