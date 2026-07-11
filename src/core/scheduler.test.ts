import { describe, expect, it } from 'vitest';
import { DeterministicScheduler, SeededRandom } from './scheduler';

describe('deterministic scheduler', () => {
  it('orders equal-time events by insertion and supports cancellation', () => {
    const scheduler = new DeterministicScheduler();
    const calls: string[] = [];
    scheduler.scheduleAt(10, () => calls.push('first'));
    const cancelled = scheduler.scheduleAt(5, () => calls.push('cancelled'));
    scheduler.scheduleAt(10, () => calls.push('second'));
    expect(scheduler.cancel(cancelled)).toBe(true);
    expect(scheduler.runUntilIdle()).toBe(2);
    expect(calls).toEqual(['first', 'second']);
    expect(scheduler.nowMs).toBe(10);
  });

  it('will not travel backwards or accept negative delays', () => {
    const scheduler = new DeterministicScheduler();
    scheduler.runUntil(10);
    expect(() => scheduler.runUntil(9)).toThrow(/backwards/);
    expect(() => scheduler.scheduleIn(-1, () => undefined)).toThrow(/non-negative/);
  });

  it('produces identical random sequences from identical seeds', () => {
    const first = new SeededRandom(678);
    const second = new SeededRandom(678);
    expect(Array.from({ length: 20 }, () => first.nextUint32())).toEqual(Array.from({ length: 20 }, () => second.nextUint32()));
  });
});
