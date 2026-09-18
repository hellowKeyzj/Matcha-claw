import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isRecord, sendLoopbackJson } from '../client';
import {
  logSessionTrace,
  traceHeader,
} from '../sessions/trace';

const POLICY_READ_ENDPOINT = '/api/security/policy/current';
const AUDIT_READ_ENDPOINT = '/api/security/audit/current';
const OPERATION_ENDPOINT = '/api/security/operation';
const MAX_OPERATION_TEXT_BYTES = 4 * 1024;
const MAX_OPERATION_ACTIONS = 256;
const MAX_OPERATION_RESPONSE_BYTES = 256 * 1024;
const SECURITY_OPERATION_IDS = [
  'security.quickAudit',
  'security.checkIntegrity',
  'security.rebaselineIntegrity',
  'security.scanSkills',
  'security.checkAdvisories',
  'security.previewRemediation',
  'security.applyRemediation',
  'security.rollbackRemediation',
] as const;
const POLICY_PRESETS = ['strict', 'balanced', 'relaxed'] as const;
const POLICY_ACTIONS = ['block', 'redact', 'confirm', 'warn', 'log'] as const;
const POLICY_FAILURE_MODES = ['block_all', 'safe_mode', 'read_only'] as const;
const POLICY_RUNTIME_BOOLEAN_FIELDS = [
  'autoHarden',
  'auditOnGatewayStart',
  'runtimeGuardEnabled',
  'enablePromptInjectionGuard',
  'blockDestructive',
  'blockSecrets',
] as const;
const POLICY_RUNTIME_LIST_FIELDS = [
  'allowPathPrefixes',
  'allowDomains',
  'auditEgressAllowlist',
  'promptInjectionPatterns',
  'destructivePatterns',
  'secretPatterns',
] as const;
const POLICY_MONITOR_FIELDS = ['credentials', 'memory', 'cost'] as const;
const POLICY_LOGGING_FIELDS = ['logDetections'] as const;
const POLICY_ALLOWLIST_FIELDS = ['tools', 'sessions'] as const;
const POLICY_SEVERITY_FIELDS = ['critical', 'high', 'medium', 'low'] as const;
const POLICY_DESTRUCTIVE_CATEGORY_FIELDS = [
  'fileDelete',
  'gitDestructive',
  'sqlDestructive',
  'systemDestructive',
  'processKill',
  'networkDestructive',
  'privilegeEscalation',
] as const;

const UNAVAILABLE = {
  success: false,
  error: 'Security policy is unavailable',
} as const;

const REJECTED = {
  success: false,
  error: 'Security policy request was rejected',
} as const;

const OPERATION_INVALID = {
  success: false,
  error: 'Security operation request is invalid',
} as const;

const OPERATION_UNAUTHORIZED = {
  success: false,
  error: 'Security operation authorization is invalid',
} as const;

const OPERATION_UNAVAILABLE = {
  success: false,
  error: 'Security operation is unavailable',
} as const;

const OPERATION_REJECTED = {
  success: false,
  error: 'Security operation was rejected',
} as const;

export type SecurityAuditItem = Readonly<{
  ts: number;
  toolName: string;
  risk: 'critical' | 'high' | 'medium' | 'low' | 'info';
  action: 'audit' | 'allow' | 'block';
  decision: string;
  ruleId?: string;
}>;

export type SecurityAuditResponse = Readonly<{
  page: number;
  pageSize: number;
  total: number;
  items: readonly SecurityAuditItem[];
}>;

export type SecurityPolicyRequest = Readonly<{
  id: 'security.policy';
  operationId: 'security.replace';
  scope: Readonly<{ kind: 'security-policy' }>;
  target: Readonly<{ kind: 'security-policy' }>;
  input: Readonly<{
    policy: Record<string, unknown>;
  }>;
}>;

