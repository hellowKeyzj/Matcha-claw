import {
  accepted,
  routeResponder,
  type ApplicationResponse,
  type RuntimeRouteDefinition,
} from './route-utils';

interface SecurityRouteDeps {
  securityService: SecurityRouteService;
}

interface SecurityRouteService {
  readPolicy(): Promise<unknown>;
  writePolicy(payload: unknown): Promise<ApplicationResponse>;
  listRuleCatalog(platform: string | null): unknown;
  queryAudit(routeUrl: URL): Promise<unknown>;
  syncCurrentPolicyToGatewayIfRunning(): ApplicationResponse;
  runQuickAudit(): unknown;
  runEmergencyResponse(): unknown;
  checkIntegrity(): unknown;
  rebaselineIntegrity(): unknown;
  scanSkillsFromPayload(payload: unknown): unknown;
  checkAdvisoriesFromUrl(routeUrl: URL): unknown;
  previewRemediation(): unknown;
  applyRemediationFromPayload(payload: unknown): unknown;
  rollbackRemediationFromPayload(payload: unknown): unknown;
}

export const securityRoutes: readonly RuntimeRouteDefinition<SecurityRouteDeps>[] = [
  { method: 'GET', path: '/api/security', handle: (_context, deps) => routeResponder.value(() => deps.securityService.readPolicy()) },
  { method: 'PUT', path: '/api/security', handle: (context, deps) => routeResponder.result(() => deps.securityService.writePolicy(context.payload)) },
  { method: 'GET', path: '/api/security/destructive-rule-catalog', handle: (context, deps) => routeResponder.ok(deps.securityService.listRuleCatalog(context.routeUrl.searchParams.get('platform'))) },
  { method: 'GET', path: '/api/security/audit', handle: (context, deps) => routeResponder.value(() => deps.securityService.queryAudit(context.routeUrl)) },
  { method: 'POST', path: '/api/security/sync-current-policy', handle: (_context, deps) => routeResponder.result(() => deps.securityService.syncCurrentPolicyToGatewayIfRunning()) },
  { method: 'POST', path: '/api/security/quick-audit', handle: (_context, deps) => accepted(deps.securityService.runQuickAudit()) },
  { method: 'POST', path: '/api/security/emergency-response', handle: (_context, deps) => accepted(deps.securityService.runEmergencyResponse()) },
  { method: 'GET', path: '/api/security/integrity', handle: (_context, deps) => accepted(deps.securityService.checkIntegrity()) },
  { method: 'POST', path: '/api/security/integrity/rebaseline', handle: (_context, deps) => accepted(deps.securityService.rebaselineIntegrity()) },
  { method: 'POST', path: '/api/security/skills/scan', handle: (context, deps) => accepted(deps.securityService.scanSkillsFromPayload(context.payload)) },
  { method: 'GET', path: '/api/security/advisories', handle: (context, deps) => accepted(deps.securityService.checkAdvisoriesFromUrl(context.routeUrl)) },
  { method: 'GET', path: '/api/security/remediation/preview', handle: (_context, deps) => accepted(deps.securityService.previewRemediation()) },
  { method: 'POST', path: '/api/security/remediation/apply', handle: (context, deps) => accepted(deps.securityService.applyRemediationFromPayload(context.payload)) },
  { method: 'POST', path: '/api/security/remediation/rollback', handle: (context, deps) => accepted(deps.securityService.rollbackRemediationFromPayload(context.payload)) },
] as const;

