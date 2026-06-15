import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { zipSync } from 'fflate'
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

async function createZipFromPackage(packagePath: string, archivePath: string, rootPrefix = ''): Promise<void> {
  const entries: Record<string, Uint8Array> = {}
  const encoder = new TextEncoder()
  const entryPath = (relativePath: string) => `${rootPrefix}${relativePath}`

  for (const fileName of ['SKILL.md', 'workflow.md', 'bind.md', 'dependencies.yaml']) {
    entries[entryPath(fileName)] = encoder.encode(await readFile(path.join(packagePath, fileName), 'utf8'))
  }

  for (const roleId of ['operator-designer', 'kernel-coder', 'code-adversary', 'precision-validator', 'performance-optimizer']) {
    const rolePath = `roles/${roleId}.md`
    entries[entryPath(rolePath)] = encoder.encode(await readFile(path.join(packagePath, rolePath), 'utf8'))
  }

  await writeFile(archivePath, zipSync(entries))
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
    expect(result.package?.dependencies.skills).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ascendc-operator-design', source: 'local', required: true }),
    ]))
    expect(result.package?.dependencies.skills.filter((item) => !item.required)).toEqual([])
    expect(result.package?.dependencies.tools.filter((item) => item.required).map((item) => item.name)).toEqual(['bash', 'code', 'read_file', 'write_file'])
    expect(result.package?.dependencies.tools.filter((item) => !item.required).map((item) => item.name)).toEqual(['edit_file'])
    expect(result.package?.workflow.markdown).toContain('# Workflow: Ascend C Operator End-to-End Development & Optimization Pipeline')
    expect(result.package?.workflow.stages).toEqual([])
    expect(result.package?.workflow.gateKeywords).toContain('DESIGN-COMPLETE')
    expect(result.package?.bind.maxParallelTeammates).toBe(1)
    expect(result.package?.bind.requiresNpuAuthorization).toBe(true)
    expect(result.package?.bind.leaderOnly).toBe(true)
    expect(result.package?.bind.adversaryIsolation).toBe(true)
  })

  it('preserves localized workflow markdown as leader context without parsing stages', async () => {
    await withFixture(async (packagePath) => {
      await writeFile(path.join(packagePath, 'workflow.md'), [
        '# Workflow：预检 → 角色派发 → 汇总',
        '',
        '### 第 0 步：预检依赖检查（Leader，≤1 轮）',
        '',
        '校验 dependencies.yaml 中声明的依赖。',
        '',
        '### 第 1 步：上下文提取（Leader，≤1 轮）',
        '',
        'Leader 只收集上下文。',
        '',
        '### 第 2 步：第 1 轮 —— 角色派发（Leader）',
        '',
        '| 子步骤 | 角色 | 输入 | 输出 | 角色文件 |',
        '|---|---|---|---|---|',
        '| **2a** | operator-designer（×1） | 上下文 | 设计 | [`roles/operator-designer.md`](./roles/operator-designer.md) |',
        '| **2b** | kernel-coder（×1） | 上下文 | 代码 | [`roles/kernel-coder.md`](./roles/kernel-coder.md) |',
        '| **2c** | code-adversary（×1） | 上下文 | 审查 | [`roles/code-adversary.md`](./roles/code-adversary.md) |',
        '| **2d** | precision-validator（×1） | 上下文 | 精度 | [`roles/precision-validator.md`](./roles/precision-validator.md) |',
        '',
        '### 第 3 步：最终报告（Leader）',
      ].join('\n'))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.package?.workflow.markdown).toContain('Leader 只收集上下文。')
      expect(result.package?.workflow.stages).toEqual([])
    })
  })

  it('accepts parallel workflow descriptions as leader context without hard-coded dispatch parsing', async () => {
    await withFixture(async (packagePath) => {
      await writeFile(path.join(packagePath, 'workflow.md'), [
        '# Workflow：预检 → 并行角色派发 → 汇总',
        '',
        '### 第 0 步：预检依赖检查（Leader，≤1 轮）',
        '',
        '校验 dependencies.yaml 中声明的依赖。',
        '',
        '### 第 1 步：第 1 轮 —— 并行对抗派发（Leader，单次派发 4 个调用）',
        '',
        'Leader **必须在一条消息中发起全部 4 个 Task 调用**。',
        '',
        '| 子步骤 | 角色 | 输入 | 输出 | 角色文件 |',
        '|---|---|---|---|---|',
        '| **1a** | operator-designer（×1） | 上下文 | 设计 | [`roles/operator-designer.md`](./roles/operator-designer.md) |',
        '| **1b** | kernel-coder（×1） | 上下文 | 代码 | [`roles/kernel-coder.md`](./roles/kernel-coder.md) |',
      ].join('\n'))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.package?.workflow.markdown).toContain('单次派发 4 个调用')
      expect(result.package?.workflow.stages).toEqual([])
    })
  })

  it('accepts free-form workflow files as leader context', async () => {
    await withFixture(async (packagePath) => {
      await writeFile(path.join(packagePath, 'workflow.md'), '# Workflow\n\nNo executable stage headings.')

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.package?.workflow.markdown).toContain('No executable stage headings.')
      expect(result.package?.workflow.stages).toEqual([])
    })
  })

  it('validates a TeamSkill package zip archive with a nested package root', async () => {
    await withFixture(async (packagePath) => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'team-skill-archive-'))
      try {
        const archivePath = path.join(tempRoot, 'package.zip')
        await createZipFromPackage(packagePath, archivePath, 'team-skill/')

        const result = await new TeamSkillPackageService().validate(archivePath)

        expect(result.valid).toBe(true)
        expect(result.errors).toEqual([])
        expect(result.package?.sourcePath.endsWith(`${path.sep}team-skill`)).toBe(true)
        expect(result.package?.roles.map((role) => role.id)).toContain('kernel-coder')
      } finally {
        await rm(tempRoot, { recursive: true, force: true })
      }
    })
  })

  it('validates a TeamSkill package zip archive with package files at archive root', async () => {
    await withFixture(async (packagePath) => {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'team-skill-archive-'))
      try {
        const archivePath = path.join(tempRoot, 'package.zip')
        await createZipFromPackage(packagePath, archivePath)

        const result = await new TeamSkillPackageService().validate(archivePath)

        expect(result.valid).toBe(true)
        expect(result.errors).toEqual([])
        expect(result.package?.sourcePath).not.toContain(`${path.sep}package.zip`)
        expect(result.package?.roles.map((role) => role.id)).toContain('kernel-coder')
      } finally {
        await rm(tempRoot, { recursive: true, force: true })
      }
    })
  })

  it('rejects zip archives with path traversal entries', async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'team-skill-archive-'))
    try {
      const archivePath = path.join(tempRoot, 'package.zip')
      await writeFile(archivePath, zipSync({ '../SKILL.md': new TextEncoder().encode('escaped') }))

      const result = await new TeamSkillPackageService().validate(archivePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'archive_extract_failed' })]))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
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

  it('accepts role skills declared as optional dependencies and localized role headings', async () => {
    await withFixture(async (packagePath) => {
      const skillPath = path.join(packagePath, 'SKILL.md')
      const skill = await readFile(skillPath, 'utf8')
      await writeFile(skillPath, skill.replace('skills: [ascendc-operator-design]', 'skills: [optional-design]'))
      const depsPath = path.join(packagePath, 'dependencies.yaml')
      const deps = await readFile(depsPath, 'utf8')
      await writeFile(depsPath, deps.replace('  - name: ascendc-operator-design\n    source: local\n    required: true', '  - name: optional-design\n    source: local\n    required: false'))
      const rolePath = path.join(packagePath, 'roles', 'operator-designer.md')
      const role = await readFile(rolePath, 'utf8')
      await writeFile(rolePath, role
        .replace('## Identity', '## 身份（Identity）')
        .replace('## Success Criteria', '## 成功标准（Success Criteria）')
        .replace('## Boundary', '## 边界（Boundary）')
        .replace('## Output Schema', '## 输出 Schema（Output Schema）'))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.package?.dependencies.skills).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'optional-design', source: 'local', required: false }),
      ]))
      expect(result.package?.roles[0]?.outputSchemaMarkdown).toContain('DESIGN-COMPLETE')
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

  it('rejects dependency entries missing explicit required, source, or purpose fields', async () => {
    await withFixture(async (packagePath) => {
      await writeFile(path.join(packagePath, 'dependencies.yaml'), [
        'skills:',
        '  - name: ascendc-operator-design',
        '    required: true',
        '    purpose: Supports design work.',
        '  - name: ascendc-operator-code-gen',
        '    source: local',
        '    purpose: Supports code generation.',
        'tools:',
        '  - name: bash',
        '    required: true',
      ].join('\n'))

      const result = await new TeamSkillPackageService().validate(packagePath)

      expect(result.valid).toBe(false)
      expect(result.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'dependency_source_missing' }),
        expect.objectContaining({ code: 'dependency_required_missing' }),
        expect.objectContaining({ code: 'dependency_purpose_missing' }),
      ]))
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
          run: async () => ({ runId: 'openclaw-run-1' }),
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