export type SecurityOperationId = (typeof SECURITY_OPERATION_IDS)[number];
export type SecurityOperationScopeKind = 'security-policy' | 'security-remediation';
export type SecurityOperationRequest = Readonly<{
  id: 'security.operation';
  operationId: SecurityOperationId;
  scope: Readonly<{ kind: SecurityOperationScopeKind }>;
  target: Readonly<{ kind: SecurityOperationScopeKind; snapshotId?: string }>;
  input: Readonly<Record<string, unknown>>;
}>;

export type SecurityOperationResponse = Readonly<{
  status: 200;
  body: Record<string, unknown>;
}> | Readonly<{
  status: 400;
  body: typeof OPERATION_INVALID;
}> | Readonly<{
  status: 401;
  body: typeof OPERATION_UNAUTHORIZED;
}> | Readonly<{
  status: 422;
  body: typeof OPERATION_REJECTED;
}> | Readonly<{
  status: 503;
  body: typeof OPERATION_UNAVAILABLE;
}>;

export type SecurityPolicyReceipt = Readonly<{
  desired: Readonly<{
    revision: number;
    outcome: 'confirmed' | 'outcome_unknown';
  }>;
}>;

export type SecurityPolicyTransportResponse = Readonly<{
  status: 200;
  body: SecurityPolicyReceipt;
}> | Readonly<{
  status: 422 | 503;
  body: typeof REJECTED | typeof UNAVAILABLE;
}>;

export interface SecurityPolicyTransport {
  operate(request: SecurityOperationRequest): Promise<SecurityOperationResponse>;
  read(traceId?: string | null): Promise<Record<string, unknown> | null>;
  readAudit(page: number, pageSize: number): Promise<SecurityAuditResponse | null>;
  submit(request: SecurityPolicyRequest): Promise<SecurityPolicyTransportResponse>;
}

export function createSecurityPolicyTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): SecurityPolicyTransport {
  return {
    async operate(request: SecurityOperationRequest): Promise<SecurityOperationResponse> {
      if (!isSecurityOperationRequest(request)) {
        return { status: 400, body: OPERATION_INVALID };
      }
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: OPERATION_ENDPOINT,
        issuer,
        decision: {
          endpoint: OPERATION_ENDPOINT,
          scope: 'security:operate',
          capability: request.operationId,
          subject: 'security-operation',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      const body = response?.body;
      if (
        response?.status === 200
        && isBoundedOperationResponse(body, request.operationId)
        && Buffer.byteLength(JSON.stringify(body), 'utf8') <= MAX_OPERATION_RESPONSE_BYTES
      ) {
        return { status: 200, body };
      }
      if (response?.status === 400 && isExact(body, OPERATION_INVALID)) {
        return { status: 400, body: OPERATION_INVALID };
      }
      if (response?.status === 401 && isExact(body, OPERATION_UNAUTHORIZED)) {
        return { status: 401, body: OPERATION_UNAUTHORIZED };
      }
      if (response?.status === 422 && isExact(body, OPERATION_REJECTED)) {
        return { status: 422, body: OPERATION_REJECTED };
      }
      return { status: 503, body: OPERATION_UNAVAILABLE };
    },
    async read(traceId?: string | null): Promise<Record<string, unknown> | null> {
      const startedAt = Date.now();
      logSessionTrace('electron.security.policy.transport.request', traceId, {
        endpoint: POLICY_READ_ENDPOINT,
      });
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: POLICY_READ_ENDPOINT,
        issuer,
        decision: {
          endpoint: POLICY_READ_ENDPOINT,
          scope: 'security:read',
          capability: 'security.read',
          subject: 'policy-read',
        },
        method: 'GET',
        fetcher,
        headers: traceHeader(traceId),
      });
      if (response === null) {
        logSessionTrace('electron.security.policy.transport.failure', traceId, {
          elapsedMs: Date.now() - startedAt,
        });
        return null;
      }
      const contract = response.status === 200 ? policyContract(response.body) : 'http-status';
      const valid = contract === 'policy';
      logSessionTrace('electron.security.policy.transport.response', traceId, {
        status: response.status,
        contract,
        elapsedMs: Date.now() - startedAt,
      });
      return valid ? response.body as Record<string, unknown> : null;
    },
    async readAudit(page: number, pageSize: number): Promise<SecurityAuditResponse | null> {
      if (!isPositiveInteger(page) || !isPositiveInteger(pageSize) || page > 10_000 || pageSize > 200) return null;
      const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: AUDIT_READ_ENDPOINT,
        issuer,
        decision: {
          endpoint: AUDIT_READ_ENDPOINT,
          scope: 'security:read',
          capability: 'security.read',
          subject: 'audit-read',
        },
        method: 'GET',
        fetcher,
        query,
      });
      return response?.status === 200 && isAuditResponse(response.body, page, pageSize) ? response.body : null;
    },
    async submit(request): Promise<SecurityPolicyTransportResponse> {
      const response = await sendLoopbackJson({
        port: runtimeHostTransportPort,
        path: '/api/security/policy',
        issuer,
        decision: {
          endpoint: '/api/security/policy',
          scope: 'security:write',
          capability: 'security.replace',
          subject: 'security-policy',
        },
        method: 'POST',
        fetcher,
        body: request,
      });
      if (response?.status === 200 && isReceipt(response.body)) return { status: 200, body: response.body };
      if (response?.status === 422 && isExact(response.body, REJECTED)) return { status: 422, body: REJECTED };
      return { status: 503, body: UNAVAILABLE };
    },
  };
}

