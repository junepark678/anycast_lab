import {
  Check,
  Copy,
  Download,
  FilePlus2,
  FolderOpen,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { ProjectSummary } from '../../persistence/types';
import {
  filterProjectSummaries,
  MAX_PROJECT_NAME_LENGTH,
  validateProjectName,
} from '../project-management';
import { ModalDialog } from './ModalDialog';

export type ProjectTemplate = 'blank' | 'demo';

export interface ProjectManagerProps {
  open: boolean;
  onClose: () => void;
  projects: ProjectSummary[];
  activeProjectId: string | null;
  backend: 'indexeddb' | 'memory';
  busy: boolean;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  onOpen: (id: string) => Promise<boolean>;
  onCreate: (template: ProjectTemplate, name: string) => Promise<boolean>;
  onRename: (id: string, name: string) => Promise<boolean>;
  onDuplicate: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onExport: (id: string) => Promise<boolean>;
  onImportClick: () => void;
}

function formatModified(timestamp: number): { label: string; exact: string; iso: string } {
  const date = new Date(timestamp);
  if (!Number.isFinite(timestamp) || Number.isNaN(date.getTime())) {
    return { label: 'Modified time unavailable', exact: '', iso: '' };
  }

  const deltaSeconds = Math.round((timestamp - Date.now()) / 1000);
  const ranges: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const range = ranges.find(([, seconds]) => Math.abs(deltaSeconds) >= seconds);
  const label = range
    ? formatter.format(Math.round(deltaSeconds / range[1]), range[0])
    : 'just now';

  return {
    label: `Modified ${label}`,
    exact: date.toLocaleString(),
    iso: date.toISOString(),
  };
}

function projectNameValidation(input: string): { name: string; error: null } | { name: ''; error: string } {
  try {
    return { name: validateProjectName(input), error: null };
  } catch (error) {
    return {
      name: '',
      error: error instanceof Error ? error.message : 'Enter a valid project name.',
    };
  }
}

export function ProjectManager({
  open,
  onClose,
  projects,
  activeProjectId,
  backend,
  busy,
  loading,
  error,
  clearError,
  onOpen,
  onCreate,
  onRename,
  onDuplicate,
  onDelete,
  onExport,
  onImportClick,
}: ProjectManagerProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteReturnFocusRef = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState('');
  const [template, setTemplate] = useState<ProjectTemplate>('demo');
  const [newName, setNewName] = useState('');
  const [createSubmitted, setCreateSubmitted] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const isBusy = busy || pendingAction !== null;

  useEffect(() => {
    if (open) return;
    setRenamingId(null);
    setDeleteId(null);
    setPendingAction(null);
    setLocalError(null);
    setCreateSubmitted(false);
  }, [open]);

  useEffect(() => {
    if (renamingId) renameRef.current?.focus();
  }, [renamingId]);

  useEffect(() => {
    if (deleteId) {
      deleteCancelRef.current?.focus();
    } else if (deleteReturnFocusRef.current?.isConnected) {
      deleteReturnFocusRef.current.focus();
    }
  }, [deleteId]);

  const filteredProjects = useMemo(
    () => filterProjectSummaries(projects, query),
    [projects, query],
  );
  const visibleError = localError ?? error;
  const newNameValidation = projectNameValidation(newName);

  const dismissError = () => {
    setLocalError(null);
    clearError();
  };

  const runAction = async (
    key: string,
    action: () => Promise<boolean>,
    onSuccess?: () => void,
  ) => {
    if (isBusy) return;
    dismissError();
    setPendingAction(key);
    try {
      if (await action()) onSuccess?.();
    } catch {
      setLocalError('That project action could not be completed. Please try again.');
    } finally {
      setPendingAction(null);
    }
  };

  const submitCreate = (event: FormEvent) => {
    event.preventDefault();
    setCreateSubmitted(true);
    if (newNameValidation.error) return;
    void runAction('create', () => onCreate(template, newNameValidation.name), () => {
      setNewName('');
      setCreateSubmitted(false);
      onClose();
    });
  };

  const beginRename = (project: ProjectSummary) => {
    setDeleteId(null);
    setRenamingId(project.id);
    setRenameName(project.name);
  };

  const submitRename = (event: FormEvent, id: string) => {
    event.preventDefault();
    const validation = projectNameValidation(renameName);
    if (validation.error) return;
    void runAction(`rename:${id}`, () => onRename(id, validation.name), () => setRenamingId(null));
  };

  return (
    <ModalDialog
      open={open}
      title="Projects"
      description="Create, open, and manage labs saved in this browser."
      className="project-manager"
      initialFocusRef={searchRef}
      busy={isBusy}
      onClose={onClose}
    >
      {backend === 'memory' && (
        <div className="project-manager__storage-notice" role="status">
          Local storage is unavailable. Projects in this session will be lost when this tab closes.
        </div>
      )}

      {visibleError && (
        <div className="project-manager__error" role="alert">
          <span>{visibleError}</span>
          <button type="button" aria-label="Dismiss project error" onClick={dismissError}>
            <X size={15} />
          </button>
        </div>
      )}

      <div className="project-manager__layout">
        <section className="project-manager__projects" aria-labelledby="recent-projects-heading">
          <div className="project-manager__section-heading">
            <span>
              <h3 id="recent-projects-heading">Recent projects</h3>
              <small>{projects.length} {projects.length === 1 ? 'project' : 'projects'}</small>
            </span>
            <button
              type="button"
              className="button button--secondary project-manager__import"
              disabled={isBusy || loading}
              onClick={() => {
                onImportClick();
                onClose();
              }}
            >
              <Upload size={14} /> Import
            </button>
          </div>

          <label className="project-manager__search">
            <Search size={15} />
            <span className="visually-hidden">Search projects</span>
            <input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search projects"
              disabled={loading}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>

          <div className="project-manager__list-wrap" aria-busy={loading || undefined}>
            {loading ? (
              <div className="project-manager__empty" role="status">Loading projects…</div>
            ) : filteredProjects.length === 0 ? (
              <div className="project-manager__empty">
                <FolderOpen size={24} />
                <strong>{projects.length === 0 ? 'No saved projects yet' : 'No matching projects'}</strong>
                <span>{projects.length === 0 ? 'Create a lab or import an existing project.' : 'Try a different search.'}</span>
              </div>
            ) : (
              <ul className="project-manager__list">
                {filteredProjects.map((project) => {
                  const modified = formatModified(project.updatedAt);
                  const isCurrent = project.id === activeProjectId;
                  const isRenaming = project.id === renamingId;
                  const renameValidation = projectNameValidation(renameName);
                  return (
                    <li key={project.id} className={isCurrent ? 'project-row is-current' : 'project-row'}>
                      <div className="project-row__main">
                        {isRenaming ? (
                          <form className="project-row__rename" onSubmit={(event) => submitRename(event, project.id)}>
                            <label>
                              <span className="visually-hidden">New name for {project.name}</span>
                              <input
                                ref={renameRef}
                                value={renameName}
                                maxLength={MAX_PROJECT_NAME_LENGTH}
                                disabled={isBusy}
                                aria-invalid={renameValidation.error ? 'true' : undefined}
                                aria-describedby={renameValidation.error ? `rename-project-name-error-${project.id}` : undefined}
                                onChange={(event) => setRenameName(event.target.value)}
                              />
                            </label>
                            <button
                              type="submit"
                              aria-label={`Save name for ${project.name}`}
                              disabled={isBusy || Boolean(renameValidation.error)}
                            ><Check size={15} /></button>
                            <button
                              type="button"
                              aria-label={`Cancel renaming ${project.name}`}
                              disabled={isBusy}
                              onClick={() => setRenamingId(null)}
                            ><X size={15} /></button>
                            {renameValidation.error && <small id={`rename-project-name-error-${project.id}`} className="project-row__rename-error">{renameValidation.error}</small>}
                          </form>
                        ) : (
                          <button
                            type="button"
                            className="project-row__open"
                            disabled={isBusy || isCurrent}
                            aria-label={isCurrent ? `${project.name}, current project` : `Open ${project.name}`}
                            onClick={() => void runAction(`open:${project.id}`, () => onOpen(project.id), onClose)}
                          >
                            <span className="project-row__title">
                              <strong>{project.name}</strong>
                              {isCurrent && <i>Current</i>}
                            </span>
                            <span className="project-row__meta">
                              <time dateTime={modified.iso || undefined} title={modified.exact}>{modified.label}</time>
                              <span>Revision {project.revision}</span>
                            </span>
                          </button>
                        )}
                      </div>

                      {!isRenaming && (
                        <div className="project-row__actions" role="group" aria-label={`Actions for ${project.name}`}>
                          <button type="button" disabled={isBusy} aria-label={`Rename ${project.name}`} title="Rename" onClick={() => beginRename(project)}><Pencil size={14} /></button>
                          <button type="button" disabled={isBusy} aria-label={`Duplicate ${project.name}`} title="Duplicate" onClick={() => void runAction(`duplicate:${project.id}`, () => onDuplicate(project.id))}><Copy size={14} /></button>
                          <button type="button" disabled={isBusy} aria-label={`Export ${project.name}`} title="Export" onClick={() => void runAction(`export:${project.id}`, () => onExport(project.id))}><Download size={14} /></button>
                          <button
                            type="button"
                            className="project-row__delete"
                            disabled={isBusy}
                            aria-label={`Delete ${project.name}`}
                            title="Delete"
                            onClick={(event) => {
                              deleteReturnFocusRef.current = event.currentTarget;
                              setRenamingId(null);
                              setDeleteId(project.id);
                            }}
                          ><Trash2 size={14} /></button>
                        </div>
                      )}

                      {deleteId === project.id && (
                        <div className="project-row__confirmation" role="group" aria-live="polite" aria-label={`Delete ${project.name}?`}>
                          <span><strong>Delete “{project.name}”?</strong> This cannot be undone.</span>
                          <span>
                            <button ref={deleteCancelRef} type="button" className="button button--secondary" disabled={isBusy} onClick={() => setDeleteId(null)}>Cancel</button>
                            <button type="button" className="button button--danger" disabled={isBusy} onClick={() => void runAction(`delete:${project.id}`, () => onDelete(project.id), () => setDeleteId(null))}>Delete</button>
                          </span>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="project-manager__new" aria-labelledby="new-project-heading">
          <div className="project-manager__section-heading">
            <span>
              <h3 id="new-project-heading">New project</h3>
              <small>Start from a template</small>
            </span>
          </div>
          <form className="project-manager__create-form" onSubmit={submitCreate}>
            <fieldset disabled={isBusy || loading}>
              <legend className="visually-hidden">Project template</legend>
              <label className={template === 'demo' ? 'project-template is-selected' : 'project-template'}>
                <input type="radio" name="project-template" value="demo" checked={template === 'demo'} onChange={() => setTemplate('demo')} />
                <span><strong>Anycast demo</strong><small>A working multi-PoP topology with BGP configs.</small></span>
              </label>
              <label className={template === 'blank' ? 'project-template is-selected' : 'project-template'}>
                <input type="radio" name="project-template" value="blank" checked={template === 'blank'} onChange={() => setTemplate('blank')} />
                <span><strong>Blank lab</strong><small>An empty canvas for your own topology.</small></span>
              </label>
            </fieldset>

            <label className="project-manager__name">
              <span>Project name</span>
              <input
                value={newName}
                maxLength={MAX_PROJECT_NAME_LENGTH}
                placeholder="My anycast lab"
                disabled={isBusy || loading}
                aria-invalid={createSubmitted && newNameValidation.error ? 'true' : undefined}
                aria-describedby={createSubmitted && newNameValidation.error ? 'new-project-name-error' : undefined}
                onChange={(event) => setNewName(event.target.value)}
              />
              {createSubmitted && newNameValidation.error && <small id="new-project-name-error" className="project-manager__field-error">{newNameValidation.error}</small>}
            </label>

            <button type="submit" className="button button--run button--wide" disabled={isBusy || loading || Boolean(newNameValidation.error)}>
              <FilePlus2 size={15} />
              {pendingAction === 'create' ? 'Creating…' : 'Create project'}
            </button>
          </form>
        </section>
      </div>
    </ModalDialog>
  );
}
