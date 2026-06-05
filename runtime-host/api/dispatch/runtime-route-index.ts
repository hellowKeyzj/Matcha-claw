import type { RuntimeRouteHandlerEntry } from './runtime-route-dispatcher-types';

interface RuntimeRouteIndexedHandler {
  readonly order: number;
  readonly entry: RuntimeRouteHandlerEntry;
}

interface RuntimeRouteMethodIndex {
  readonly exact: Map<string, RuntimeRouteHandlerEntry>;
  readonly prefixBuckets: Map<string, RuntimeRouteIndexedHandler[]>;
  readonly patterns: RuntimeRouteIndexedHandler[];
}

function createMethodIndex(): RuntimeRouteMethodIndex {
  return {
    exact: new Map<string, RuntimeRouteHandlerEntry>(),
    prefixBuckets: new Map<string, RuntimeRouteIndexedHandler[]>(),
    patterns: [],
  };
}

function routePrefixBucketKey(path: string): string {
  const normalized = path.startsWith('/') ? path.slice(1) : path;
  return normalized.split('/')[0] ?? '';
}

function registerPrefixRoute(methodIndex: RuntimeRouteMethodIndex, handler: RuntimeRouteIndexedHandler): void {
  if (handler.entry.matcher.type !== 'prefix') {
    return;
  }
  const bucketKey = routePrefixBucketKey(handler.entry.matcher.prefix);
  const bucket = methodIndex.prefixBuckets.get(bucketKey) ?? [];
  bucket.push(handler);
  methodIndex.prefixBuckets.set(bucketKey, bucket);
}

function patternMatches(pattern: RegExp, routePath: string): boolean {
  pattern.lastIndex = 0;
  return pattern.test(routePath);
}

export class RuntimeRouteIndex {
  private constructor(private readonly methods: Map<string, RuntimeRouteMethodIndex>) {}

  static from(handlers: RuntimeRouteHandlerEntry[]): RuntimeRouteIndex {
    const methods = new Map<string, RuntimeRouteMethodIndex>();
    handlers.forEach((entry, order) => {
      let methodIndex = methods.get(entry.method);
      if (!methodIndex) {
        methodIndex = createMethodIndex();
        methods.set(entry.method, methodIndex);
      }
      if (entry.matcher.type === 'exact') {
        const existing = methodIndex.exact.get(entry.matcher.path);
        if (existing) {
          throw new Error(`Duplicate exact runtime route: ${entry.method} ${entry.matcher.path} (${existing.key} vs ${entry.key})`);
        }
        methodIndex.exact.set(entry.matcher.path, entry);
        return;
      }
      const indexedHandler = { order, entry };
      if (entry.matcher.type === 'prefix') {
        registerPrefixRoute(methodIndex, indexedHandler);
        return;
      }
      methodIndex.patterns.push(indexedHandler);
    });
    return new RuntimeRouteIndex(methods);
  }

  exact(method: string, routePath: string): RuntimeRouteHandlerEntry | null {
    return this.methods.get(method)?.exact.get(routePath) ?? null;
  }

  fallbackCandidates(method: string, routePath: string): RuntimeRouteHandlerEntry[] {
    const methodIndex = this.methods.get(method);
    if (!methodIndex) {
      return [];
    }
    const bucketKey = routePrefixBucketKey(routePath);
    const prefixCandidates = [
      ...(methodIndex.prefixBuckets.get('') ?? []),
      ...(bucketKey === '' ? [] : methodIndex.prefixBuckets.get(bucketKey) ?? []),
    ].filter((handler) => (
      handler.entry.matcher.type === 'prefix'
      && routePath.startsWith(handler.entry.matcher.prefix)
    ));
    return [
      ...prefixCandidates,
      ...methodIndex.patterns.filter((handler) => (
        handler.entry.matcher.type === 'pattern'
        && patternMatches(handler.entry.matcher.pattern, routePath)
      )),
    ]
      .sort((left, right) => left.order - right.order)
      .map((handler) => handler.entry);
  }
}