export function isSecurityOperationRequest(value: unknown): value is SecurityOperationRequest {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'operationId', 'scope', 'target', 'input'])
    || value.id !== 'security.operation'
    || typeof value.operationId !== 'string'
    || !SECURITY_OPERATION_IDS.includes(value.operationId as SecurityOperationId)
    || !isRecord(value.scope)
    || !hasExactKeys(value.scope, ['kind'])
    || !isRecord(value.target)
    || !isRecord(value.input)) return false;
  const expectedKind = operationScopeKind(value.operationId as SecurityOperationId);
  if (value.scope.kind !== expectedKind || value.target.kind !== expectedKind) return false;
  if (value.operationId === 'security.rollbackRemediation') {
    if (!hasExactKeys(value.target, value.target.snapshotId === undefined ? ['kind'] : ['kind', 'snapshotId'])) return false;
    if (value.target.snapshotId !== undefined
      && (!isBoundedText(value.target.snapshotId) || value.input.snapshotId !== value.target.snapshotId)) return false;
  } else if (!hasExactKeys(value.target, ['kind'])) {
    return false;
  }
  return isOperationInput(value.operationId as SecurityOperationId, value.input);
}

function operationScopeKind(operationId: SecurityOperationId): SecurityOperationScopeKind {
  return operationId === 'security.previewRemediation'
    || operationId === 'security.applyRemediation'
    || operationId === 'security.rollbackRemediation'
    ? 'security-remediation'
    : 'security-policy';
}

function isOperationInput(operationId: SecurityOperationId, input: Record<string, unknown>): boolean {
  if (operationId === 'security.scanSkills') {
    return Object.keys(input).length === 0
      || (hasExactKeys(input, ['scanPath']) && isBoundedText(input.scanPath));
  }
  if (operationId === 'security.checkAdvisories') {
    return Object.keys(input).length === 0
      || (hasExactKeys(input, ['feedUrl']) && (input.feedUrl === null || isBoundedText(input.feedUrl)));
  }
  if (operationId === 'security.applyRemediation') {
    return Object.keys(input).length === 0
      || (hasExactKeys(input, ['actions'])
        && Array.isArray(input.actions)
        && input.actions.length <= MAX_OPERATION_ACTIONS
        && input.actions.every(isBoundedText));
  }
  if (operationId === 'security.rollbackRemediation') {
    return Object.keys(input).length === 0
      || (hasExactKeys(input, ['snapshotId'])
        && (input.snapshotId === null || isBoundedText(input.snapshotId)));
  }
  return Object.keys(input).length === 0;
}

