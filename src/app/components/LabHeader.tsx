import {
  BookOpen,
  Check,
  Download,
  ExternalLink,
  FolderKanban,
  FolderOpen,
  Pause,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelTopClose,
  PanelTopOpen,
  Pencil,
  Play,
  RotateCcw,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { MAX_PROJECT_NAME_LENGTH, validateProjectName } from '../project-management';
import { LabMenuBar, type LabMenuDefinition } from './LabMenuBar';

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
  selectionType: 'node' | 'link' | null;
  paletteCollapsed: boolean;
  detailsCollapsed: boolean;
  onDeleteSelection: () => void;
  onTogglePalette: () => void;
  onToggleDetails: () => void;
  onResetWorkspace: () => void;
  collapsed?: boolean;
  embedded?: boolean;
  onToggleCollapsed?: () => void;
}

export function LabHeader(props: Props) {
  const collapsed = props.collapsed ?? false;
  const [projectNameDraft, setProjectNameDraft] = useState(props.projectName);
  const skipNameBlurRef = useRef(false);
  const nameAtFocusRef = useRef(props.projectName);
  const projectNameInputRef = useRef<HTMLInputElement>(null);

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

  const menus: LabMenuDefinition[] = [
    {
      id: 'file',
      label: 'File',
      entries: [
        {
          id: 'manage-projects',
          label: 'Manage projects…',
          icon: <FolderKanban size={15} />,
          disabled: !props.persistenceReady || props.runtimeBusy,
          onSelect: props.onManageProjects,
        },
        {
          id: 'save',
          label: 'Save now',
          icon: <Save size={15} />,
          shortcut: 'Ctrl+S',
          disabled: !props.persistenceReady || props.runtimeBusy,
          onSelect: props.onSave,
        },
        { type: 'separator', id: 'file-transfer-separator' },
        {
          id: 'import',
          label: 'Import project…',
          icon: <FolderOpen size={15} />,
          shortcut: 'Ctrl+O',
          disabled: !props.persistenceReady || props.runtimeBusy,
          onSelect: () => props.fileInputRef.current?.click(),
        },
        {
          id: 'export',
          label: 'Export project…',
          icon: <Download size={15} />,
          disabled: props.runtimeBusy,
          onSelect: props.onExport,
        },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      entries: [
        {
          id: 'rename-project',
          label: 'Rename project',
          icon: <Pencil size={15} />,
          disabled: props.projectMutationLocked,
          onSelect: () => {
            projectNameInputRef.current?.focus();
            projectNameInputRef.current?.select();
          },
        },
        {
          id: 'delete-selection',
          label: props.selectionType ? `Delete selected ${props.selectionType}` : 'Delete selection',
          icon: <Trash2 size={15} />,
          shortcut: 'Delete',
          disabled: props.selectionType === null || props.projectMutationLocked,
          tone: 'danger',
          onSelect: props.onDeleteSelection,
        },
      ],
    },
    {
      id: 'view',
      label: 'View',
      entries: [
        {
          id: 'toggle-palette',
          label: props.paletteCollapsed ? 'Show appliance palette' : 'Hide appliance palette',
          icon: props.paletteCollapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />,
          onSelect: props.onTogglePalette,
        },
        {
          id: 'toggle-details',
          label: props.detailsCollapsed ? 'Show details panel' : 'Hide details panel',
          icon: props.detailsCollapsed ? <PanelRightOpen size={15} /> : <PanelRightClose size={15} />,
          onSelect: props.onToggleDetails,
        },
        {
          id: 'toggle-toolbar',
          label: collapsed ? 'Show workspace toolbar' : 'Hide workspace toolbar',
          icon: collapsed ? <PanelTopOpen size={15} /> : <PanelTopClose size={15} />,
          onSelect: () => props.onToggleCollapsed?.(),
        },
        { type: 'separator', id: 'view-reset-separator' },
        {
          id: 'reset-workspace',
          label: 'Reset workspace layout',
          icon: <RotateCcw size={15} />,
          onSelect: props.onResetWorkspace,
        },
      ],
    },
    {
      id: 'run',
      label: 'Run',
      entries: [
        {
          id: 'run-toggle',
          label: props.running ? 'Pause lab' : 'Run lab',
          icon: props.running ? <Pause size={15} /> : <Play size={15} />,
          disabled: props.runtimeBusy,
          onSelect: props.onRunToggle,
        },
        {
          id: 'reset-runtime',
          label: 'Reset runtime',
          icon: <RotateCcw size={15} />,
          disabled: props.runtimeBusy,
          onSelect: props.onReset,
        },
        { type: 'separator', id: 'runtime-mode-separator' },
        {
          id: 'simulation-mode',
          label: props.runtimeMode === 'simulation' ? 'Simulation mode (current)' : 'Use simulation mode',
          icon: props.runtimeMode === 'simulation' ? <Check size={15} /> : undefined,
          disabled: props.running || props.runtimeBusy,
          onSelect: () => props.onRuntimeModeChange('simulation'),
        },
        {
          id: 'native-mode',
          label: props.runtimeMode === 'native' ? 'Native VM mode (current)' : 'Use native VM mode',
          icon: props.runtimeMode === 'native' ? <Check size={15} /> : undefined,
          disabled: props.running || props.runtimeBusy || props.nativeRuntimeState !== 'available',
          onSelect: () => props.onRuntimeModeChange('native'),
        },
      ],
    },
    {
      id: 'help',
      label: 'Help',
      entries: [
        {
          id: 'lab-guide',
          label: 'Anycast Lab guide',
          icon: <BookOpen size={15} />,
          onSelect: () => { window.open('https://anycast.guide/lab/about/', '_blank', 'noopener,noreferrer'); },
        },
        {
          id: 'source',
          label: 'Source code and license',
          icon: <ExternalLink size={15} />,
          onSelect: () => { window.open('https://github.com/junepark678/anycast_lab', '_blank', 'noopener,noreferrer'); },
        },
      ],
    },
  ];

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
      <LabMenuBar menus={menus} ariaLabel="Application menu" />
      <div className="project-name">
        <input
          ref={projectNameInputRef}
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
