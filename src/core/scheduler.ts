export interface ScheduledTask {
  id: number;
  atMs: number;
  label?: string;
}

interface InternalTask extends ScheduledTask {
  order: number;
  callback: () => void;
  cancelled: boolean;
}

/** A small stable min-heap based discrete-event scheduler. */
export class DeterministicScheduler {
  private heap: InternalTask[] = [];
  private tasks = new Map<number, InternalTask>();
  private nextId = 1;
  private nextOrder = 1;
  private _nowMs = 0;

  get nowMs(): number {
    return this._nowMs;
  }

  get pendingCount(): number {
    return this.tasks.size;
  }

  scheduleAt(atMs: number, callback: () => void, label?: string): ScheduledTask {
    if (!Number.isFinite(atMs) || atMs < this._nowMs) {
      throw new RangeError(`Cannot schedule an event at ${atMs}ms while time is ${this._nowMs}ms.`);
    }
    const task: InternalTask = {
      id: this.nextId++,
      atMs,
      label,
      order: this.nextOrder++,
      callback,
      cancelled: false,
    };
    this.tasks.set(task.id, task);
    this.push(task);
    return { id: task.id, atMs: task.atMs, label: task.label };
  }

  scheduleIn(delayMs: number, callback: () => void, label?: string): ScheduledTask {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError('Delay must be a non-negative finite number.');
    }
    return this.scheduleAt(this._nowMs + delayMs, callback, label);
  }

  cancel(taskOrId: ScheduledTask | number): boolean {
    const id = typeof taskOrId === 'number' ? taskOrId : taskOrId.id;
    const task = this.tasks.get(id);
    if (!task) return false;
    task.cancelled = true;
    this.tasks.delete(id);
    return true;
  }

  peek(): ScheduledTask | undefined {
    this.discardCancelledHead();
    const task = this.heap[0];
    return task ? { id: task.id, atMs: task.atMs, label: task.label } : undefined;
  }

  runNext(): ScheduledTask | undefined {
    this.discardCancelledHead();
    const task = this.pop();
    if (!task) return undefined;
    if (task.cancelled) return this.runNext();
    this.tasks.delete(task.id);
    this._nowMs = task.atMs;
    task.callback();
    return { id: task.id, atMs: task.atMs, label: task.label };
  }

  runUntil(targetMs: number, maxTasks = 100_000): number {
    if (!Number.isFinite(targetMs) || targetMs < this._nowMs) {
      throw new RangeError(`Cannot run backwards from ${this._nowMs}ms to ${targetMs}ms.`);
    }
    let ran = 0;
    while (ran < maxTasks) {
      const next = this.peek();
      if (!next || next.atMs > targetMs) break;
      this.runNext();
      ran += 1;
    }
    if (ran >= maxTasks && this.peek() && this.peek()!.atMs <= targetMs) {
      throw new Error(`Scheduler task limit (${maxTasks}) reached.`);
    }
    this._nowMs = targetMs;
    return ran;
  }

  runUntilIdle(maxTasks = 100_000): number {
    let ran = 0;
    while (this.peek()) {
      if (ran >= maxTasks) throw new Error(`Scheduler task limit (${maxTasks}) reached.`);
      this.runNext();
      ran += 1;
    }
    return ran;
  }

  clear(resetTime = false): void {
    this.heap = [];
    this.tasks.clear();
    if (resetTime) this._nowMs = 0;
  }

  private less(a: InternalTask, b: InternalTask): boolean {
    return a.atMs < b.atMs || (a.atMs === b.atMs && a.order < b.order);
  }

  private push(task: InternalTask): void {
    this.heap.push(task);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const parentTask = this.heap[parent];
      if (!parentTask || !this.less(task, parentTask)) break;
      this.heap[index] = parentTask;
      this.heap[parent] = task;
      index = parent;
    }
  }

  private pop(): InternalTask | undefined {
    const first = this.heap[0];
    const last = this.heap.pop();
    if (!first || !last || this.heap.length === 0) return first;
    this.heap[0] = last;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      const leftTask = this.heap[left];
      const rightTask = this.heap[right];
      const smallestTask = this.heap[smallest];
      if (leftTask && smallestTask && this.less(leftTask, smallestTask)) smallest = left;
      const currentSmallest = this.heap[smallest];
      if (rightTask && currentSmallest && this.less(rightTask, currentSmallest)) smallest = right;
      if (smallest === index) break;
      const current = this.heap[index];
      const replacement = this.heap[smallest];
      if (!current || !replacement) break;
      this.heap[index] = replacement;
      this.heap[smallest] = current;
      index = smallest;
    }
    return first;
  }

  private discardCancelledHead(): void {
    while (this.heap[0]?.cancelled) this.pop();
  }
}

/** Deterministic 32-bit PRNG used for link loss and jitter. */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  next(): number {
    return this.nextUint32() / 0x1_0000_0000;
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}
