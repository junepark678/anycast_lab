const objectToString = Object.prototype.toString;

/** Clone project data without turning Uint8Array config payloads into objects. */
export function cloneProjectValue<T>(value: T): T {
  return cloneFallback(value, new WeakMap<object, unknown>());
}

function cloneFallback<T>(value: T, seen: WeakMap<object, unknown>): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing as T;
  }

  if (isUint8Array(value)) {
    const Uint8ArrayConstructor = value.constructor as new (
      source: ArrayLike<number>,
    ) => Uint8Array;
    return new Uint8ArrayConstructor(value) as T;
  }

  if (isArrayBuffer(value)) {
    return value.slice(0) as T;
  }

  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(
      value.buffer,
      value.byteOffset,
      value.byteLength,
    ).slice();
    const ViewConstructor = value.constructor as new (
      buffer: ArrayBuffer,
    ) => ArrayBufferView;
    return new ViewConstructor(bytes.buffer) as T;
  }

  if (value instanceof Date) {
    return new Date(value.getTime()) as T;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneFallback(item, seen));
    }
    return copy as T;
  }

  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [key, item] of value) {
      copy.set(cloneFallback(key, seen), cloneFallback(item, seen));
    }
    return copy as T;
  }

  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const item of value) {
      copy.add(cloneFallback(item, seen));
    }
    return copy as T;
  }

  if (objectToString.call(value) !== '[object Object]') {
    throw new TypeError(
      `Unsupported project value: ${value.constructor?.name ?? 'object'}`,
    );
  }

  const copy = Object.create(Object.getPrototypeOf(value)) as Record<
    PropertyKey,
    unknown
  >;
  seen.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable) {
      copy[key] = cloneFallback(
        (value as Record<PropertyKey, unknown>)[key],
        seen,
      );
    }
  }
  return copy as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Cross-realm check (projects can cross a Worker or jsdom boundary). */
export function isUint8Array(value: unknown): value is Uint8Array {
  return (
    value !== null &&
    typeof value === 'object' &&
    ArrayBuffer.isView(value) &&
    objectToString.call(value) === '[object Uint8Array]'
  );
}

/** Cross-realm check (projects can cross a Worker or jsdom boundary). */
export function isArrayBuffer(value: unknown): value is ArrayBuffer {
  return (
    value !== null &&
    typeof value === 'object' &&
    objectToString.call(value) === '[object ArrayBuffer]'
  );
}

export function assertProjectIdentity(
  project: unknown,
): asserts project is ProjectIdentityValue {
  if (!isRecord(project)) {
    throw new TypeError('A lab project must be an object');
  }
  if (typeof project.id !== 'string' || project.id.trim() === '') {
    throw new TypeError('A lab project must have a non-empty string id');
  }
  if (typeof project.name !== 'string' || project.name.trim() === '') {
    throw new TypeError('A lab project must have a non-empty string name');
  }
}

interface ProjectIdentityValue extends Record<string, unknown> {
  id: string;
  name: string;
}
