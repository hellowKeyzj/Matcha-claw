import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const remoteFleetRoutePath = join(repositoryRoot, 'runtime-host/api/routes/remote-fleet-routes.ts');
const mainApiRouteBoundaryPath = join(repositoryRoot, 'electron/api/route-boundary.ts');
const mainApiBoundaryContractPath = join(repositoryRoot, 'electron/api/main-api-boundary.json');
const remoteFleetModulePath = join(repositoryRoot, 'runtime-host/composition/modules/remote-fleet-application-module.ts');
const rendererRemoteFleetStorePath = join(repositoryRoot, 'src/stores/remote-fleet.ts');
const rendererRemoteFleetPageRootPath = join(repositoryRoot, 'src/pages/RemoteFleet');
const rendererRemoteFleetPagePath = join(rendererRemoteFleetPageRootPath, 'index.tsx');
const rendererRemoteFleetInventoryPanelPath = join(rendererRemoteFleetPageRootPath, 'components/RemoteFleetInventoryPanel.tsx');
const rendererRemoteFleetOperationsPath = join(rendererRemoteFleetPageRootPath, 'components/RemoteFleetOperationsSection.tsx');
const rendererRemoteFleetDetailPanelPath = join(rendererRemoteFleetPageRootPath, 'components/RemoteFleetDetailPanel.tsx');
const rendererRemoteFleetTerminalDrawerPath = join(rendererRemoteFleetPageRootPath, 'components/RemoteFleetTerminalDrawer.tsx');
const rendererRemoteFleetTerminalHookPath = join(rendererRemoteFleetPageRootPath, 'components/useRemoteFleetTerminal.ts');
const rendererRemoteFleetTerminalTypesPath = join(rendererRemoteFleetPageRootPath, 'components/remote-fleet-terminal-types.ts');
const remoteFleetPageTestPath = join(repositoryRoot, 'tests/unit/remote-fleet-page.test.tsx');
const remoteFleetCommonLocalePaths = [
  join(repositoryRoot, 'src/i18n/locales/en/common.json'),
  join(repositoryRoot, 'src/i18n/locales/zh/common.json'),
  join(repositoryRoot, 'src/i18n/locales/ja/common.json'),
  join(repositoryRoot, 'src/i18n/locales/ru/common.json'),
] as const;
const rendererRoot = join(repositoryRoot, 'src');
const electronRoot = join(repositoryRoot, 'electron');
const nonRendererRemoteFleetPolicyRoots = [
  join(repositoryRoot, 'runtime-host'),
  electronRoot,
] as const;
const productSourceRoots = [
  join(repositoryRoot, 'runtime-host/api/routes'),
  join(repositoryRoot, 'runtime-host/application/remote-fleet'),
  join(repositoryRoot, 'runtime-host/application/team-runtime'),
  join(repositoryRoot, 'runtime-host/application/external-connectors'),
  join(repositoryRoot, 'runtime-host/application/runtime-host'),
  rendererRoot,
] as const;

const remoteFleetRouteContracts = [
  { method: 'GET', path: '/api/remote-fleet/snapshot', operationId: 'snapshot' },
  { method: 'GET', path: '/api/remote-fleet/metrics', operationId: 'metrics' },
  { method: 'POST', path: '/api/remote-fleet/register-connection', operationId: 'registerConnection' },
  { method: 'POST', path: '/api/remote-fleet/delete-connection', operationId: 'deleteConnection' },
  { method: 'POST', path: '/api/remote-fleet/register', operationId: 'register' },
  { method: 'POST', path: '/api/remote-fleet/write-credential', operationId: 'writeCredential' },
  { method: 'POST', path: '/api/remote-fleet/remove-node', operationId: 'removeNode' },
  { method: 'POST', path: '/api/remote-fleet/probe', operationId: 'probe' },
  { method: 'POST', path: '/api/remote-fleet/probe-connection', operationId: 'probeConnection' },
  { method: 'POST', path: '/api/remote-fleet/install-agent', operationId: 'installAgent' },
  { method: 'POST', path: '/api/remote-fleet/revoke-agent', operationId: 'revokeAgent' },
  { method: 'POST', path: '/api/remote-fleet/drain-endpoint', operationId: 'drainEndpoint' },
  { method: 'POST', path: '/api/remote-fleet/retire-endpoint', operationId: 'retireEndpoint' },
  { method: 'POST', path: '/api/remote-fleet/terminal/open', operationId: 'openTerminalSession' },
  { method: 'POST', path: '/api/remote-fleet/terminal/reconnect', operationId: 'reconnectTerminalSession' },
  { method: 'POST', path: '/api/remote-fleet/terminal/close', operationId: 'closeTerminalSession' },
  { method: 'GET', path: '/api/remote-fleet/terminal/sessions', operationId: 'listTerminalSessions' },
  { method: 'GET', path: '/api/remote-fleet/list-commands', operationId: 'listCommands' },
  { method: 'GET', path: '/api/remote-fleet/list-audit-events', operationId: 'listAuditEvents' },
] as const;

const legacyRemoteFleetPublicIngressContracts = [
  { method: 'POST', path: '/api/remote-fleet/record-heartbeat', operationId: 'recordHeartbeat' },
  { method: 'POST', path: '/api/remote-fleet/record-command-progress', operationId: 'recordCommandProgress' },
  { method: 'POST', path: '/api/remote-fleet/record-command-result', operationId: 'recordCommandResult' },
] as const;