function isBoundedText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= MAX_OPERATION_TEXT_BYTES
    && ![...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
}

function isBoundedOperationResponse(
  value: unknown,
  operationId: SecurityOperationId,
): value is Record<string, unknown> {
  if (!isSafeOperationPublicValue(value) || !isRecord(value)) return false;
  if (value.backend !== 'security-core') return false;
  switch (operationId) {
    case 'security.quickAudit':
      return hasExactKeys(value, ['backend', 'startupAudit', 'integrity', 'skillScan', 'advisories'])
        && isStartupAudit(value.startupAudit)
        && isIntegrity(value.integrity)
        && isSkillScan(value.skillScan)
        && isAdvisories(value.advisories);
    case 'security.checkIntegrity':
      return hasExactKeys(value, ['backend', 'checked', 'tampered', 'missing', 'noBaseline', 'items'])
        && isIntegrity(value);
    case 'security.rebaselineIntegrity':
      return hasExactKeys(value, ['backend', 'created', 'files'])
        && isBoundedCount(value.created)
        && isBoundedArray(value.files, isSafeText);
    case 'security.scanSkills':
      return hasExactKeys(value, ['backend', 'total', 'suspicious', 'clean', 'skills'])
        && isSkillScan(value);
    case 'security.checkAdvisories':
      return hasExactKeys(value, ['backend', 'reachable', 'advisories', 'criticalOrHigh'])
        && isAdvisories(value);
    case 'security.previewRemediation':
      return hasExactKeys(value, ['backend', 'actions'])
        && isBoundedArray(value.actions, isRemediationAction);
    case 'security.applyRemediation':
      return hasExactKeys(value, ['backend', 'actions', 'snapshotId', 'applied'])
        && isBoundedArray(value.actions, isSafeText)
        && isSafeText(value.snapshotId)
        && typeof value.applied === 'boolean';
    case 'security.rollbackRemediation':
      return hasExactKeys(value, ['backend', 'snapshotId', 'restored'])
        && isSafeText(value.snapshotId)
        && isBoundedCount(value.restored);
  }
}

function isStartupAudit(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['ok', 'checks', 'issues'])
    && typeof value.ok === 'boolean'
    && isBoundedCount(value.checks, 500)
    && isBoundedCount(value.issues, 500)
    && value.issues <= value.checks;
}

function isIntegrity(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['checked', 'tampered', 'missing', 'noBaseline', 'items'])
    && isBoundedCount(value.checked)
    && isBoundedCount(value.tampered)
    && isBoundedCount(value.missing)
    && isBoundedCount(value.noBaseline)
    && isBoundedArray(value.items, isIntegrityItem);
}

function isIntegrityItem(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['file', 'status'])
    && isSafeText(value.file)
    && ['intact', 'tampered', 'missing', 'no-baseline'].includes(String(value.status));
}

function isSkillScan(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['total', 'suspicious', 'clean', 'skills'])
    && isBoundedCount(value.total)
    && isBoundedCount(value.suspicious)
    && isBoundedCount(value.clean)
    && isBoundedArray(value.skills, isSkill);
}

function isSkill(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['name', 'safe', 'issues'])
    && isSafeText(value.name)
    && typeof value.safe === 'boolean'
    && isBoundedArray(value.issues, isSkillIssue);
}

function isSkillIssue(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'severity'])
    && isSafeText(value.id)
    && ['critical', 'high', 'medium'].includes(String(value.severity));
}

