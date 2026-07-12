import { expect, it } from 'vitest';
import * as publicApi from './index';

it('publishes only the shared-v86 factory for the current ANYCASTLAB/2 image', () => {
  expect(publicApi).toHaveProperty('createSharedV86RuntimeFactories');
  expect(publicApi).not.toHaveProperty('createV86RuntimeFactory');
  expect(publicApi).not.toHaveProperty('createV86RuntimeFactories');
  expect(publicApi).not.toHaveProperty('V86ApplianceRuntime');
});
