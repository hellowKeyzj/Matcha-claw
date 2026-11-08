import configurationMarkdown from '../../../../resources/skills/preinstalled-skill-sources/openclaw-maintenance/references/configuration.md' with { type: 'text' }
import logsMarkdown from '../../../../resources/skills/preinstalled-skill-sources/openclaw-maintenance/references/logs.md' with { type: 'text' }
import runtimeMarkdown from '../../../../resources/skills/preinstalled-skill-sources/openclaw-maintenance/references/runtime.md' with { type: 'text' }
import storageMarkdown from '../../../../resources/skills/preinstalled-skill-sources/openclaw-maintenance/references/storage.md' with { type: 'text' }
import { registerBundledSkill } from '../bundledSkills.js'
import { openclawMaintenanceSkill } from './appCatalogSkills.js'

const { name, description, content } = openclawMaintenanceSkill

export function registerOpenclawMaintenanceSkill(): void {
  registerBundledSkill({
    name,
    description,
    files: {
      'references/configuration.md': configurationMarkdown,
      'references/logs.md': logsMarkdown,
      'references/storage.md': storageMarkdown,
      'references/runtime.md': runtimeMarkdown,
    },
    async getPromptForCommand(args) {
      return [
        {
          type: 'text',
          text: args ? `${content}\n\n## User Request\n\n${args}` : content,
        },
      ]
    },
  })
}
