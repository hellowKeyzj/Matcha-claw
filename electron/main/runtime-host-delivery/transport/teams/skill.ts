import type { RuntimeHostDeliveryIssuer } from '../../bootstrap';

const DECISION_TTL_MS = 30_000;
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

export type TeamSkillMaterializeResult = Readonly<{
  status: 'materialized' | 'rejected' | 'outcome_unknown';
}>;

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
  ): Promise<TeamSkillTransportResponse<TeamSkillMaterializeResult>>;
}

export function createTeamSkillTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
): TeamSkillTransport {
  const url = `http://127.0.0.1:${port}/api/team/skill`;
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
      isMaterialized,
    ),
  };

  async function request<T>(
    capability: string,
    body: unknown,
    isResponse: (value: unknown) => value is T,
  ): Promise<TeamSkillTransportResponse<T>> {
    if (!isRequest(body)) return { status: 503, body: UNAVAILABLE };
    try {
      const response = await fetcher(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${issuer.signDecision({
            principal: 'electron-main-local',
            endpoint: '/api/team/skill',
            scope: 'team:write',
            capability,
            subject: 'team-skill-selection',
            expiresAt: Date.now() + DECISION_TTL_MS,
            revision: '1',
          })}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const result: unknown = await response.json();
      if (response.status === 200 && isResponse(result)) return { status: 200, body: result };
    } catch {
      // Native transport details do not cross the Electron delivery boundary.
    }
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
    && isText(value.name)
    && isText(value.version)
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

function isMaterialized(value: unknown): value is TeamSkillMaterializeResult {
  return isRecord(value)
    && hasExactKeys(value, ['status'])
    && (value.status === 'materialized' || value.status === 'rejected' || value.status === 'outcome_unknown');
}

function isPlan(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['selectionId', 'packageName', 'packageVersion', 'items', 'canProceed'])
    && isSelectionId(value.selectionId)
    && isText(value.packageName)
    && isText(value.packageVersion)
    && Array.isArray(value.items)
    && value.items.every(isPlanItem)
    && typeof value.canProceed === 'boolean';
}

function isPlanItem(value: unknown): boolean {
  return isRecord(value)
    && hasExactKeys(value, ['kind', 'name', 'required', 'purpose', 'status', 'severity', 'installable'])
    && (value.kind === 'skill' || value.kind === 'tool')
    && isText(value.name)
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
  return isText(value) && !value.includes('\n') && !value.includes('\r');
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
