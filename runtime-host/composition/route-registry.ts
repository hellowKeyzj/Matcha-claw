import { RuntimeRouteIndex } from '../api/dispatch/runtime-route-index';
import { createRuntimeRouteDispatcher } from '../api/dispatch/runtime-route-dispatcher';
import type {
  RuntimeRouteHandler,
  RuntimeRouteHandlerEntry,
  RuntimeRouteMatcher,
  RuntimeRouteResponse,
  RuntimeRouteRequest,
} from '../api/dispatch/runtime-route-dispatcher-types';
import type {
  RuntimeRouteContext,
  RuntimeRouteDefinition,
} from '../api/routes/route-utils';
import {
  createRuntimeRouteContext,
  getRuntimeRouteDefinitionMatcher,
  invokeRuntimeRouteDefinition,
} from '../api/routes/route-utils';
import { RuntimeHostRegistry } from '../core/registry';

function routeContext(request: RuntimeRouteRequest): RuntimeRouteContext {
  return createRuntimeRouteContext(
    request.method,
    request.routePath,
    request.routeUrl,
    request.payload,
  );
}

function routeDefinitionKey<Deps>(
  namespace: string,
  definition: RuntimeRouteDefinition<Deps>,
): string {
  const matcher = getRuntimeRouteDefinitionMatcher(definition);
  if (matcher.type === 'exact') {
    return `${namespace}.${definition.method} ${matcher.path}`;
  }
  if (matcher.type === 'prefix') {
    return `${namespace}.${definition.method} ${matcher.prefix}*`;
  }
  return `${namespace}.${definition.method} /${matcher.pattern.source}/`;
}

export interface RuntimeHostRouteRegistrationDescriptor {
  readonly key: string;
  readonly owner: string | null;
}

export class RuntimeHostRouteRegistry {
  private readonly registry = new RuntimeHostRegistry<RuntimeRouteHandlerEntry['key'], {
    readonly method: string;
    readonly matcher: RuntimeRouteMatcher;
    readonly handler: RuntimeRouteHandler;
  }>();
  private readonly owners = new Map<string, string | null>();
  private activeRegistrationOwner: string | null = null;

  private register(key: string, method: string, matcher: RuntimeRouteMatcher, handler: RuntimeRouteHandler): void {
    this.registry.register(key, {
      method,
      matcher,
      handler,
    });
    this.owners.set(key, this.activeRegistrationOwner);
  }

  withRegistrationOwner<T>(owner: string, register: () => T): T {
    const normalizedOwner = owner.trim();
    if (!normalizedOwner) {
      throw new Error('Runtime route registration owner is required');
    }
    const previousOwner = this.activeRegistrationOwner;
    this.activeRegistrationOwner = normalizedOwner;
    try {
      return register();
    } finally {
      this.activeRegistrationOwner = previousOwner;
    }
  }

  listRegistrations(): RuntimeHostRouteRegistrationDescriptor[] {
    return this.registry.list().map((entry) => ({
      key: entry.key,
      owner: this.owners.get(entry.key) ?? null,
    }));
  }

  registerDefinitions<Deps>(
    namespace: string,
    definitions: readonly RuntimeRouteDefinition<Deps>[],
    deps: Deps,
  ): void {
    definitions.forEach((definition) => {
      this.register(
        routeDefinitionKey(namespace, definition),
        definition.method,
        getRuntimeRouteDefinitionMatcher(definition),
        (request) => invokeRuntimeRouteDefinition(definition, routeContext(request), deps),
      );
    });
  }

  list(): RuntimeRouteHandlerEntry[] {
    return this.registry.list().map((entry) => ({
      key: entry.key,
      method: entry.value.method,
      matcher: entry.value.matcher,
      handle: async (request) => {
        try {
          return await entry.value.handler(request);
        } catch (error) {
          return {
            status: 500,
            data: { success: false, error: String(error) },
          };
        }
      },
    }));
  }

  index(): RuntimeRouteIndex {
    return RuntimeRouteIndex.from(this.list());
  }

  dispatcher(): (method: string, route: string, payload: unknown) => Promise<RuntimeRouteResponse | null> {
    return createRuntimeRouteDispatcher(this.index());
  }
}
