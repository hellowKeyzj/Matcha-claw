import { hostApiFetchDecoded } from '@/lib/host-api';

export type TeamSkillSelectionId = `teamskill:v1:${string}`;

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

export type TeamSkillMaterialization = Readonly<{
  status: 'materialized' | 'rejected' | 'outcome_unknown';
}>;

const SELECTION_ID = /^teamskill:v1:[a-f0-9]{64}$/;

export function decodeValidation(value: unknown): TeamSkillPackageValidation {
  if (!isRecord(value) || typeof value.status !== 'string') return unavailable('TeamSkill selection is unavailable');
  if (value.status === 'invalid' || value.status === 'unavailable') {
    if (hasExactKeys(value, ['status'])) return { status: value.status };
    return unavailable('TeamSkill selection is unavailable');
  }
  if (
    value.status === 'valid'
    && hasExactKeys(value, ['status', 'package'])
    && isPackage(value.package)
  ) {
    return value as TeamSkillPackageValidation;
  }
  return unavailable('TeamSkill selection is unavailable');
}

export function decodeDependencyPlan(value: unknown): TeamSkillDependencyPlanResult {
  if (!isRecord(value) || typeof value.status !== 'string') return unavailable('TeamSkill selection is unavailable');
  if (value.status === 'invalid' || value.status === 'unavailable') {
    if (hasExactKeys(value, ['status'])) return { status: value.status };
    return unavailable('TeamSkill selection is unavailable');
  }
  if (
    value.status === 'available'
    && hasExactKeys(value, ['status', 'plan'])
    && isPlan(value.plan)
  ) {
    return value as TeamSkillDependencyPlanResult;
  }
  return unavailable('TeamSkill selection is unavailable');
}

export function decodeMaterialization(value: unknown): TeamSkillMaterialization {
  if (
    isRecord(value)
    && hasExactKeys(value, ['status'])
    && (value.status === 'materialized' || value.status === 'rejected' || value.status === 'outcome_unknown')
  ) {
    return value as TeamSkillMaterialization;
  }
  return unavailable('TeamSkill materialization is unavailable');
}

export async function authorizeTeamSkillSelection(
  packageRoot: string,
): Promise<Readonly<{ selectionId: TeamSkillSelectionId }>> {
  return hostApiFetchDecoded('/api/team/skill', decodeAuthorization, {
    method: 'POST',
    body: JSON.stringify({ operation: 'team.skill.authorize', packageRoot }),
  });
}

export async function validateTeamSkillSelection(
  selectionId: string,
): Promise<TeamSkillPackageValidation> {
  return hostApiFetchDecoded('/api/team/skill', decodeValidation, {
    method: 'POST',
    body: JSON.stringify({ operation: 'team.skill.validate', selectionId }),
  });
}

export async function planTeamSkillDependencies(
  selectionId: string,
): Promise<TeamSkillDependencyPlanResult> {
  return hostApiFetchDecoded('/api/team/skill', decodeDependencyPlan, {
    method: 'POST',
    body: JSON.stringify({ operation: 'team.skill.dependency-plan', selectionId }),
  });
}

export async function materializeTeamSkillSelection(
  selectionId: string,
  teamId: string,
  idempotencyKey: string,
): Promise<TeamSkillMaterialization> {
  return hostApiFetchDecoded('/api/team/skill', decodeMaterialization, {
    method: 'POST',
    body: JSON.stringify({ operation: 'team.skill.materialize', selectionId, teamId, idempotencyKey }),
  });
}

function decodeAuthorization(value: unknown): Readonly<{ selectionId: TeamSkillSelectionId }> {
  if (isRecord(value) && hasExactKeys(value, ['selectionId']) && isSelectionId(value.selectionId)) {
    return value as Readonly<{ selectionId: TeamSkillSelectionId }>;
  }
  return unavailable('TeamSkill selection is unavailable');
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
    && isText(value.purpose)
    && (value.status === 'available' || value.status === 'missing')
    && (value.severity === 'ok' || value.severity === 'warning' || value.severity === 'blocker')
    && typeof value.installable === 'boolean';
}

function isSelectionId(value: unknown): value is TeamSkillSelectionId {
  return typeof value === 'string' && SELECTION_ID.test(value);
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

function unavailable(message: string): never {
  throw new Error(message);
}
