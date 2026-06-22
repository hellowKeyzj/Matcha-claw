export type TeamDependencyPlanItemKind = 'skill' | 'tool';
export type TeamDependencyPlanItemStatus = 'available' | 'missing';
export type TeamDependencyPlanItemSeverity = 'ok' | 'warning' | 'blocker';

export interface TeamDependencyEntry {
  readonly name: string;
  readonly required: boolean;
  readonly purpose: string;
  readonly source?: string;
}

export interface TeamDependencyPlanItem extends TeamDependencyEntry {
  readonly kind: TeamDependencyPlanItemKind;
  readonly status: TeamDependencyPlanItemStatus;
  readonly severity: TeamDependencyPlanItemSeverity;
  readonly installable: boolean;
}

export interface TeamDependencyPlanInput {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sourcePath: string;
  readonly skills: readonly unknown[];
  readonly tools: readonly unknown[];
  readonly skillCatalog: unknown;
}

export interface TeamDependencyPreparationPlan {
  readonly packageName: string;
  readonly packageVersion: string;
  readonly sourcePath: string;
  readonly items: TeamDependencyPlanItem[];
  readonly missingRequiredSkills: TeamDependencyEntry[];
  readonly missingOptionalSkills: TeamDependencyEntry[];
  readonly missingRequiredTools: TeamDependencyEntry[];
  readonly missingOptionalTools: TeamDependencyEntry[];
  readonly canProceed: boolean;
}

export function buildTeamDependencyPlan(input: TeamDependencyPlanInput): TeamDependencyPreparationPlan {
  const availableSkillNames = collectAvailableSkillNames(input.skillCatalog);
  const skillItems = input.skills.map((item) => buildDependencyPlanItem('skill', readDependencyEntry(item), availableSkillNames));
  const toolItems = input.tools.map((item) => buildDependencyPlanItem('tool', readDependencyEntry(item), new Set(['builtin'])));
  const items = [...skillItems, ...toolItems];
  const missingRequiredSkills = collectMissingEntries(skillItems, true);
  const missingOptionalSkills = collectMissingEntries(skillItems, false);
  const missingRequiredTools = collectMissingEntries(toolItems, true);
  const missingOptionalTools = collectMissingEntries(toolItems, false);

  return {
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    sourcePath: input.sourcePath,
    items,
    missingRequiredSkills,
    missingOptionalSkills,
    missingRequiredTools,
    missingOptionalTools,
    canProceed: missingRequiredSkills.length === 0 && missingRequiredTools.length === 0,
  };
}

function buildDependencyPlanItem(
  kind: TeamDependencyPlanItemKind,
  entry: TeamDependencyEntry,
  availableNames: ReadonlySet<string>,
): TeamDependencyPlanItem {
  const available = kind === 'tool'
    ? isBuiltinToolDependency(entry) || availableNames.has(normalizeDependencyIdentity(entry.name))
    : availableNames.has(normalizeDependencyIdentity(entry.name));
  const status: TeamDependencyPlanItemStatus = available ? 'available' : 'missing';
  return {
    ...entry,
    kind,
    status,
    severity: available ? 'ok' : entry.required ? 'blocker' : 'warning',
    installable: !available && isInstallableDependencySource(entry.source),
  };
}

function collectMissingEntries(items: readonly TeamDependencyPlanItem[], required: boolean): TeamDependencyEntry[] {
  return items
    .filter((item) => item.status === 'missing' && item.required === required)
    .map(({ name, required, purpose, source }) => ({
      name,
      required,
      purpose,
      ...(source ? { source } : {}),
    }));
}

function collectAvailableSkillNames(skillCatalog: unknown): Set<string> {
  const names = new Set<string>();
  const catalog = readRecord(skillCatalog);
  const skills = Array.isArray(catalog.skills) ? catalog.skills : [];
  for (const item of skills) {
    const skill = readRecord(item);
    if (!isSelectableInstalledSkill(skill)) {
      continue;
    }
    addNormalizedName(names, readString(skill.skillKey));
    addNormalizedName(names, readString(skill.id));
    addNormalizedName(names, readString(skill.slug));
    addNormalizedName(names, readString(skill.name));
  }
  return names;
}

function isSelectableInstalledSkill(skill: Record<string, unknown>): boolean {
  if (skill.installed !== true) {
    return false;
  }
  if (skill.disabled === true || skill.blockedByAllowlist === true) {
    return false;
  }
  return !hasMissingRequirements(skill.missing);
}

function hasMissingRequirements(value: unknown): boolean {
  const missing = readRecord(value);
  return ['bins', 'anyBins', 'env', 'config', 'os'].some((field) => Array.isArray(missing[field]) && missing[field].length > 0);
}

function readDependencyEntry(value: unknown): TeamDependencyEntry {
  const record = readRecord(value);
  return {
    name: readString(record.name),
    required: record.required === true,
    purpose: readString(record.purpose),
    ...(readString(record.source) ? { source: readString(record.source) } : {}),
  };
}

function isBuiltinToolDependency(entry: TeamDependencyEntry): boolean {
  return normalizeDependencyIdentity(entry.source) === 'builtin';
}

function isInstallableDependencySource(source: string | undefined): boolean {
  const value = source?.trim() ?? '';
  if (!value) {
    return false;
  }
  if (/^clawhub:(\/\/)?/i.test(value)) {
    return true;
  }
  if (/^https?:\/\//i.test(value)) {
    return false;
  }
  return value.startsWith('.')
    || value.startsWith('/')
    || value.startsWith('~')
    || /^[a-z]:[\\/]/i.test(value)
    || value.includes('/')
    || value.includes('\\');
}

function addNormalizedName(names: Set<string>, value: string): void {
  const normalized = normalizeDependencyIdentity(value);
  if (normalized) {
    names.add(normalized);
  }
}

function normalizeDependencyIdentity(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? '';
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
