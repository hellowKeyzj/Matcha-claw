import type { RuntimeRouteResponse } from '../dispatch/runtime-route-dispatcher-types';
import {
  accepted,
  badRequest,
  ok,
  serverError,
  type ApplicationResponse,
} from '../../application/common/application-response';

export { accepted, badRequest, ok };
export type { ApplicationResponse, RuntimeRouteResponse };

export interface RuntimeRouteContext {
  readonly method: string;
  readonly routePath: string;
  readonly routeUrl: URL;
  readonly payload: unknown;
}

export interface RuntimeRouteMatch {
  readonly params: readonly string[];
}

export type RuntimeRouteAction<Deps> = (
  context: RuntimeRouteContext,
  deps: Deps,
  match: RuntimeRouteMatch,
) => Promise<RuntimeRouteResponse | null> | RuntimeRouteResponse | null;

export interface RuntimeRouteDefinition<Deps> {
  readonly method: string;
  readonly path?: string;
  readonly pattern?: RegExp;
  readonly prefix?: string;
  readonly handle: RuntimeRouteAction<Deps>;
}

export type RuntimeRouteDefinitionMatcher =
  | { readonly type: 'exact'; readonly path: string }
  | { readonly type: 'prefix'; readonly prefix: string }
  | { readonly type: 'pattern'; readonly pattern: RegExp };

export function isRuntimeRouteResponse(value: unknown): value is RuntimeRouteResponse {
  return value !== null
    && typeof value === 'object'
    && 'status' in value
    && 'data' in value
    && typeof (value as { status?: unknown }).status === 'number';
}

const DEFAULT_READ_ONLY_BOUNDARY_FORBIDDEN_FIELDS = new Set<string>([
  'apiKey',
  'key',
  'normalizedKey',
  'secret',
  'clientSecret',
  'accessToken',
  'refreshToken',
  'token',
  'gatewayToken',
  'providerEnv',
  'headers',
  'customHeaders',
  'serviceAccountKey',
  'output',
  'stdout',
  'stderr',
  'logs',
  'controlState',
  'controlUiState',
  'pendingControlUiPairingRequests',
  'controlUiPairingRequests',
  'pairingControl',
  'controlRequests',
]);

const DEFAULT_READ_ONLY_BOUNDARY_FORBIDDEN_FIELD_PATTERNS = [
  /secret/i,
  /password/i,
  /^apiKey$/i,
  /privateKey/i,
  /serviceAccountKey/i,
  /(?:^|[A-Z_])(access|refresh|auth|gateway|bot|channel|channelAccess)?Token$/,
] as const;

export function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isReadOnlyForbiddenField(key: string, forbiddenFields: ReadonlySet<string>): boolean {
  return forbiddenFields.has(key)
    || DEFAULT_READ_ONLY_BOUNDARY_FORBIDDEN_FIELD_PATTERNS.some((pattern) => pattern.test(key));
}

export function sanitizeReadOnlyRoutePayload(
  value: unknown,
  extraForbiddenFields: readonly string[] = [],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReadOnlyRoutePayload(item, extraForbiddenFields));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const forbiddenFields = new Set([
    ...DEFAULT_READ_ONLY_BOUNDARY_FORBIDDEN_FIELDS,
    ...extraForbiddenFields,
  ]);
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !isReadOnlyForbiddenField(key, forbiddenFields))
    .map(([key, item]) => [key, sanitizeReadOnlyRoutePayload(item, extraForbiddenFields)]));
}

export function sanitizeReadOnlyRouteResponse<T>(
  response: T,
  extraForbiddenFields: readonly string[] = [],
): T | unknown {
  if (isRuntimeRouteResponse(response)) {
    return {
      ...response,
      data: sanitizeReadOnlyRoutePayload(response.data, extraForbiddenFields),
    };
  }
  return sanitizeReadOnlyRoutePayload(response, extraForbiddenFields);
}

export function decodeRouteParam(value: string | undefined): string {
  return decodeURIComponent(value ?? '');
}

export function routeError(error: unknown, data?: (message: string) => unknown): RuntimeRouteResponse {
  const message = String(error);
  return data ? { status: 500, data: data(message) } : serverError(message);
}

export async function invokeRoute(
  handler: () => Promise<RuntimeRouteResponse> | RuntimeRouteResponse,
  onError?: (message: string) => unknown,
): Promise<RuntimeRouteResponse> {
  try {
    return await handler();
  } catch (error) {
    return routeError(error, onError);
  }
}

export async function invokeOk(
  handler: () => Promise<unknown> | unknown,
  onError?: (message: string) => unknown,
): Promise<RuntimeRouteResponse> {
  return await invokeRoute(async () => ok(await handler()), onError);
}

export class RuntimeRouteResponder {
  ok(data: unknown): RuntimeRouteResponse {
    return ok(data);
  }

  async value(
    handler: () => Promise<unknown> | unknown,
    onError?: (message: string) => unknown,
  ): Promise<RuntimeRouteResponse> {
    return await invokeOk(handler, onError);
  }

  async result(
    handler: () => Promise<ApplicationResponse | RuntimeRouteResponse | unknown> | ApplicationResponse | RuntimeRouteResponse | unknown,
    onError?: (message: string) => unknown,
  ): Promise<RuntimeRouteResponse> {
    return await invokeRoute(async () => {
      const result = await handler();
      return isRuntimeRouteResponse(result) ? result : ok(result);
    }, onError);
  }
}

export const routeResponder = new RuntimeRouteResponder();

export function getRuntimeRouteDefinitionMatcher<Deps>(
  route: RuntimeRouteDefinition<Deps>,
): RuntimeRouteDefinitionMatcher {
  if (route.path !== undefined) {
    return { type: 'exact', path: route.path };
  }
  if (route.prefix !== undefined) {
    return { type: 'prefix', prefix: route.prefix };
  }
  if (route.pattern !== undefined) {
    return { type: 'pattern', pattern: route.pattern };
  }
  throw new Error('Runtime route definition must declare path, prefix, or pattern');
}

export function matchRuntimeRouteDefinition<Deps>(
  route: RuntimeRouteDefinition<Deps>,
  method: string,
  routePath: string,
): RuntimeRouteMatch | null {
  if (route.method !== method) {
    return null;
  }
  if (route.path !== undefined) {
    return route.path === routePath ? { params: [] } : null;
  }
  if (route.prefix !== undefined) {
    return routePath.startsWith(route.prefix)
      ? { params: [routePath.slice(route.prefix.length)] }
      : null;
  }
  if (route.pattern !== undefined) {
    const match = route.pattern.exec(routePath);
    return match ? { params: match.slice(1) } : null;
  }
  throw new Error('Runtime route definition must declare path, prefix, or pattern');
}

export function createRuntimeRouteContext(
  method: string,
  routePath: string,
  routeUrl: URL,
  payload: unknown,
): RuntimeRouteContext {
  return {
    method,
    routePath,
    routeUrl,
    payload,
  };
}

export async function invokeRuntimeRouteDefinition<Deps>(
  route: RuntimeRouteDefinition<Deps>,
  context: RuntimeRouteContext,
  deps: Deps,
): Promise<RuntimeRouteResponse | null> {
  const match = matchRuntimeRouteDefinition(route, context.method, context.routePath);
  return match ? await route.handle(context, deps, match) : null;
}
