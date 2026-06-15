import type { TeamSkillDependencies, TeamSkillDependencyEntry } from '../domain/team-skill-package.js'

export interface TeamDependencyCheckerPort {
  check(input: TeamSkillDependencies): Promise<TeamDependencyCheckResult>
}

export interface TeamDependencyCheckResult {
  missingRequiredSkills: TeamSkillDependencyEntry[]
  missingOptionalSkills: TeamSkillDependencyEntry[]
  missingRequiredTools: TeamSkillDependencyEntry[]
  missingOptionalTools: TeamSkillDependencyEntry[]
}

export const missingAllDependencyChecker: TeamDependencyCheckerPort = {
  async check(input) {
    return {
      missingRequiredSkills: input.skills.filter((item) => item.required),
      missingOptionalSkills: input.skills.filter((item) => !item.required),
      missingRequiredTools: input.tools.filter((item) => item.required),
      missingOptionalTools: input.tools.filter((item) => !item.required),
    }
  },
}
