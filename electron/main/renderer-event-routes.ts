import { randomBytes } from 'node:crypto';

export type RendererEventRouteBinding = Readonly<{
  endpoint: Readonly<{
    kind: 'native-runtime';
    runtimeAdapterId: 'openclaw' | 'matcha-agent';
    runtimeInstanceId: 'local';
  }>;
  agentId: string;
  sessionKey: string;
}>;

const ROUTE_KEY_PREFIX = 'renderer-route:';

export class RendererEventRouteRegistry {
  private readonly bindings = new Map<string, RendererEventRouteBinding>();

  issue(binding: RendererEventRouteBinding): string {
    if (!isValidBinding(binding)) {
      throw new Error('Renderer event route binding is invalid.');
    }
    let routeKey: string;
    do {
      routeKey = `${ROUTE_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
    } while (this.bindings.has(routeKey));
    this.bindings.set(routeKey, binding);
    return routeKey;
  }

  isMatchaRoute(routeKey: string): boolean {
    const binding = this.bindings.get(routeKey);
    return binding !== undefined
      && isValidBinding(binding)
      && binding.endpoint.runtimeAdapterId === 'matcha-agent';
  }

  isOpenClawRoute(routeKey: string): boolean {
    const binding = this.bindings.get(routeKey);
    return binding !== undefined
      && isValidBinding(binding)
      && binding.endpoint.runtimeAdapterId === 'openclaw';
  }

  matchesSession(routeKey: string, sessionKey: string): boolean {
    const binding = this.bindings.get(routeKey);
    return binding !== undefined
      && isValidBinding(binding)
      && binding.sessionKey === sessionKey;
  }

  matches(routeKey: string, expected: RendererEventRouteBinding): boolean {
    const binding = this.bindings.get(routeKey);
    return binding !== undefined
      && isValidBinding(binding)
      && isValidBinding(expected)
      && binding.endpoint.kind === expected.endpoint.kind
      && binding.endpoint.runtimeAdapterId === expected.endpoint.runtimeAdapterId
      && binding.endpoint.runtimeInstanceId === expected.endpoint.runtimeInstanceId
      && binding.agentId === expected.agentId
      && binding.sessionKey === expected.sessionKey;
  }

  release(routeKey: string): void {
    this.bindings.delete(routeKey);
  }
}

function isValidBinding(binding: RendererEventRouteBinding): boolean {
  return binding.endpoint.kind === 'native-runtime'
    && (binding.endpoint.runtimeAdapterId === 'openclaw'
      || binding.endpoint.runtimeAdapterId === 'matcha-agent')
    && binding.endpoint.runtimeInstanceId === 'local'
    && isBoundedIdentifier(binding.agentId)
    && isBoundedIdentifier(binding.sessionKey);
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 4096
    && value.trim() === value
    && ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127;
    });
}
