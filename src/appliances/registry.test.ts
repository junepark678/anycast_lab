import { describe, expect, it } from 'vitest';
import {
  APPLIANCE_HOST_ABI_VERSION,
  APPLIANCE_RUNTIME_API_VERSION,
  type ApplianceRuntimeDescriptor,
} from './abi';
import {
  BIRD_COMPATIBILITY_RUNTIME_DESCRIPTOR,
  birdCompatibilityRuntimeFactory,
} from './mock/compatibility-runtime';
import { ApplianceRuntimeRegistry, type ApplianceRuntimeFactory } from './registry';

describe('ApplianceRuntimeRegistry', () => {
  it('registers, lists, and unregisters a runtime deterministically', () => {
    const registry = new ApplianceRuntimeRegistry();
    const unregister = registry.register(birdCompatibilityRuntimeFactory);

    expect(registry.list()).toEqual([BIRD_COMPATIBILITY_RUNTIME_DESCRIPTOR]);
    unregister();
    expect(registry.list()).toEqual([]);
  });

  it('rejects duplicate runtime IDs', () => {
    const registry = new ApplianceRuntimeRegistry();
    registry.register(birdCompatibilityRuntimeFactory);

    expect(() => registry.register(birdCompatibilityRuntimeFactory)).toThrow(
      'Appliance runtime already registered',
    );
  });

  it('never silently selects a compatibility runtime', () => {
    const registry = new ApplianceRuntimeRegistry();
    registry.register(birdCompatibilityRuntimeFactory);

    expect(() => registry.resolve({ kind: 'bird' })).toThrow(
      'must be enabled explicitly with allowCompatibility: true',
    );

    expect(
      registry.resolve({ kind: 'bird', allowCompatibility: true }).descriptor.fidelity,
    ).toBe('compatibility');
  });

  it('can instantiate the compatibility runtime only after explicit opt-in', () => {
    const registry = new ApplianceRuntimeRegistry();
    registry.register(birdCompatibilityRuntimeFactory);

    const runtime = registry.create({
      kind: 'bird',
      runtimeId: BIRD_COMPATIBILITY_RUNTIME_DESCRIPTOR.runtimeId,
      allowCompatibility: true,
    });

    expect(runtime.descriptor.runtimeId).toBe(BIRD_COMPATIBILITY_RUNTIME_DESCRIPTOR.runtimeId);
    expect(runtime.state).toBe('new');
  });

  it('rejects factories compiled for another host ABI', () => {
    const registry = new ApplianceRuntimeRegistry();
    const incompatibleDescriptor = {
      ...BIRD_COMPATIBILITY_RUNTIME_DESCRIPTOR,
      runtimeId: 'future-runtime',
      hostAbiVersion: 2,
      runtimeApiVersion: APPLIANCE_RUNTIME_API_VERSION,
    } as unknown as ApplianceRuntimeDescriptor;
    const factory = {
      descriptor: incompatibleDescriptor,
      create: birdCompatibilityRuntimeFactory.create,
    } satisfies ApplianceRuntimeFactory;

    expect(() => registry.register(factory)).toThrow(
      `uses host ABI 2; this build requires ${APPLIANCE_HOST_ABI_VERSION}`,
    );
  });
});