const remoteFleetRuntimeAgentIngressPath = '/api/remote-fleet/runtime-agent/ingress';

const remoteFleetAllowedRouteReferencePaths = [
  ...remoteFleetRouteContracts.map((routeContract) => routeContract.path),
  remoteFleetRuntimeAgentIngressPath,
  '/api/remote-fleet/register-environment',
  '/api/remote-fleet/delete-connection',
  '/api/remote-fleet/deploy-environment',
  '/api/remote-fleet/delete-environment',
] as const;

const remoteFleetWebSocketPaths = [
  '/api/remote-fleet/terminal/stream',
] as const;

function readOptionalSource(filePath: string): string {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

function readRemoteFleetSources(): Array<{ path: string; text: string }> {
  return [
    { path: 'runtime-host/api/routes/remote-fleet-routes.ts', text: readOptionalSource(remoteFleetRoutePath) },
    { path: 'runtime-host/composition/modules/remote-fleet-application-module.ts', text: readOptionalSource(remoteFleetModulePath) },
    { path: 'src/stores/remote-fleet.ts', text: readOptionalSource(rendererRemoteFleetStorePath) },
  ].filter((file) => file.text.length > 0);
}

function readSourceFiles(directoryPath: string): Array<{ path: string; text: string }> {
  if (!existsSync(directoryPath)) return [];

  return readdirSync(directoryPath, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directoryPath, entry.name);
    if (entry.isDirectory()) return readSourceFiles(entryPath);
    if (!entry.isFile() || !rendererSourceFilePattern.test(entry.name)) return [];

    return [{ path: relative(repositoryRoot, entryPath), text: readFileSync(entryPath, 'utf8') }];
  });
}

function readRendererSources(directoryPath = rendererRoot): Array<{ path: string; text: string }> {
  return readSourceFiles(directoryPath);
}

function readRendererRemoteFleetProjectionSources(): Array<{ path: string; text: string }> {
  return [
    { path: 'src/stores/remote-fleet.ts', text: readOptionalSource(rendererRemoteFleetStorePath) },
    ...readSourceFiles(rendererRemoteFleetPageRootPath),
  ].filter((file) => file.text.length > 0);
}

function readActiveRemoteFleetPageSources(): Array<{ path: string; text: string }> {
  const pendingPaths = [rendererRemoteFleetPagePath];
  const visitedPaths = new Set<string>();
  const sources: Array<{ path: string; text: string }> = [];

  while (pendingPaths.length > 0) {
    const filePath = pendingPaths.pop()!;
    if (visitedPaths.has(filePath) || !existsSync(filePath)) continue;
    visitedPaths.add(filePath);

    const text = readFileSync(filePath, 'utf8');
    sources.push({ path: relative(repositoryRoot, filePath).replaceAll('\\', '/'), text });

    for (const match of text.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/g)) {
      const importPath = match[1];
      const resolvedImportPath = resolve(dirname(filePath), importPath);
      const candidatePaths = extname(resolvedImportPath)
        ? [resolvedImportPath]
        : [`${resolvedImportPath}.ts`, `${resolvedImportPath}.tsx`, join(resolvedImportPath, 'index.ts'), join(resolvedImportPath, 'index.tsx')];
      const localSourcePath = candidatePaths.find((candidatePath) => existsSync(candidatePath));
      if (localSourcePath && localSourcePath.startsWith(rendererRemoteFleetPageRootPath)) {
        pendingPaths.push(localSourcePath);
      }
    }
  }

  return sources;
}

function readElectronRemoteFleetBoundarySources(): Array<{ path: string; text: string }> {
  return readSourceFiles(electronRoot)
    .filter((file) => remoteFleetRelevantPattern.test(file.path) || remoteFleetRelevantPattern.test(file.text));
}

function readProductSources(): Array<{ path: string; text: string }> {
  return productSourceRoots.flatMap((rootPath) => readSourceFiles(rootPath));
}

function readRemoteFleetCommonLocales(): Array<{ path: string; remoteFleet: Record<string, unknown> }> {
  return remoteFleetCommonLocalePaths.map((localePath) => ({
    path: relative(repositoryRoot, localePath),
    remoteFleet: (JSON.parse(readOptionalSource(localePath)) as { remoteFleet: Record<string, unknown> }).remoteFleet,
  }));
}

function readNestedValue(source: Record<string, unknown>, keyPath: string): unknown {
  return keyPath.split('.').reduce<unknown>((current, key) => {
    return current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined;
  }, source);
}

function readNestedString(source: Record<string, unknown>, keyPath: string): string {
  const value = readNestedValue(source, keyPath);

  return typeof value === 'string' ? value : '';
}

function sourceBlock(source: string, pattern: RegExp): string {
  return pattern.exec(source)?.[0] ?? '';
}

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const startIndex = source.indexOf(startMarker);
  if (startIndex < 0) return '';

  const endIndex = source.indexOf(endMarker, startIndex + startMarker.length);
  return endIndex < 0 ? source.slice(startIndex) : source.slice(startIndex, endIndex);
}