function isAdvisories(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['reachable', 'advisories', 'criticalOrHigh'])
    && typeof value.reachable === 'boolean'
    && isBoundedArray(value.advisories, isAdvisory)
    && isBoundedArray(value.criticalOrHigh, isAdvisory);
}

function isAdvisory(value: unknown): boolean {
  return isRecord(value)
    && (Object.keys(value).length === 3 || Object.keys(value).length === 4)
    && Object.keys(value).every((key) => ['id', 'severity', 'title', 'action'].includes(key))
    && isSafeText(value.id)
    && isSafeText(value.severity)
    && isSafeText(value.title)
    && (value.action === undefined || isSafeText(value.action));
}

function isRemediationAction(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['id', 'title', 'risk'])
    && isSafeText(value.id)
    && isSafeText(value.title)
    && ['critical', 'high', 'medium', 'low'].includes(String(value.risk));
}

function isBoundedArray(value: unknown, predicate: (value: unknown) => boolean): boolean {
  return Array.isArray(value) && value.length <= 256 && value.every(predicate);
}

function isBoundedCount(value: unknown, maximum = 100_000): value is number {
  return isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isSafeOperationPublicValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') <= 4096
      && ![...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint < 0x20 || codePoint === 0x7f;
      })
      && !isPublicPathLike(value);
  }
  if (Array.isArray(value)) {
    return value.length <= 256 && value.every((item) => isSafeOperationPublicValue(item, depth + 1));
  }
  if (!isRecord(value) || Object.keys(value).length > 64) return false;
  return Object.entries(value).every(([key, item]) =>
    /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(key)
    && !/^(authorization|accessToken|apiKey|credential|credentialReference|password|privateKey|rawError|stack|error|detail|native|path|secret|token)$/i.test(key)
    && isSafeOperationPublicValue(item, depth + 1)
  );
}

function isPublicPathLike(value: string): boolean {
  return /^[A-Za-z]:[\\\\/]/.test(value)
    || value.startsWith('\\\\')
    || value.startsWith('/')
    || /^file:/i.test(value);
}

function isPolicy(value: unknown): value is Record<string, unknown> {
  return policyContract(value) === 'policy';
}

function policyContract(value: unknown): string {
  if (!isRecord(value)) return 'not-object';
  if (!hasExactKeys(value, ['preset', 'securityPolicyVersion', 'runtime'])) return 'policy-keys';
  if (!POLICY_PRESETS.includes(value.preset as never)) return 'preset';
  if (!isPositiveInteger(value.securityPolicyVersion)) return 'version';
  const runtimeContract = policyRuntimeContract(value.runtime);
  if (runtimeContract !== 'runtime') return runtimeContract;
  return 'policy';
}

function policyRuntimeContract(value: unknown): string {
  if (!isExactRecord(value, [
    ...POLICY_RUNTIME_BOOLEAN_FIELDS,
    ...POLICY_RUNTIME_LIST_FIELDS,
    'auditDailyCostLimitUsd',
    'auditFailureMode',
    'monitors',
    'logging',
    'allowlist',
    'destructive',
    'secrets',
  ])) return 'runtime-keys';
  if (!POLICY_RUNTIME_BOOLEAN_FIELDS.every((field) => typeof value[field] === 'boolean')) return 'runtime-booleans';
  if (!POLICY_RUNTIME_LIST_FIELDS.every((field) => isPolicyStringList(value[field]))) return 'runtime-lists';
  if (typeof value.auditDailyCostLimitUsd !== 'number'
    || !Number.isFinite(value.auditDailyCostLimitUsd)
    || value.auditDailyCostLimitUsd <= 0
    || value.auditDailyCostLimitUsd > Number.MAX_SAFE_INTEGER) return 'runtime-cost-limit';
  if (value.auditFailureMode !== null && !POLICY_FAILURE_MODES.includes(value.auditFailureMode as never)) return 'runtime-failure-mode';
  if (!isBooleanRecord(value.monitors, POLICY_MONITOR_FIELDS)) return 'runtime-monitors';
  if (!isBooleanRecord(value.logging, POLICY_LOGGING_FIELDS)) return 'runtime-logging';
  if (!isStringListRecord(value.allowlist, POLICY_ALLOWLIST_FIELDS)) return 'runtime-allowlist';
  if (!isActionPolicy(value.destructive, true)) return 'runtime-destructive';
  if (!isActionPolicy(value.secrets, false)) return 'runtime-secrets';
  return 'runtime';
}

