import { registerBundledSkill } from '../bundledSkills.js'
import { appPluginCreateSkill } from './appCatalogSkills.js'

const { name, description, content } = appPluginCreateSkill

export function registerAppPluginCreateSkill(): void {
  registerBundledSkill({
    name,
    description,
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
