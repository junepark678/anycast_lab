import {
  type ApplianceFidelity,
  type ApplianceKind,
  type ApplianceRuntime,
  type ApplianceRuntimeDescriptor,
  assertCompatibleDescriptor,
} from './abi';

export interface ApplianceRuntimeFactory {
  readonly descriptor: ApplianceRuntimeDescriptor;
  create(): ApplianceRuntime;
}

export interface ApplianceRuntimeSelector {
  readonly kind: ApplianceKind;
  readonly runtimeId?: string;
  readonly upstreamVersion?: string;
  /**
   * Compatibility implementations are never selected unless this is true.
   * Callers should surface the descriptor limitations before opting in.
   */
  readonly allowCompatibility?: boolean;
}

function compareFactories(a: ApplianceRuntimeFactory, b: ApplianceRuntimeFactory): number {
  if (a.descriptor.fidelity !== b.descriptor.fidelity) {
    return a.descriptor.fidelity === 'native' ? -1 : 1;
  }

  return a.descriptor.runtimeId.localeCompare(b.descriptor.runtimeId);
}

export class ApplianceRuntimeRegistry {
  readonly #factories = new Map<string, ApplianceRuntimeFactory>();

  register(factory: ApplianceRuntimeFactory): () => void {
    assertCompatibleDescriptor(factory.descriptor);

    if (this.#factories.has(factory.descriptor.runtimeId)) {
      throw new Error(`Appliance runtime already registered: ${factory.descriptor.runtimeId}`);
    }

    this.#factories.set(factory.descriptor.runtimeId, factory);
    return () => {
      if (this.#factories.get(factory.descriptor.runtimeId) === factory) {
        this.#factories.delete(factory.descriptor.runtimeId);
      }
    };
  }

  list(options: { fidelity?: ApplianceFidelity; kind?: ApplianceKind } = {}): readonly ApplianceRuntimeDescriptor[] {
    return [...this.#factories.values()]
      .filter(({ descriptor }) => options.fidelity === undefined || descriptor.fidelity === options.fidelity)
      .filter(({ descriptor }) => options.kind === undefined || descriptor.kind === options.kind)
      .sort(compareFactories)
      .map(({ descriptor }) => descriptor);
  }

  resolve(selector: ApplianceRuntimeSelector): ApplianceRuntimeFactory {
    const candidates = [...this.#factories.values()]
      .filter(({ descriptor }) => descriptor.kind === selector.kind)
      .filter(({ descriptor }) => selector.runtimeId === undefined || descriptor.runtimeId === selector.runtimeId)
      .filter(
        ({ descriptor }) =>
          selector.upstreamVersion === undefined || descriptor.upstreamVersion === selector.upstreamVersion,
      )
      .filter(
        ({ descriptor }) => descriptor.fidelity === 'native' || selector.allowCompatibility === true,
      )
      .sort(compareFactories);

    const selected = candidates[0];
    if (selected !== undefined) {
      return selected;
    }

    const compatibilityExists = [...this.#factories.values()].some(
      ({ descriptor }) =>
        descriptor.kind === selector.kind &&
        descriptor.fidelity === 'compatibility' &&
        (selector.runtimeId === undefined || descriptor.runtimeId === selector.runtimeId),
    );

    const compatibilityHint =
      compatibilityExists && selector.allowCompatibility !== true
        ? ' A compatibility runtime exists, but must be enabled explicitly with allowCompatibility: true.'
        : '';

    throw new Error(
      `No appliance runtime matches kind=${selector.kind}` +
        (selector.runtimeId === undefined ? '' : ` runtimeId=${selector.runtimeId}`) +
        (selector.upstreamVersion === undefined ? '' : ` upstreamVersion=${selector.upstreamVersion}`) +
        `.${compatibilityHint}`,
    );
  }

  create(selector: ApplianceRuntimeSelector): ApplianceRuntime {
    const factory = this.resolve(selector);
    const runtime = factory.create();

    if (runtime.descriptor.runtimeId !== factory.descriptor.runtimeId) {
      throw new Error(
        `Factory ${factory.descriptor.runtimeId} created mismatched runtime ${runtime.descriptor.runtimeId}`,
      );
    }

    assertCompatibleDescriptor(runtime.descriptor);
    return runtime;
  }
}
