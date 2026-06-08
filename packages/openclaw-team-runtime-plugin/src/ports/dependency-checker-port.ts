export interface TeamDependencyCheckerPort {
  check(input: TeamDependencyCheckInput): Promise<TeamDependencyCheckResult>
}

export interface TeamDependencyCheckInput {
  requiredSkills: string[]
  requiredTools: string[]
  optionalTools: string[]
}

export interface TeamDependencyCheckResult {
  missingRequiredSkills: string[]
  missingRequiredTools: string[]
  missingOptionalTools: string[]
}

export const missingAllDependencyChecker: TeamDependencyCheckerPort = {
  async check(input) {
    return {
      missingRequiredSkills: input.requiredSkills,
      missingRequiredTools: input.requiredTools,
      missingOptionalTools: input.optionalTools,
    }
  },
}
