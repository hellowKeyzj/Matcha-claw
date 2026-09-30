import type { CallReceipt } from '../../../../../src/types/call-log';
import { decodeCallReceipt } from '../../../../../src/types/call-log/receipt';
import type { RuntimeHostDeliveryIssuer } from '../../issuer';
import { hasExactKeys, isNonEmptyBoundedText, isRecord, sendLoopbackJson } from '../client';

const ROUTE_PATH = '/api/team/skill';
const UNAVAILABLE = {
  success: false,
  error: 'TeamSkill selection is unavailable',
} as const;

type TeamSkillSelectionId = `teamskill:v1:${string}`;
type TeamSkillDependencyKind = 'skill' | 'tool';
type TeamSkillDependencyStatus = 'available' | 'missing';
type TeamSkillDependencySeverity = 'ok' | 'warning' | 'blocker';

export type TeamSkillPackageValidation =
  | Readonly<{
      status: 'valid';
      package: Readonly<{
        selectionId: TeamSkillSelectionId;
        name: string;
        version: string;
        kind: 'team-skill';
        description: string;
      }>;
    }>
  | Readonly<{ status: 'invalid' | 'unavailable' }>;

export type TeamSkillDependencyPlan = Readonly<{
  selectionId: TeamSkillSelectionId;
  packageName: string;
  packageVersion: string;
  items: readonly Readonly<{
    kind: TeamSkillDependencyKind;
    name: string;
    required: boolean;
    purpose: string;
    status: TeamSkillDependencyStatus;
    severity: TeamSkillDependencySeverity;
    installable: boolean;
  }>[];
  canProceed: boolean;
}>;

export type TeamSkillDependencyPlanResult =
  | Readonly<{ status: 'available'; plan: TeamSkillDependencyPlan }>
  | Readonly<{ status: 'invalid' | 'unavailable' }>;

export type TeamSkillTransportResponse<T> = Readonly<{
  status: 200 | 503;
  body: T | typeof UNAVAILABLE;
}>;

export interface TeamSkillTransport {
  authorize(packageRoot: string): Promise<TeamSkillTransportResponse<Readonly<{ selectionId: TeamSkillSelectionId }>>>;
  validate(selectionId: string): Promise<TeamSkillTransportResponse<TeamSkillPackageValidation>>;
  dependencyPlan(selectionId: string): Promise<TeamSkillTransportResponse<TeamSkillDependencyPlanResult>>;
  materialize(
    selectionId: string,
    teamId: string,
    idempotencyKey: string,
  ): Promise<Readonly<{ status: 202 | 503; body: CallReceipt | typeof UNAVAILABLE }>>;
}

export function createTeamSkillTransport(
  issuer: RuntimeHostDeliveryIssuer,
  runtimeHostTransportPort: number,
  fetcher: typeof fetch = fetch,
): TeamSkillTransport {
  return {
    authorize: async (packageRoot) => request(
      'team.skill.authorize',
      { operation: 'team.skill.authorize', packageRoot },
      isAuthorized,
    ),
    validate: async (selectionId) => request(
      'team.skill.validate',
      { operation: 'team.skill.validate', selectionId },
      isValidation,
    ),
    dependencyPlan: async (selectionId) => request(
      'team.skill.dependency-plan',
      { operation: 'team.skill.dependency-plan', selectionId },
      isDependencyPlan,
    ),
    materialize: async (selectionId, teamId, idempotencyKey) => request(
      'team.skill.materialize',
      { operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey },
      (value): value is CallReceipt => { try { decodeCallReceipt(value); return true; } catch { return false; } },
      202,
    ),
  };

  async function request<T, S extends 200 | 202 = 200>(
    capability: string,
    body: unknown,
    isResponse: (value: unknown) => value is T,
    successStatus: S = 200 as S,
  ): Promise<Readonly<{ status: S | 503; body: T | typeof UNAVAILABLE }>> {
    if (!isRequest(body)) return { status: 503, body: UNAVAILABLE };
    const response = await sendLoopbackJson({
      port: runtimeHostTransportPort,
      path: ROUTE_PATH,
      issuer,
      decision: {
        endpoint: ROUTE_PATH,
        scope: 'team:write',
        capability,
        subject: 'team-skill-selection',
      },
      method: 'POST',
      fetcher,
      body,
    });
    if (response?.status === successStatus && isResponse(response.body)) return { status: successStatus, body: response.body };
    return { status: 503, body: UNAVAILABLE };
  }
}

function isRequest(value: unknown): boolean {
  if (!isRecord(value) || typeof value.operation !== 'string') return false;
  if (value.operation === 'team.skill.authorize') {
    return hasExactKeys(value, ['operation', 'packageRoot']) && isLocalRoot(value.packageRoot);
  }
  if (value.operation === 'team.skill.materialize') {
    return hasExactKeys(value, ['operation', 'selectionId', 'teamId', 'idempotencyKey'])
      && isSelectionId(value.selectionId)
      && isOpaqueId(value.teamId)
      && isOpaqueId(value.idempotencyKey);
  }
  return hasExactKeys(value, ['operation', 'selectionId'])
    && ['team.skill.validate', 'team.skill.dependency-plan'].includes(value.operation)
    && isSelectionId(value.selectionId);
}

function isAuthorized(value: unknown): value is Readonly<{ selectionId: TeamSkillSelectionId }> {
  return isRecord(value) && hasExactKeys(value, ['selectionId']) && isSelectionId(value.selectionId);
}

function isValidation(value: unknown): value is TeamSkillPackageValidation {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (value.status === 'invalid' || value.status === 'unavailable') return hasExactKeys(value, ['status']);
  return value.status === 'valid'
    && hasExactKeys(value, ['status', 'package'])
    && isPackage(value.package);
}

function isPackage(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['selectionId', 'name', 'version', 'kind', 'description'])
    && isSelectionId(value.selectionId)
    && isNonEmptyBoundedText(value.name)
    && isNonEmptyBoundedText(value.version)
    && value.kind === 'team-skill'
    && typeof value.description === 'string';
}

function isDependencyPlan(value: unknown): value is TeamSkillDependencyPlanResult {
  if (!isRecord(value) || typeof value.status !== 'string') return false;
  if (value.status === 'invalid' || value.status === 'unavailable') return hasExactKeys(value, ['status']);
  return value.status === 'available'
    && hasExactKeys(value, ['status', 'plan'])
    && isPlan(value.plan);
}

function isPlan(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['selectionId', 'packageName', 'packageVersion', 'items', 'canProceed'])
    && isSelectionId(value.selectionId)
    && isNonEmptyBoundedText(value.packageName)
    && isNonEmptyBoundedText(value.packageVersion)
    && Array.isArray(value.items)
    && value.items.every(isPlanItem)
    && typeof value.canProceed === 'boolean';
}

function isPlanItem(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'name', 'required', 'purpose', 'status', 'severity', 'installable'])
    && (value.kind === 'skill' || value.kind === 'tool')
    && isNonEmptyBoundedText(value.name)
    && typeof value.required === 'boolean'
    && typeof value.purpose === 'string'
    && (value.status === 'available' || value.status === 'missing')
    && (value.severity === 'ok' || value.severity === 'warning' || value.severity === 'blocker')
    && typeof value.installable === 'boolean';
}

function isSelectionId(value: unknown): value is TeamSkillSelectionId {
  return typeof value === 'string' && /^teamskill:v1:[a-f0-9]{64}$/.test(value);
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

function isLocalRoot(value: unknown): value is string {
  return isNonEmptyBoundedText(value) && !value.includes('\n') && !value.includes('\r');
}
