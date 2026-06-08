import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { TeamSkillPackageService } from '../../packages/openclaw-team-runtime-plugin/src/application/team-skill-package-service'
import plugin from '../../packages/openclaw-team-runtime-plugin/src/index'

const fixturePath = path.resolve('.tmp/ascendc-operator-dev-optimize-team_1.0.0')
type GatewayHandler = (options: {
  params: Record<string, unknown>
  respond: (success: boolean, data?: unknown, error?: { code: string; message: string }) => void
}) => Promise<void>

async function copyFixture(): Promise<string> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'team-skill-package-'))
  await mkdir(path.join(tempRoot, 'roles'), { recursive: true })

  for (const fileName of ['SKILL.md', 'workflow.md', 'bind.md', 'dependencies.yaml']) {
    await writeFile(path.join(tempRoot, fileName), await readFile(path.join(fixturePath, fileName), 'utf8'))
  }

  for (const roleId of ['operator-designer', 'kernel-coder', 'code-adversary', 'precision-validator', 'performance-optimizer']) {
    await writeFile(
      path.join(tempRoot, 'roles', `${roleId}.md`),
      await readFile(path.join(fixturePath, 'roles', `${roleId}.md`), 'utf8'),
    )
  }

  return tempRoot
}

async function withFixture(test: (packagePath: string) => Promise<void>) {
  const packagePath = await copyFixture()
  try {
    await test(packagePath)
  } finally {
    await rm(packagePath, { recursive: true, force: true })
  }
}

describe('TeamSkillPackageService', () => {
  it('validates the Ascend C TeamSkill package', async () => {
    const result = await new TeamSkillPackageService().validate(fixturePath)

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.package?.name).toBe('ascendc-operator-dev-optimize-team')
    expect(result.package?.kind).toBe('team-skill')
    expect(result.package?.roles.map((role) => role.id)).toEqual([
      'operator-designer',
      'kernel-coder',
      'code-adversary',
      'precision-validator',
      'performance-optimizer',
    ])
    expect(result.package?.roles[0]?.agentsMd).toContain('# Role: Operator Designer')
    expect(result.package?.roles[0]?.inlinePersona).toContain('ROLE: Operator Designer in a Teamskill.')
    expect(result.package?.roles[0]?.outputSchemaMarkdown).toContain('DESIGN-COMPLETE')
    expect(result.package?.dependencies.requiredSkills).toContain('ascendc-operator-design')
    expect(result.package?.dependencies.requiredTools).toEqual(['bash', 'code', 'read_file', 'write_file'])
    expect(result.package?.dependencies.optionalTools).toEqual(['edit_file'])
    expect(result.package?.workflow.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        stageId: 'step-1-design-operator-blueprint',
        executor: 'operator-designer',
        roleId: 'operator-designer',
        gateType: 'design',
        maxAttempts: 2,
      }),
    ]))
    expect(result.package?.workflow.gateKeywords).toContain('DESIGN-COMPLETE')
    expect(result.package?.bind.maxParallelTeammates).toBe(1)
    expect(result.package?.bind.requiresNpuAuthorization).toBe(true)
    expect(result.package?.bind.leaderOnly).toBe(true)
    expect(result.package?.bind.adversaryIsolation).toBe(true)
  })

  it('rejects non team-skill manifests', async () => {
    await withFixture(async (packagePath) => {
      const skillPath = path.join(packagePath, 'SKILL.md')
      const skill = await readFile(skillPath, 'utf8')
      await writeFile(skillPath, skill.replace('kind: team-skill', 'kind: skill'))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalid_kind' })]))
    })
  })

  it('rejects duplicate role ids', async () => {
    await withFixture(async (packagePath) => {
      const skillPath = path.join(packagePath, 'SKILL.md')
      const skill = await readFile(skillPath, 'utf8')
      await writeFile(skillPath, skill.replace('  - id: kernel-coder', '  - id: operator-designer'))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'duplicate_role_id' })]))
    })
  })

  it('rejects role ids reserved for the managed Team leader', async () => {
    await withFixture(async (packagePath) => {
      const skillPath = path.join(packagePath, 'SKILL.md')
      const skill = await readFile(skillPath, 'utf8')
      await writeFile(skillPath, skill.replace('  - id: kernel-coder', '  - id: leader'))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'reserved_role_id' })]))
    })
  })

  it('rejects role tools that are denied for managed agents', async () => {
    await withFixture(async (packagePath) => {
      const skillPath = path.join(packagePath, 'SKILL.md')
      const skill = await readFile(skillPath, 'utf8')
      await writeFile(skillPath, skill.replace('tools: []', 'tools: [sessions_spawn]'))
      const depsPath = path.join(packagePath, 'dependencies.yaml')
      const deps = await readFile(depsPath, 'utf8')
      await writeFile(depsPath, `${deps}\n  - name: sessions_spawn\n    required: true\n`)

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'role_tool_denied_for_managed_agent' })]))
    })
  })

  it('rejects missing role files', async () => {
    await withFixture(async (packagePath) => {
      await rm(path.join(packagePath, 'roles', 'kernel-coder.md'))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'role_file_missing' })]))
    })
  })

  it('rejects role dependencies that are not declared in dependencies.yaml', async () => {
    await withFixture(async (packagePath) => {
      const depsPath = path.join(packagePath, 'dependencies.yaml')
      const deps = await readFile(depsPath, 'utf8')
      await writeFile(depsPath, deps.replace('  - name: ascendc-operator-code-gen', '  - name: missing-code-gen'))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'role_skill_not_declared' })]))
    })
  })

  it('rejects missing role required sections', async () => {
    await withFixture(async (packagePath) => {
      const rolePath = path.join(packagePath, 'roles', 'kernel-coder.md')
      const role = await readFile(rolePath, 'utf8')
      await writeFile(rolePath, role.replace(/^## Output Schema\r?\n[\s\S]*$/m, ''))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'role_required_section_missing' })]))
    })
  })

  it('rejects invalid package YAML', async () => {
    await withFixture(async (packagePath) => {
      await writeFile(path.join(packagePath, 'dependencies.yaml'), 'skills: [unterminated\n')

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'yaml_parse_error' })]))
    })
  })

  it('registers the package validation gateway method', async () => {
    const gatewayMethods = new Map<string, GatewayHandler>()
    plugin.register({
      config: {},
      pluginConfig: {
        availableSkills: [
          'ascendc-operator-design',
          'ascendc-operator-code-gen',
          'ascendc-operator-adversarial-review',
          'ascendc-operator-precision-audit',
          'ascendc-operator-performance-optim',
        ],
        availableTools: ['bash', 'code', 'read_file', 'write_file', 'edit_file'],
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      registerGatewayMethod: (name: string, handler: GatewayHandler) => {
        gatewayMethods.set(name, handler)
      },
      registerTool: () => {},
      registerHttpRoute: () => {},
      on: () => {},
      runtime: {
        subagent: {
          spawn: async () => ({ status: 'accepted', runId: 'openclaw-run-1' }),
        },
      },
    } as any)

    let response: unknown
    await gatewayMethods.get('matchaclaw.team.package.validate')?.({
      params: { packagePath: fixturePath },
      respond: (success, data, error) => {
        response = { success, data, error }
      },
    })

    expect(response).toEqual(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ valid: true }),
    }))
  })
})
