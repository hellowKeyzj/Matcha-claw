// Only private copies enter this set. Decoder/caller objects are never frozen or trusted by reference.
const immutableFacts = new WeakSet<object>();

export function isSessionProjectionFact(value: unknown): boolean {
  return value !== null && typeof value === 'object' && immutableFacts.has(value);
}

const unsafeValue = Symbol('unsafe projection fact');
const payloadTextByFact = new WeakMap<object, string | undefined>();

export function stringifySessionToolPayload(value: unknown, cache = false): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value;
  if (!cache || !isSessionProjectionFact(value)) return JSON.stringify(value, null, 2);
  const fact = value as object;
  if (payloadTextByFact.has(fact)) return payloadTextByFact.get(fact);
  const text = JSON.stringify(value, null, 2);
  payloadTextByFact.set(fact, text);
  return text;
}

function copyFact(value: unknown, copies: Map<object, object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') throw unsafeValue;
    return value;
  }
  if (immutableFacts.has(value)) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== Array.prototype || 'toJSON' in value) throw unsafeValue;
  if (copies.has(value)) throw unsafeValue;
  const copy: Record<string, unknown> | unknown[] = Array.isArray(value) ? new Array(value.length) : {};
  copies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw unsafeValue;
    Object.defineProperty(copy, key, {
      value: copyFact(descriptor.value, copies), enumerable: true, configurable: true, writable: true,
    });
  }
  copies.delete(value);
  Object.freeze(copy);
  immutableFacts.add(copy);
  return copy;
}

/** Adopt only new ingress facts; already-owned nested facts are shared without traversing payloads.
 * Accessors/toJSON/non-JSON objects retain the uncached path and its observable serialization behavior.
 * This assumes the application's standard Object/Array prototypes are not mutated after adoption. */
export function adoptSessionProjectionFact<T>(value: T): T {
  try {
    return copyFact(value, new Map()) as T;
  } catch (error) {
    if (error !== unsafeValue) throw error;
    return value;
  }
}
