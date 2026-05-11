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

export class RuntimeHostRouteRegistry {
  private readonly registry = new RuntimeHostRegistry<RuntimeRouteHandlerEntry['key'], {
    readonly matcher: RuntimeRouteMatcher;
    readonly handler: RuntimeRouteHandler;
  }>();

  private register(key: string, matcher: RuntimeRouteMatcher, handler: RuntimeRouteHandler): void {
    this.registry.register(key, {
      matcher,
      handler,
    });
  }

  registerDefinitions<Deps>(
    namespace: string,
    definitions: readonly RuntimeRouteDefinition<Deps>[],
    deps: Deps,
  ): void {
    definitions.forEach((definition) => {
      this.register(
        routeDefinitionKey(namespace, definition),
        getRuntimeRouteDefinitionMatcher(definition),
        (request) => invokeRuntimeRouteDefinition(definition, routeContext(request), deps),
      );
    });
  }

  list(): RuntimeRouteHandlerEntry[] {
    return this.registry.list().map((entry) => ({
      key: entry.key,
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
}
