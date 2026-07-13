import {
  Download,
  FolderKanban,
  FolderOpen,
  Pause,
  PanelTopClose,
  PanelTopOpen,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { MAX_PROJECT_NAME_LENGTH, validateProjectName } from '../project-management';

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
  onManageProjects: () => void;
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
  const [projectNameDraft, setProjectNameDraft] = useState(props.projectName);
  const skipNameBlurRef = useRef(false);
  const nameAtFocusRef = useRef(props.projectName);

  useEffect(() => { setProjectNameDraft(props.projectName); }, [props.projectName]);

  const commitProjectName = () => {
    const next = projectNameDraft.trim();
    if (next.length === 0) {
      setProjectNameDraft(props.projectName);
      return;
    }
    setProjectNameDraft(next);
    if (next !== props.projectName) props.onProjectNameChange(next);
  };

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
          value={projectNameDraft}
          maxLength={MAX_PROJECT_NAME_LENGTH}
          disabled={props.projectMutationLocked}
          onFocus={() => { nameAtFocusRef.current = props.projectName; }}
          onChange={(event) => {
            const next = event.target.value;
            setProjectNameDraft(next);
            try {
              const validName = validateProjectName(next);
              // Keep leading/trailing whitespace as a local editing draft and
              // only autosave a display-ready value.
              if (validName === next && validName !== props.projectName) {
                props.onProjectNameChange(validName);
              }
            } catch {
              // Blank/invalid transient drafts never reach durable state.
            }
          }}
          onBlur={() => {
            if (skipNameBlurRef.current) {
              skipNameBlurRef.current = false;
              return;
            }
            commitProjectName();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              skipNameBlurRef.current = true;
              commitProjectName();
              event.currentTarget.blur();
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              skipNameBlurRef.current = true;
              const previousName = nameAtFocusRef.current;
              setProjectNameDraft(previousName);
              if (previousName !== projectNameDraft) props.onProjectNameChange(previousName);
              event.currentTarget.blur();
            }
          }}
        />
        <button
          type="button"
          className="icon-button project-manager-trigger"
          aria-label="Manage projects"
          title={props.persistenceReady ? 'Manage projects' : 'Preparing local storage…'}
          disabled={!props.persistenceReady || props.runtimeBusy}
          onClick={props.onManageProjects}
        ><FolderKanban size={16} /></button>
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
