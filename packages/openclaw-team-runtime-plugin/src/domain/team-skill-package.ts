export interface TeamSkillPackage {
  name: string
  version: string
  kind: 'team-skill'
  description: string
  roles: TeamSkillRoleSpec[]
  dependencies: TeamSkillDependencies
  workflow: TeamSkillWorkflowSpec
  bind: TeamSkillBindSpec
  sourcePath: string
}

export interface TeamSkillRoleSpec {
  id: string
  purpose: string
  skills: string[]
  tools: string[]
  roleFilePath: string
  agentsMd: string
  inlinePersona?: string
  outputSchemaMarkdown: string
}

export interface TeamSkillDependencyEntry {
  name: string
  required: boolean
  purpose: string
  source?: string
}

export interface TeamSkillDependencies {
  skills: TeamSkillDependencyEntry[]
  tools: TeamSkillDependencyEntry[]
}

export interface TeamSkillWorkflowSpec {
  markdown: string
  stages: TeamSkillWorkflowStageSpec[]
  gateKeywords: string[]
}

export interface TeamSkillWorkflowStageSpec {
  stageId: string
  title: string
  executor: string
  roleId?: string
  gateType?: string
  maxAttempts: number
}

export interface TeamSkillBindSpec {
  markdown: string
  maxParallelTeammates?: number
  totalWallClockBudgetMs?: number
  totalTokenBudget?: number
  roleWallClockBudgetMs: Record<string, number>
  roleTokenBudget: Record<string, number>
  requiresNpuAuthorization: boolean
  leaderOnly: boolean
  adversaryIsolation: boolean
}

export interface TeamSkillValidationIssue {
  code: string
  message: string
  path?: string
}

export interface TeamSkillPackageValidationResult {
  valid: boolean
  package?: TeamSkillPackage
  errors: TeamSkillValidationIssue[]
  warnings: TeamSkillValidationIssue[]
}