function isActionPolicy(value: unknown, withCategories: boolean): boolean {
  const keys = withCategories ? ['action', 'severityActions', 'categories'] : ['action', 'severityActions'];
  if (!isExactRecord(value, keys)) return false;
  return POLICY_ACTIONS.includes(value.action as never)
    && isActionRecord(value.severityActions, POLICY_SEVERITY_FIELDS)
    && (!withCategories || isBooleanRecord(value.categories, POLICY_DESTRUCTIVE_CATEGORY_FIELDS));
}

function isPolicyStringList(value: unknown): boolean {
  return Array.isArray(value)
    && value.length <= 256
    && value.every((item) => typeof item === 'string'
      && item.length > 0
      && item.length <= 4096
      && ![...item].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f));
}

function isBooleanRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isExactRecord(value, keys) && keys.every((key) => typeof value[key] === 'boolean');
}

function isStringListRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isExactRecord(value, keys) && keys.every((key) => isPolicyStringList(value[key]));
}

function isActionRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isExactRecord(value, keys) && keys.every((key) => POLICY_ACTIONS.includes(value[key] as never));
}

function isAuditResponse(value: unknown, page: number, pageSize: number): value is SecurityAuditResponse {
  if (!isRecord(value) || !hasExactKeys(value, ['page', 'pageSize', 'total', 'items'])) return false;
  if (value.page !== page || value.pageSize !== pageSize || !isSafeInteger(value.total) || value.total < 0 || value.total > 5_000) return false;
  return Array.isArray(value.items) && value.items.length <= pageSize && value.items.every(isAuditItem);
}

function isAuditItem(value: unknown): value is SecurityAuditItem {
  if (!isRecord(value) || (Object.keys(value).length !== 5 && Object.keys(value).length !== 6)) return false;
  if (!hasExactKeys(value, value.ruleId === undefined
    ? ['ts', 'toolName', 'risk', 'action', 'decision']
    : ['ts', 'toolName', 'risk', 'action', 'decision', 'ruleId'])) return false;
  return isSafeInteger(value.ts)
    && value.ts > 0
    && isSafeText(value.toolName)
    && ['critical', 'high', 'medium', 'low', 'info'].includes(String(value.risk))
    && ['audit', 'allow', 'block'].includes(String(value.action))
    && isSafeText(value.decision)
    && (value.ruleId === undefined || isSafeText(value.ruleId));
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isSafeInteger(value) && value > 0;
}

function isSafeText(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 256
    && !value.includes('\0')
    && !/[\r\n]/.test(value)
    && /^[A-Za-z0-9._-]+$/.test(value);
}

function isReceipt(value: unknown): value is SecurityPolicyReceipt {
  if (!isRecord(value) || !hasExactKeys(value, ['desired']) || !isRecord(value.desired)) return false;
  return hasExactKeys(value.desired, ['revision', 'outcome'])
    && typeof value.desired.revision === 'number'
    && Number.isSafeInteger(value.desired.revision)
    && value.desired.revision > 0
    && (value.desired.outcome === 'confirmed' || value.desired.outcome === 'outcome_unknown');
}

function isExact(value: unknown, expected: Record<string, unknown>): boolean {
  return isRecord(value)
    && hasExactKeys(value, Object.keys(expected))
    && Object.entries(expected).every(([key, expectedValue]) => value[key] === expectedValue);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && hasExactKeys(value, keys);
}
