import appPluginCreateMarkdown from '../../../../resources/skills/preinstalled-skill-sources/app-plugin-create/SKILL.md' with { type: 'text' }
import openclawMaintenanceMarkdown from '../../../../resources/skills/preinstalled-skill-sources/openclaw-maintenance/SKILL.md' with { type: 'text' }
import { parse as parseYaml } from 'yaml'

// These shipped sources are strict frontmatter, without runtime logging/bootstrap.
function defineAppCatalogSkill(name: string, markdown: string) {
  const header = markdown.match(/^---\s*\n([\s\S]*?)---\s*\n?/)
  if (!header) throw new Error(`Missing bundled skill frontmatter: ${name}`)
  const frontmatter = parseYaml(header[1]!) as { description?: unknown }
  if (typeof frontmatter.description !== 'string' || !frontmatter.description) {
    throw new Error(`Missing bundled skill description: ${name}`)
  }
  return {
    name,
    description: frontmatter.description,
    content: markdown.slice(header[0].length),
  }
}

export const appPluginCreateSkill = defineAppCatalogSkill(
  'app-plugin-create',
  appPluginCreateMarkdown,
)

export const openclawMaintenanceSkill = defineAppCatalogSkill(
  'openclaw-maintenance',
  openclawMaintenanceMarkdown,
)

export const skillsCatalog = {
  skills: [appPluginCreateSkill, openclawMaintenanceSkill].map(
    ({ name, description }) => ({ name, description }),
  ),
}
