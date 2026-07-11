import type {
  ProjectIdentity,
  ProjectRepository,
  StoredProject,
} from './types';
import { cloneProjectValue } from './value';

export type AutosaveStatus =
  | 'idle'
  | 'scheduled'
  | 'saving'
  | 'saved'
  | 'error'
  | 'disposed';

export interface AutosaveState {
  status: AutosaveStatus;
  dirty: boolean;
  projectId?: string;
  revision?: number;
  lastSavedAt?: number;
  error?: unknown;
}

export interface AutosaveCoordinatorOptions<
  TProject extends ProjectIdentity,
> {
  repository: ProjectRepository<TProject>;
  delayMs?: number;
  onStateChange?: (state: Readonly<AutosaveState>) => void;
  onSaved?: (stored: Readonly<StoredProject<TProject>>) => void;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
}

/**
 * Coalesces editor updates and serializes writes. If another edit arrives while
 * a save is in flight, the latest snapshot is saved immediately afterwards.
 */
export class AutosaveCoordinator<TProject extends ProjectIdentity> {
  private readonly repository: ProjectRepository<TProject>;
  private readonly delayMs: number;
  private readonly onStateChange?: (
    state: Readonly<AutosaveState>,
  ) => void;
  private readonly onSaved?: (
    stored: Readonly<StoredProject<TProject>>,
  ) => void;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  private pending?: TProject;
  private timer?: ReturnType<typeof setTimeout>;
  private drainPromise?: Promise<StoredProject<TProject> | undefined>;
  private disposed = false;
  private state: AutosaveState = { status: 'idle', dirty: false };

  constructor(options: AutosaveCoordinatorOptions<TProject>) {
    if (!Number.isFinite(options.delayMs ?? 600) || (options.delayMs ?? 600) < 0) {
      throw new RangeError('Autosave delay must be a non-negative number');
    }

    this.repository = options.repository;
    this.delayMs = options.delayMs ?? 600;
    this.onStateChange = options.onStateChange;
    this.onSaved = options.onSaved;
    // Browser timer functions require their global receiver. Keeping the raw
    // function as an instance property would invoke it with `this` set to the
    // coordinator and throws "Illegal invocation" in Chromium.
    this.setTimer = options.setTimer ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimer = options.clearTimer ?? globalThis.clearTimeout.bind(globalThis);
  }

  getState(): Readonly<AutosaveState> {
    return { ...this.state };
  }

  schedule(project: TProject): void {
    this.assertActive();
    this.pending = cloneProjectValue(project);
    this.cancelTimer();

    this.updateState({
      status: this.drainPromise === undefined ? 'scheduled' : 'saving',
      dirty: true,
      projectId: project.id,
      error: undefined,
    });

    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.flush().catch(() => {
        // The error is observable through state/onStateChange. Avoid an
        // unhandled rejection for timer-triggered saves.
      });
    }, this.delayMs);
  }

  async flush(): Promise<StoredProject<TProject> | undefined> {
    this.assertActive();
    this.cancelTimer();

    if (this.drainPromise !== undefined) {
      let inFlightResult: StoredProject<TProject> | undefined;
      try {
        inFlightResult = await this.drainPromise;
      } catch {
        // A newer pending snapshot is allowed to recover from an earlier save
        // failure. With no newer snapshot, rethrow through the next branch.
      }
      if (this.pending === undefined) {
        if (this.state.status === 'error') {
          throw this.state.error;
        }
        return inFlightResult;
      }
    }

    if (this.pending === undefined) {
      return undefined;
    }

    const running = this.drain();
    this.drainPromise = running;
    try {
      return await running;
    } finally {
      if (this.drainPromise === running) {
        this.drainPromise = undefined;
      }
    }
  }

  cancel(): void {
    this.assertActive();
    this.cancelTimer();
    this.pending = undefined;
    this.updateState({
      status: 'idle',
      dirty: false,
      error: undefined,
    });
  }

  async dispose(options: { flush?: boolean } = {}): Promise<void> {
    if (this.disposed) {
      return;
    }

    if (options.flush ?? true) {
      await this.flush();
    } else {
      this.cancelTimer();
      this.pending = undefined;
    }

    this.disposed = true;
    this.updateState({ status: 'disposed', dirty: false });
  }

  private async drain(): Promise<StoredProject<TProject> | undefined> {
    let lastSaved: StoredProject<TProject> | undefined;

    while (this.pending !== undefined) {
      const snapshot = this.pending;
      this.pending = undefined;
      this.updateState({
        status: 'saving',
        dirty: false,
        projectId: snapshot.id,
        error: undefined,
      });

      try {
        lastSaved = await this.repository.save(snapshot);
        this.onSaved?.(cloneProjectValue(lastSaved));
      } catch (error) {
        // Keep the failed snapshot unless a newer edit already superseded it.
        this.pending ??= snapshot;
        this.updateState({
          status: 'error',
          dirty: true,
          projectId: snapshot.id,
          error,
        });
        throw error;
      }
    }

    if (lastSaved !== undefined) {
      this.updateState({
        status: 'saved',
        dirty: false,
        projectId: lastSaved.project.id,
        revision: lastSaved.revision,
        lastSavedAt: lastSaved.updatedAt,
        error: undefined,
      });
    }
    return lastSaved;
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private updateState(patch: Partial<AutosaveState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange?.({ ...this.state });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Autosave coordinator has been disposed');
    }
  }
}
