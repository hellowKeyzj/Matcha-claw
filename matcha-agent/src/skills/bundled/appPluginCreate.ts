import skillMarkdown from '../../../../resources/skills/preinstalled-skill-sources/app-plugin-create/SKILL.md'
import { parseFrontmatter } from '../../utils/frontmatterParser.js'
import { registerBundledSkill } from '../bundledSkills.js'

const { frontmatter, content } = parseFrontmatter(skillMarkdown)

export function registerAppPluginCreateSkill(): void {
  registerBundledSkill({
    name: 'app-plugin-create',
    description: frontmatter.description!,
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