function collectRemoteFleetI18nKeys(sourceFiles: Array<{ path: string; text: string }>): string[] {
  const keys = new Set<string>();

  for (const file of sourceFiles) {
    for (const match of file.text.matchAll(/\bt\(\s*['"](remoteFleet\.[^'"`]+)['"]/g)) {
      keys.add(match[1]!);
    }
    for (const match of file.text.matchAll(/\b(?:key|titleKey|descriptionKey):\s*['"](remoteFleet\.[^'"]+)['"]/g)) {
      keys.add(match[1]!);
    }
  }

  return [...keys].sort();
}

function remoteFleetLocaleHasKey(remoteFleet: Record<string, unknown>, key: string): boolean {
  return typeof readNestedValue(remoteFleet, key.replace(/^remoteFleet\./, '')) === 'string';
}

function readRemoteFleetPolicyBoundarySources(): Array<{ path: string; text: string }> {
  return nonRendererRemoteFleetPolicyRoots
    .flatMap((rootPath) => readSourceFiles(rootPath))
    .filter((file) => remoteFleetRelevantPattern.test(file.path) || remoteFleetRelevantPattern.test(file.text));
}

function findRemoteFleetRouteReferences(): Array<{ path: string; routePath: string }> {
  return readProductSources().flatMap((file) => {
    const matches = [...file.text.matchAll(remoteFleetRouteReferencePattern)];
    return matches.map((match) => ({ path: file.path, routePath: match[0] }));
  });
}

const teamRunPattern = /TeamRun|teamRuntime|team-runtime|team\.runtime/i;
const inProcessFallbackPattern = /in[-_ ]process fallback|fallback[^\n]{0,80}in[-_ ]process|same[-_ ]process[^\n]{0,80}remote|direct fallback|local fallback/i;
const remoteFleetRelevantPattern = /remote[-_ ]fleet|remoteFleet|RemoteFleet/i;
const rendererRemoteFleetCanonicalPattern = /RemoteFleet|remoteFleet|remote[-_ ]fleet|RuntimeFleet|FleetRuntime|runtime[-_ ]fleet|remoteFleetCanonical|canonicalRemoteFleet/i;
const remoteFleetLifecycleRoutePattern = /\/api\/remote-fleet\/(?:start|stop|sync)/;
const remoteFleetRouteReferencePattern = /\/api\/remote-fleet\/[A-Za-z0-9-]+(?:\/[A-Za-z0-9-]+)*/g;
const rendererSourceFilePattern = /\.(?:ts|tsx|json)$/;
const rendererStatePersistencePattern = /\b(?:persist|createJSONStorage|localStorage|sessionStorage|indexedDB|setItem|getItem)\b/i;
const rendererCanonicalSynthesisPattern = /\b(?:canonical|sourceOfTruth|source-of-truth|authoritative|persistedRemoteFleet|remoteFleetStateStore)\b/i;
const mainPolicyDuplicatePattern = /\b(?:dockerEndpoint|kubeconfig|serviceAccountKey|privateKey|apiKey|apiToken|Authorization|secretRefs|publicConfig|endpointUrl|providerKindForTargetKind|targetKindToProviderKind)\b/;
const rendererSecretProjectionPattern = /\b(?:terminalBytes|rawTerminal|rawOutput|stdout|stderr|serviceAccountKey|privateKey|apiKey|apiToken|accessToken|refreshToken|authToken|secretRefs|ticket|terminalConnection)\b/;
const terminalTicketStoragePattern = /\bsessions\s*:\s*[^\n]*(?:ticket|terminalConnection)|terminalConnection\s*:\s*[^\n]*state\b/i;
const providerDirectRendererStatePattern = /(?:@\/stores\/remote-fleet|src\/stores\/remote-fleet|stores\/remote-fleet|useRemoteFleetStore|remoteFleetStore)/;
const removeNodeDirectProviderCleanupPattern = /(?:Docker|K8s|Kubernetes|docker|k8s)[^\n]{0,120}(?:delete|cleanup|remove|container)|(?:DELETE|delete)[^\n]{0,80}\/containers|targetKind\s*={0,2}\s*['"]container['"][^\n]{0,120}(?:delete|cleanup|remove)/;
const legacyRemoteFleetInventoryPanelReferencePattern = /(?:from\s*['"][^'"]*RemoteFleetInventoryPanel['"]|<RemoteFleetInventoryPanel\b|\bRemoteFleetInventoryPanel\s*\()/;
const legacyRemoteFleetInventoryTabsPattern = /<TabsList\b[^>]*\bgrid-cols-2\b[\s\S]{0,1600}\bREMOTE_FLEET_INVENTORY_TABS\.map\b/;
const legacyRemoteFleetFixedRailPattern = /min-h-\[620px\][^\n>]*w-\[360px\]|w-\[360px\][^\n>]*min-h-\[620px\]/;
const selectionForcedRemountPattern = /\bkey\s*=\s*\{[^}\n]*(?:selection|selected)(?:[^}\n]*\.(?:kind|id))?/i;
const independentGapsViewPattern = /type\s+OperationsView\s*=\s*[^;]*['"]gaps['"]|\bOPERATIONS_VIEWS\s*=\s*\[[^\]]*['"]gaps['"]|case\s+['"]gaps['"]\s*:/;
const topLevelMetricsLoadControlPattern = /<header\b[\s\S]*?(?:onLoadMetrics|loadMetrics)\b[\s\S]*?<\/header>/;
const duplicatedOperationsHelperPattern = /\b(?:function|const|let)\s+(?:StatusBadge|FieldRow|EmptyPanel)\b/;
const remoteFleetFakeCopyPatterns = [
  /Launch environment/,
  /Legacy environment/,
] as const;
const remoteFleetMainCopySecretPattern = /\b(?:plaintext|password|privateKey|secret|stdout|stderr|ticket)\b/i;
const remoteFleetSnapshotFixtureSecretPattern = /\b(?:plaintext|token|password|privateKey|secret|stdout|stderr|ticket)\b/i;
const remoteFleetMainCopyKeyPaths = [
  'header.title',
  'header.description',
  'inventory.title',
  'inventory.empty',
  'detail.descriptions.node',
  'detail.descriptions.runtime',
  'detail.actions.deployEnvironment',
  'registration.trigger',
  'registration.title',
  'registration.description',
  'registration.container.title',
  'registration.k8s.connection.title',
  'registration.container.help.containerName',
  'registration.k8s.help.podTarget',
  'toasts.environmentDeploySubmitted',
] as const;

const remoteFleetRegistrationRequiredCopyKeyPaths = [
  'registration.errors.credentialWriterMissing',
  'registration.errors.k8sKubeconfigPending',
  'registration.ssh.auth.methods.ssh-agent',
  'registration.ssh.auth.methods.existing-secret',
  'registration.ssh.auth.fields.existingSecret',
  'registration.ssh.auth.help.credentialPending',
  'registration.ssh.auth.help.existingSecret',
  'registration.container.fields.connectionSource',
  'registration.container.fields.contextName',
  'registration.container.fields.tlsCertificate',
  'registration.container.connectionSources.endpoint',
  'registration.container.connectionSources.context',
  'registration.container.authMethods.tls-certificate',
  'registration.container.authMethods.ssh-context',
  'registration.container.help.credentialPending',
  'registration.container.help.sshContext',
  'registration.k8s.connection.modeLabel',
  'registration.k8s.connection.modes.manual',
  'registration.k8s.connection.modes.kubeconfig',
  'registration.k8s.fields.clientCertificate',
  'registration.k8s.fields.kubeconfig',
  'registration.k8s.fields.kubeconfigContext',
  'registration.k8s.help.credentialPending',
  'registration.custom.auth.label',
  'registration.custom.auth.methods.api-token',
  'registration.custom.auth.methods.mtls',
  'registration.custom.auth.methods.pairing-code',
  'registration.custom.auth.pendingCredentialNotice',
  'registration.custom.credentials.apiToken',
  'registration.custom.credentials.mtlsBundle',
  'registration.custom.credentials.notSubmitted',
  'registration.vm.loginMethods.agent-installed',
  'registration.vm.help.credentialPending',
  'registration.vm.help.agentInstalled',
] as const;

describe('remote fleet route and worker-backed contract', () => {
  it('declares the production route operation ids without importing the runtime module', () => {
    const routeSource = readOptionalSource(remoteFleetRoutePath);

    expect(routeSource).toContain('REMOTE_FLEET_ROUTE_OPERATIONS');
    for (const routeContract of remoteFleetRouteContracts) {
      expect(routeSource).toContain(`{ method: '${routeContract.method}', path: '${routeContract.path}', operationId: '${routeContract.operationId}' }`);
    }
    expect(readOptionalSource(mainApiRouteBoundaryPath)).toContain("'/api/remote-fleet/probe'");
    expect(readOptionalSource(mainApiRouteBoundaryPath)).toContain("'/api/remote-fleet/probe-connection'");
    expect(readOptionalSource(mainApiBoundaryContractPath)).toContain('"/api/remote-fleet/probe"');
    expect(readOptionalSource(mainApiBoundaryContractPath)).toContain('/api/remote-fleet/probe-connection');
    expect(readOptionalSource(mainApiRouteBoundaryPath)).not.toContain('/api/remote-fleet/issue-enrollment-token');
    expect(readOptionalSource(mainApiBoundaryContractPath)).not.toContain('/api/remote-fleet/issue-enrollment-token');
    expect(routeSource).not.toContain('/api/remote-fleet/issue-enrollment-token');
    expect(routeSource).not.toContain('issueEnrollmentToken');
    expect(routeSource).toContain("{ method: 'POST', path: '/api/remote-fleet/install-agent', operationId: 'installAgent' }");
    expect(routeSource).toContain("{ method: 'POST', path: '/api/remote-fleet/revoke-agent', operationId: 'revokeAgent' }");
    expect(readOptionalSource(join(repositoryRoot, 'runtime-host/application/remote-fleet/remote-fleet-agent-ingress.ts')))
      .toContain(`REMOTE_FLEET_RUNTIME_AGENT_INGRESS_PATH = '${remoteFleetRuntimeAgentIngressPath}'`);
    for (const legacyContract of legacyRemoteFleetPublicIngressContracts) {
      expect(routeSource).not.toContain(`{ method: '${legacyContract.method}', path: '${legacyContract.path}', operationId: '${legacyContract.operationId}' }`);
      expect(routeSource).not.toContain(legacyContract.path);
      expect(routeSource).not.toContain(legacyContract.operationId);
    }
    expect(routeSource).not.toMatch(remoteFleetLifecycleRoutePattern);
    expect(routeSource).toContain('await deps.remoteFleetService.invoke(operation.operationId, context.payload)');
  });

  it('keeps the application module worker-backed and lifecycle-owned', () => {
    const moduleSource = readOptionalSource(remoteFleetModulePath);

    expect(moduleSource).toContain('new WorkerBackedRemoteFleetService');
    expect(moduleSource).toContain('remote-fleet-worker-entry.js');
    expect(moduleSource).toContain('capabilityRegistry:');
    expect(moduleSource).toContain("scope.resolve<RemoteFleetCapabilityRegistryPort>('agentRuntime.registry')");
    expect(moduleSource).toContain("container.register('remoteFleet.service'");
    expect(moduleSource).toContain("facades.registerContainerFacade('remote-fleet'");
    expect(moduleSource).toContain("routes.registerDefinitions('remote_fleet'");
    expect(moduleSource).toContain("agentRuntime.capabilityOperationRoutes");
    expect(moduleSource).toContain('createRemoteFleetCapabilityOperationRoutes');
    expect(moduleSource).toContain("name: 'remote-fleet.worker'");
    expect(moduleSource).toContain('closeRemoteFleetWorker(container)');
    expect(moduleSource).not.toMatch(/new\s+InProcess|InProcessRemoteFleet|createInProcessRemoteFleet/i);
  });
});

describe('remote fleet residual scan', () => {
  it('does not wire TeamRun into the first Remote Fleet slice', () => {
    const teamRunCouplings = readRemoteFleetSources()
      .filter((file) => teamRunPattern.test(file.text))
      .map((file) => file.path);

    expect(teamRunCouplings).toEqual([]);
  });

  it('does not introduce an in-process fallback path for Remote Fleet runtime', () => {
    const fallbackSources = readRemoteFleetSources()
      .filter((file) => inProcessFallbackPattern.test(file.text))
      .map((file) => file.path);

    expect(fallbackSources).toEqual([]);
  });

  it('keeps renderer Remote Fleet state out of canonical ownership', () => {
    const rendererSources = existsSync(rendererRoot)
      ? readFileSync(join(rendererRoot, 'lib/host-api.ts'), 'utf8')
      : '';

    expect(rendererSources).not.toMatch(rendererRemoteFleetCanonicalPattern);
  });

  it('routes renderer Remote Fleet lifecycle operations through capabilities execute', () => {
    const lifecycleRouteReferences = readRendererSources()
      .filter((file) => remoteFleetLifecycleRoutePattern.test(file.text))
      .map((file) => file.path);

    expect(lifecycleRouteReferences).toEqual([]);
    expect(readOptionalSource(rendererRemoteFleetStorePath)).toContain('/api/capabilities/execute');
  });

  it('keeps renderer Remote Fleet free of legacy heartbeat ingress and panel residuals', () => {
    const rendererSources = readRendererSources();
    const legacyRendererHeartbeatPatterns = [
      'recordHeartbeat',
      'RemoteFleetRecordHeartbeatInput',
      '/api/remote-fleet/record-heartbeat',
      'RemoteFleetHeartbeatPanel',
    ] as const;

    for (const pattern of legacyRendererHeartbeatPatterns) {
      expect(rendererSources.filter((file) => file.text.includes(pattern)).map((file) => file.path)).toEqual([]);
    }
    expect(existsSync(join(rendererRemoteFleetPageRootPath, 'components/RemoteFleetHeartbeatPanel.tsx'))).toBe(false);
  });

  it('keeps all Remote Fleet HTTP references on the declared or staged route contract', () => {
    const allowedRoutePaths = new Set(remoteFleetAllowedRouteReferencePaths);
    const declaredWebSocketPaths = new Set(remoteFleetWebSocketPaths);
    const unknownReferences = findRemoteFleetRouteReferences()
      .filter((reference) => !allowedRoutePaths.has(reference.routePath))
      .filter((reference) => !declaredWebSocketPaths.has(reference.routePath));

    expect(unknownReferences).toEqual([]);
  });

  it('removes public enrollment token routes and renderer projections while retaining agent lifecycle routes', () => {
    const routeSource = readOptionalSource(remoteFleetRoutePath);
    const rendererProjectionSources = readRendererRemoteFleetProjectionSources();
    const publicEnrollmentTokenResiduals = [
      { path: 'runtime-host/api/routes/remote-fleet-routes.ts', text: routeSource },
      ...rendererProjectionSources,
    ]
      .filter((file) => /issueEnrollmentToken|enrollmentToken/.test(file.text))
      .map((file) => file.path);

    expect(publicEnrollmentTokenResiduals).toEqual([]);
    expect(routeSource).toContain('/api/remote-fleet/install-agent');
    expect(routeSource).toContain('/api/remote-fleet/revoke-agent');
  });

  it('allows first-class connection, environment, and managed resource snapshot projections', () => {
    const storeSource = readOptionalSource(rendererRemoteFleetStorePath);

    expect(storeSource).toContain('readonly connections: readonly RemoteFleetConnectionSummary[];');
    expect(storeSource).toContain('readonly environments: readonly RemoteFleetEnvironmentSummary[];');
    expect(storeSource).toContain('readonly managedResources: readonly RemoteFleetManagedResourceSummary[];');
    expect(storeSource).toContain("'connections' | 'environments' | 'managedResources'");
  });

  it('keeps renderer Remote Fleet projection non-persistent and non-canonical', () => {
    const projectionIssues = readRendererRemoteFleetProjectionSources()
      .filter((file) => rendererStatePersistencePattern.test(file.text) || rendererCanonicalSynthesisPattern.test(file.text))
      .map((file) => file.path);

    expect(projectionIssues).toEqual([]);
  });

  it('keeps the production Remote Fleet renderer on the final-form resource browser path', () => {
    const activeSources = readActiveRemoteFleetPageSources();
    const finalFormIssues = activeSources.flatMap((file) => [
      legacyRemoteFleetInventoryPanelReferencePattern.test(file.text) ? `${file.path}:legacy-inventory-panel` : null,
      legacyRemoteFleetInventoryTabsPattern.test(file.text) ? `${file.path}:2x3-inventory-tabs` : null,
      legacyRemoteFleetFixedRailPattern.test(file.text) ? `${file.path}:fixed-inventory-rail` : null,
      selectionForcedRemountPattern.test(file.text) ? `${file.path}:selection-key-remount` : null,
    ].filter((issue): issue is string => issue !== null));

    expect(activeSources.map((file) => file.path)).toContain('src/pages/RemoteFleet/index.tsx');
    expect(finalFormIssues).toEqual([]);
    expect(existsSync(rendererRemoteFleetInventoryPanelPath) && activeSources.some((file) => file.path === 'src/pages/RemoteFleet/components/RemoteFleetInventoryPanel.tsx')).toBe(false);
  });

  it('keeps Operations consolidated without legacy duplicate controls or helpers', () => {
    const pageSource = readOptionalSource(rendererRemoteFleetPagePath);
    const operationsSource = readOptionalSource(rendererRemoteFleetOperationsPath);

    expect(pageSource).not.toBe('');
    expect(operationsSource).not.toBe('');
    expect(operationsSource).not.toMatch(independentGapsViewPattern);
    expect(pageSource).not.toMatch(topLevelMetricsLoadControlPattern);
    expect(operationsSource).not.toMatch(duplicatedOperationsHelperPattern);
  });

  it('keeps active Remote Fleet UI translation keys present in every common locale', () => {
    const activeSources = readActiveRemoteFleetPageSources();
    const staticKeys = collectRemoteFleetI18nKeys(activeSources);
    const missingKeys = readRemoteFleetCommonLocales().flatMap((localeEntry) => (
      staticKeys
        .filter((key) => !remoteFleetLocaleHasKey(localeEntry.remoteFleet, key))
        .map((key) => `${localeEntry.path}:${key}`)
    ));

    expect(readRemoteFleetCommonLocales().every((localeEntry) => (
      remoteFleetLocaleHasKey(localeEntry.remoteFleet, 'remoteFleet.detail.actions.probeConnection')
    ))).toBe(true);
    expect(staticKeys).toContain('remoteFleet.terminal.errors.remoteError');
    expect(missingKeys).toEqual([]);
  });

  it('keeps terminal control-frame messages out of xterm output and status snapshots', () => {
    const hookSource = readOptionalSource(rendererRemoteFleetTerminalHookPath);
    const typesSource = readOptionalSource(rendererRemoteFleetTerminalTypesPath);
    const textFrameHandler = sourceBetween(hookSource, "if (typeof event.data === 'string') {", 'if (event.data instanceof ArrayBuffer)');
    const snapshotType = sourceBlock(typesSource, /export interface RemoteFleetTerminalStatusSnapshot \{[\s\S]*?\n\}/);

    expect(textFrameHandler).not.toBe('');
    expect(snapshotType).not.toBe('');
    expect(textFrameHandler).not.toMatch(/terminal\.write|\.write\(/);
    expect(textFrameHandler).not.toContain('message: frame.message');
    expect(snapshotType).not.toMatch(/readonly\s+message\??:/);
  });

  it('renders terminal drawer errors from errorKind-localized copy only', () => {
    const drawerSource = readOptionalSource(rendererRemoteFleetTerminalDrawerPath);
    const errorMessageMap = sourceBlock(drawerSource, /const TERMINAL_ERROR_MESSAGES = \{[\s\S]*?\n\} as const satisfies Record<RemoteFleetTerminalErrorKind, \{ readonly key: string; readonly defaultValue: string \}>;/);
    const errorPanel = sourceBetween(drawerSource, '{terminalErrorMessage ? (', '{terminal.snapshot.status ===');

    expect(errorMessageMap).not.toBe('');
    expect(errorPanel).not.toBe('');
    expect(errorMessageMap).toContain('remoteFleet.terminal.errors.remoteError');
    expect(errorPanel).toContain('t(terminalErrorMessage.key');
    expect(errorPanel).not.toMatch(/snapshot\.(?:message|error)|frame\.message|message\}/);
  });

  it('keeps detail navigation in Resource Index and focus styling high-contrast', () => {
    const activeSources = readActiveRemoteFleetPageSources();
    const activeUiIssues = activeSources.flatMap((file) => [
      /lg:flex-row/.test(file.text) ? `${file.path}:lg-flex-row` : null,
      /focus-visible:ring-ring\/(?:20|25|30)/.test(file.text) ? `${file.path}:low-contrast-focus-ring` : null,
    ].filter((issue): issue is string => issue !== null));
    const detailSource = readOptionalSource(rendererRemoteFleetDetailPanelPath);
    const pageSource = readOptionalSource(rendererRemoteFleetPagePath);
    const detailPanel = sourceBetween(pageSource, 'const detailPanel = (', 'return (');

    expect(detailSource).not.toContain('function RelationshipChain(');
    expect(detailSource).not.toContain('relationshipSteps');
    expect(detailSource).not.toContain('onSelect({ kind: item.kind, id: item.id })');
    expect(detailSource).not.toContain("onSelect({ kind: 'runtime', id: relatedRuntime.id })");
    expect(detailPanel).not.toContain('onSelect={selectFromIndex}');
    expect(activeUiIssues).toEqual([]);
  });

  it('keeps the Remote Fleet workspace height constrained to pane-owned scroll containers', () => {
    const pageSource = readOptionalSource(rendererRemoteFleetPagePath);
    const operationsSource = readOptionalSource(rendererRemoteFleetOperationsPath);
    const resourceBrowserSource = readOptionalSource(join(rendererRemoteFleetPageRootPath, 'components/RemoteFleetResourceBrowser.tsx'));

    expect(pageSource).toContain('className="mx-auto flex h-full min-h-0 w-full max-w-[1800px] flex-col gap-3"');
    expect(pageSource).toContain('className="min-h-0 flex-1 overflow-hidden"');
    expect(pageSource).toContain('className="h-full min-h-0 overflow-hidden rounded-2xl border border-border/70 bg-card"');
    expect(pageSource).not.toMatch(/min-h-\[(?:32|38)rem\][^"']*overflow-hidden/);
    expect(resourceBrowserSource).toContain("'grid h-full min-h-0 min-w-0 bg-card'");
    expect(operationsSource).toContain("'h-full min-h-0 min-w-0 bg-card'");
    expect(operationsSource).toContain('className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-5"');
  });

  it('keeps Operations history layout driven by workspace layout instead of viewport breakpoints', () => {
    const operationsSource = readOptionalSource(rendererRemoteFleetOperationsPath);
    const commandsPanel = sourceBetween(operationsSource, 'function CommandsPanel(', 'function AuditPanel(');
    const auditPanel = sourceBetween(operationsSource, 'function AuditPanel(', 'export function RemoteFleetOperationsSection(');

    expect(commandsPanel).not.toBe('');
    expect(auditPanel).not.toBe('');
    for (const panelSource of [commandsPanel, auditPanel]) {
      expect(panelSource).toContain("layout === 'wide'");
      expect(panelSource).toContain("layout === 'compact'");
      expect(panelSource).toContain("'grid-cols-1'");
      expect(panelSource).not.toMatch(/\blg:/);
    }
  });

  it('keeps terminal tickets and raw terminal bytes out of renderer state projection', () => {
    const storeSource = readOptionalSource(rendererRemoteFleetStorePath);
    const stateSource = /export type RemoteFleetState = \{[\s\S]*?\n\};/.exec(storeSource)?.[0] ?? '';
    const sessionSummarySource = /export interface RemoteFleetTerminalSessionSummary \{[\s\S]*?\n\}/.exec(storeSource)?.[0] ?? '';

    expect(stateSource).not.toBe('');
    expect(sessionSummarySource).not.toBe('');
    expect(stateSource).not.toMatch(rendererSecretProjectionPattern);
    expect(stateSource).not.toMatch(terminalTicketStoragePattern);
    expect(sessionSummarySource).not.toMatch(rendererSecretProjectionPattern);
  });

  it('keeps Electron main Remote Fleet boundary free of duplicated endpoint/auth policy', () => {
    const policyIssues = readElectronRemoteFleetBoundarySources()
      .filter((file) => mainPolicyDuplicatePattern.test(file.text))
      .map((file) => file.path);

    expect(policyIssues).toEqual([]);
  });

  it('keeps Remote Fleet providers from reading renderer state directly', () => {
    const rendererStateCouplings = readRemoteFleetPolicyBoundarySources()
      .filter((file) => providerDirectRendererStatePattern.test(file.text))
      .map((file) => file.path);

    expect(rendererStateCouplings).toEqual([]);
  });

  it('keeps removeNode free of provider cleanup shortcuts', () => {
    const runtimeSource = readOptionalSource(join(repositoryRoot, 'runtime-host/application/remote-fleet/remote-fleet-runtime.ts'));
    const removeNodeSource = /private async removeNode[\s\S]*?\n {2}private async probeNode/.exec(runtimeSource)?.[0] ?? '';

    expect(removeNodeSource).not.toBe('');
    expect(removeNodeSource).not.toMatch(removeNodeDirectProviderCleanupPattern);
    expect(removeNodeSource).not.toContain('deleteEnvironment');
  });

  it('keeps Remote Fleet connection copy with SSH and VM registration', () => {
    const localeEntries = readRemoteFleetCommonLocales();

    for (const localeEntry of localeEntries) {
      const isChineseLocale = localeEntry.path.includes('/zh/') || localeEntry.path.includes('\\zh\\');
      const isEnglishLocale = localeEntry.path.includes('/en/') || localeEntry.path.includes('\\en\\');
      const registrationTrigger = readNestedString(localeEntry.remoteFleet, 'registration.trigger');
      const sshTargetKind = readNestedString(localeEntry.remoteFleet, 'registration.targetKinds.ssh-host');
      const vmTargetKind = readNestedString(localeEntry.remoteFleet, 'registration.targetKinds.vm');
      const inventoryConsoleTitle = readNestedString(localeEntry.remoteFleet, 'inventory.consoleTitle');
      const inventoryConsoleDescription = readNestedString(localeEntry.remoteFleet, 'inventory.consoleDescription');
      const inventoryConnectionsTab = readNestedString(localeEntry.remoteFleet, 'inventory.tabs.connections');
      const inventoryEnvironmentsTab = readNestedString(localeEntry.remoteFleet, 'inventory.tabs.environments');
      const inventoryManagedResourcesTab = readNestedString(localeEntry.remoteFleet, 'inventory.tabs.managedResources');
      const inventoryNodesTab = readNestedString(localeEntry.remoteFleet, 'inventory.tabs.nodes');
      const detailNodeKind = readNestedString(localeEntry.remoteFleet, 'detail.kinds.node');
      const inventoryAgentsTab = readNestedString(localeEntry.remoteFleet, 'inventory.tabs.agents');
      const inventoryRuntimesTab = readNestedString(localeEntry.remoteFleet, 'inventory.tabs.runtimes');
      const inventoryEndpointsTab = readNestedString(localeEntry.remoteFleet, 'inventory.tabs.endpoints');
      const onlineStatus = readNestedString(localeEntry.remoteFleet, 'statuses.online');
      const enrolledStatus = readNestedString(localeEntry.remoteFleet, 'statuses.enrolled');
      const readyStatus = readNestedString(localeEntry.remoteFleet, 'statuses.ready');
      const missingRegistrationCopy = remoteFleetRegistrationRequiredCopyKeyPaths
        .filter((keyPath) => readNestedString(localeEntry.remoteFleet, keyPath) === '');

      expect(missingRegistrationCopy).toEqual([]);

      if (isChineseLocale) {
        expect(registrationTrigger).toBe('添加连接');
        expect(sshTargetKind).toBe('SSH 主机');
        expect(vmTargetKind).toBe('虚拟机');
        expect(inventoryConsoleTitle).toBe('资源清单');
        expect(inventoryConsoleDescription).toBe('选择连接、环境、资源、节点、代理、运行时或端点，再在右侧工作区查看详情。');
        expect(inventoryConnectionsTab).toBe('连接');
        expect(inventoryEnvironmentsTab).toBe('环境');
        expect(inventoryManagedResourcesTab).toBe('资源');
        expect(inventoryNodesTab).toBe('节点');
        expect(detailNodeKind).toBe('节点');
        expect(inventoryAgentsTab).toBe('代理');
        expect(inventoryRuntimesTab).toBe('运行时');
        expect(inventoryEndpointsTab).toBe('端点');
        expect(onlineStatus).toBe('在线');
        expect(enrolledStatus).toBe('已注册');
        expect(readyStatus).toBe('就绪');
      } else if (isEnglishLocale) {
        expect(registrationTrigger).toBe('Add connection');
        expect(sshTargetKind).toBe('SSH host');
        expect(vmTargetKind).toBe('VM');
        expect(inventoryConsoleTitle).toBe('Fleet inventory');
        expect(inventoryConsoleDescription).toBe('Select a connection, environment, resource, node, agent, runtime, or endpoint, then inspect it in the workspace.');
        expect(inventoryConnectionsTab).toBe('Connections');
        expect(inventoryEnvironmentsTab).toBe('Environments');
        expect(inventoryManagedResourcesTab).toBe('Resources');
        expect(inventoryNodesTab).toBe('Nodes');
        expect(detailNodeKind).toBe('Node');
        expect(inventoryAgentsTab).toBe('Agents');
        expect(inventoryRuntimesTab).toBe('Runtimes');
        expect(inventoryEndpointsTab).toBe('Endpoints');
        expect(onlineStatus).toBe('Online');
        expect(enrolledStatus).toBe('Enrolled');
        expect(readyStatus).toBe('Ready');
      } else {
        expect(registrationTrigger).not.toBe('');
        expect(sshTargetKind).not.toBe('');
        expect(vmTargetKind).not.toBe('');
        expect(inventoryConsoleTitle).not.toBe('');
        expect(inventoryConsoleDescription).not.toBe('');
        expect(inventoryConnectionsTab).not.toBe('');
        expect(inventoryEnvironmentsTab).not.toBe('');
        expect(inventoryManagedResourcesTab).not.toBe('');
        expect(inventoryNodesTab).not.toBe('');
        expect(detailNodeKind).not.toBe('');
        expect(inventoryAgentsTab).not.toBe('');
        expect(inventoryRuntimesTab).not.toBe('');
        expect(inventoryEndpointsTab).not.toBe('');
        expect(onlineStatus).not.toBe('');
        expect(enrolledStatus).not.toBe('');
        expect(readyStatus).not.toBe('');
      }

      const copy = JSON.stringify(localeEntry.remoteFleet);
      for (const fakeCopyPattern of remoteFleetFakeCopyPatterns) {
        expect(copy).not.toMatch(fakeCopyPattern);
      }
    }
  });

  it('keeps Remote Fleet main copy and page snapshot fixture free of secret transport terms', () => {
    const mainCopyIssues = readRemoteFleetCommonLocales().flatMap((localeEntry) => (
      remoteFleetMainCopyKeyPaths
        .map((keyPath) => ({ path: `${localeEntry.path}:${keyPath}`, text: readNestedString(localeEntry.remoteFleet, keyPath) }))
        .filter((copyItem) => remoteFleetMainCopySecretPattern.test(copyItem.text))
        .map((copyItem) => copyItem.path)
    ));
    const pageTestSource = readOptionalSource(remoteFleetPageTestPath);
    const snapshotFixtureSource = /const snapshotProjection = \{[\s\S]*?\n\};\n\nconst metricsProjection/.exec(pageTestSource)?.[0] ?? '';

    expect(mainCopyIssues).toEqual([]);
    expect(snapshotFixtureSource).not.toBe('');
    expect(snapshotFixtureSource).not.toMatch(remoteFleetSnapshotFixtureSecretPattern);
  });
});
