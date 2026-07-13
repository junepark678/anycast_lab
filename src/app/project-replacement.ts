import type {
  AutosaveCoordinator,
  ProjectIdentity,
  ProjectRepository,
} from '../persistence';

interface ReplacePersistedProjectOptions<TProject extends ProjectIdentity> {
  project: TProject;
  disposeRuntime: () => Promise<void>;
  autosave: AutosaveCoordinator<TProject> | null;
  repository: ProjectRepository<TProject>;
  install: (project: TProject) => void;
}

interface ActivatePersistedProjectOptions<TProject extends ProjectIdentity> {
  project: TProject;
  disposeRuntime: () => Promise<void>;
  autosave: AutosaveCoordinator<TProject> | null;
  install: (project: TProject) => void;
  beforeInstall?: () => Promise<void>;
}

/**
 * Switches the active document after fully draining the previous project's
 * runtime and autosave work. The optional durable mutation runs after that
 * drain but before installation, so failures leave the current document
 * installed and cannot be overwritten by a stale pending save.
 */
export async function activatePersistedProject<TProject extends ProjectIdentity>({
  project,
  disposeRuntime,
  autosave,
  install,
  beforeInstall,
}: ActivatePersistedProjectOptions<TProject>): Promise<void> {
  await disposeRuntime();

  if (autosave !== null) {
    await autosave.flush();
    autosave.cancel();
  }

  await beforeInstall?.();
  install(project);
}

/**
 * Replaces a project without allowing an old same-ID autosave to win later.
 *
 * Runtime disposal can take long enough for another editor event to schedule a
 * save. Draining only after disposal closes that window. The imported value is
 * durably stored before it is installed, so a quota or transaction failure
 * leaves the current editor state intact instead of falsely reporting success.
 */
export async function replacePersistedProject<TProject extends ProjectIdentity>({
  project,
  disposeRuntime,
  autosave,
  repository,
  install,
}: ReplacePersistedProjectOptions<TProject>): Promise<void> {
  await activatePersistedProject({
    project,
    disposeRuntime,
    autosave,
    install,
    beforeInstall: async () => { await repository.save(project); },
  });
}

interface ResumeProjectAutosaveOptions<TProject extends ProjectIdentity> {
  project: TProject;
  dirty: boolean;
  booted: boolean;
  autosave: AutosaveCoordinator<TProject> | null;
  rememberProjectId: (projectId: string) => void;
}

/** Reschedules a mutation whose normal effect was suppressed during import. */
export function resumeProjectAutosave<TProject extends ProjectIdentity>({
  project,
  dirty,
  booted,
  autosave,
  rememberProjectId,
}: ResumeProjectAutosaveOptions<TProject>): boolean {
  if (!booted || !dirty || autosave === null) return false;
  autosave.schedule(project);
  rememberProjectId(project.id);
  return true;
}
