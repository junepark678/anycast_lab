/**
 * The small structural surface persistence needs from a lab project.
 *
 * Keeping the repository generic means migrations can still load an older
 * document before it satisfies the current `LabProject` type.
 */
export interface ProjectIdentity {
  id: string;
  name: string;
  schemaVersion?: number;
}

export interface StoredProject<TProject extends ProjectIdentity> {
  project: TProject;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  schemaVersion: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface SaveProjectOptions {
  /**
   * Enables optimistic concurrency. Saving fails if the stored revision no
   * longer matches this value. Omit it for last-writer-wins autosave.
   */
  expectedRevision?: number;
}

export interface ProjectRepository<TProject extends ProjectIdentity> {
  readonly backend: 'indexeddb' | 'memory';

  get(id: string): Promise<StoredProject<TProject> | undefined>;
  list(): Promise<ProjectSummary[]>;
  save(
    project: TProject,
    options?: SaveProjectOptions,
  ): Promise<StoredProject<TProject>>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
  close(): void;
}

export type ProjectMigrator<TProject extends ProjectIdentity> = (
  document: unknown,
) => TProject;
