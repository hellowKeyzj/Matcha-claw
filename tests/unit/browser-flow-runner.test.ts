import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { WebSocketServer } from 'ws'

let tempDirs: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function resolvePythonCommand(): string | null {
  for (const command of ['python', 'python3', 'py']) {
    const result = spawnSync(command, ['--version'], { encoding: 'utf8' })
    if (result.status === 0) {
      return command
    }
  }
  return null
}

async function findFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        reject(new Error('failed to allocate port'))
        return
      }
      const { port } = address
      probe.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

type RunnerResult = {
  status: number | null
  stdout: string
  stderr: string
  parsed: Record<string, unknown>
}

async function runRunner(args: string[], env: Record<string, string> = {}): Promise<RunnerResult> {
  const python = resolvePythonCommand()
  if (!python) {
    throw new Error('Python executable not found')
  }

  const scriptPath = path.join(
    process.cwd(),
    'resources/skills/plugin-companion-skills/browser-flow-create/runtime/agent_browser_flow_runner.py',
  )

  return await new Promise((resolve, reject) => {
    const child = spawn(python, [scriptPath, ...args], {
      env: {
        ...process.env,
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.once('error', reject)
    child.once('exit', (status) => {
      const line = stdout.trim().split(/\r?\n/).at(-1) || '{}'
      resolve({ status, stdout, stderr, parsed: JSON.parse(line) as Record<string, unknown> })
    })
  })
}

async function writeWorkspace(
  recipe: Record<string, unknown>,
  capability: Record<string, unknown> = {},
): Promise<string> {
  const workspace = await makeTempDir('matchaclaw-browser-flow-runner-')
  const platformDir = path.join(workspace, 'browser-flows', 'platforms', 'demo')
  await mkdir(path.join(platformDir, 'flows'), { recursive: true })
  await mkdir(path.join(platformDir, 'atlas', 'capabilities'), { recursive: true })
  await writeFile(path.join(platformDir, 'platform.json'), JSON.stringify({
    platformId: 'demo',
    displayName: 'Demo',
    domains: ['example.test'],
    baseUrl: 'https://example.test',
  }), 'utf8')
  await writeFile(path.join(platformDir, 'atlas', 'capabilities', 'demo.search.capability.json'), JSON.stringify({
    capabilityId: 'demo.search',
    risk: 'read-only',
    executionMode: 'auto',
    ...capability,
  }), 'utf8')
  await writeFile(path.join(platformDir, 'flows', 'demo.search.recipe.json'), JSON.stringify({
    recipeId: 'demo.search',
    platformId: 'demo',
    capabilityId: 'demo.search',
    runtime: {
      kind: 'agent-side',
      protocol: 'agent-browser-flow-v1',
      requiredBrowserActions: ['status', 'navigate', 'snapshot', 'act'],
    },
    params: {
      schema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query' },
          apiToken: { type: 'string', secret: true, default: 'fixture-token' },
        },
      },
    },
    risk: 'read-only',
    executionMode: 'auto',
    steps: [
      { id: 'status', kind: 'status' },
      { id: 'navigate', kind: 'navigate', url: 'https://example.test/search?q={{query}}' },
    ],
    ...recipe,
  }), 'utf8')
  return workspace
}

type SnapshotPayload = {
  snapshot: string
  refs: Record<string, unknown>
}

const defaultSnapshot: SnapshotPayload = {
  snapshot: '- button "Search" [ref=button-1]\nResult: matcha',
  refs: {
    'button-1': { role: 'button', name: 'Search', componentId: 'demo.search-button' },
  },
}

async function withFakeGateway<T>(
  handler: (port: number, calls: Record<string, unknown>[]) => Promise<T>,
  snapshots: SnapshotPayload[] = [defaultSnapshot],
): Promise<T> {
  const port = await findFreePort()
  const token = 'runner-test-token'
  const calls: Record<string, unknown>[] = []
  let snapshotIndex = 0
  const wss = new WebSocketServer({ host: '127.0.0.1', port })
  wss.on('connection', (socket) => {
    socket.send(JSON.stringify({
      type: 'event',
      event: 'connect.challenge',
      payload: { nonce: 'runner-test' },
    }))
    socket.on('message', (rawData) => {
      const message = JSON.parse(rawData.toString()) as Record<string, unknown>
      if (message.type !== 'req' || typeof message.id !== 'string') {
        return
      }
      if (message.method === 'connect') {
        const params = message.params && typeof message.params === 'object'
          ? message.params as Record<string, unknown>
          : {}
        const auth = params.auth && typeof params.auth === 'object'
          ? params.auth as Record<string, unknown>
          : {}
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: auth.token === token,
          ...(auth.token === token
            ? { payload: { features: { methods: ['browser.request'] } } }
            : { error: { code: 'FORBIDDEN', message: 'invalid token' } }),
        }))
        return
      }
      if (message.method !== 'browser.request') {
        return
      }
      const params = message.params && typeof message.params === 'object'
        ? message.params as Record<string, unknown>
        : {}
      calls.push(params)
      const action = params.action
      if (action === 'snapshot') {
        const snapshot = snapshots[Math.min(snapshotIndex, snapshots.length - 1)] || defaultSnapshot
        snapshotIndex += 1
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: true,
          payload: {
            ok: true,
            ...snapshot,
          },
        }))
        return
      }
      socket.send(JSON.stringify({
        type: 'res',
        id: message.id,
        ok: true,
        payload: { ok: true, action },
      }))
    })
  })

  try {
    return await handler(port, calls)
  } finally {
    await new Promise<void>((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    })
  }
}

describe('agent Browser Flow runner', () => {
  it('validates required params before opening a gateway connection', async () => {
    const workspace = await writeWorkspace({})

    const result = await runRunner([
      '--workspace-dir', workspace,
      '--recipe-id', 'demo.search',
      '--params-json', '{}',
    ])

    expect(result.status).toBe(2)
    expect(result.stderr).toBe('')
    expect(result.parsed).toMatchObject({
      ok: false,
      status: 'failed',
      error: { code: 'missing_required_param' },
    })
  })

  it('blocks risky recipes before executing browser actions', async () => {
    const workspace = await writeWorkspace({
      risk: 'destructive',
      executionMode: 'manual-confirm',
    }, {
      risk: 'destructive',
      executionMode: 'manual-confirm',
    })

    const result = await runRunner([
      '--workspace-dir', workspace,
      '--recipe-id', 'demo.search',
      '--params-json', '{"query":"matcha"}',
    ])

    expect(result.status).toBe(3)
    expect(result.stderr).toBe('')
    expect(result.parsed).toMatchObject({
      ok: false,
      status: 'blocked',
      blockers: [expect.objectContaining({ code: 'risk_boundary' })],
    })
  })

  it('maps recipe steps to Browser Relay actions and writes a redacted trace', async () => {
    const workspace = await writeWorkspace({
      steps: [
        { id: 'status', kind: 'status' },
        { id: 'navigate', kind: 'navigate', url: 'https://example.test/search?q={{query}}' },
        { id: 'click-search', kind: 'click', target: { role: 'button', name: 'Search' } },
        { id: 'extract-result', kind: 'extract', pattern: 'Result: (\\w+)', output: 'resultText' },
        { id: 'assert-result', kind: 'assertText', text: 'Result: matcha' },
      ],
    })

    await withFakeGateway(async (port, calls) => {
      const result = await runRunner([
        '--workspace-dir', workspace,
        '--recipe-id', 'demo.search',
        '--params-json', '{"query":"matcha","apiToken":"secret-token"}',
      ], {
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(port),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: 'runner-test-token',
      })

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.parsed).toMatchObject({
        ok: true,
        status: 'success',
        protocol: 'agent-browser-flow-v1',
        platformId: 'demo',
        recipeId: 'demo.search',
        capabilityId: 'demo.search',
        params: {
          query: 'matcha',
          apiToken: '[REDACTED]',
        },
        outputs: {
          resultText: 'matcha',
        },
      })
      expect(calls.map((call) => call.action)).toEqual([
        'status',
        'navigate',
        'snapshot',
        'act',
        'snapshot',
        'snapshot',
      ])
      expect(calls[3]).toMatchObject({
        action: 'act',
        request: {
          kind: 'click',
          ref: 'button-1',
        },
      })
      const tracePath = result.parsed.tracePath
      expect(typeof tracePath).toBe('string')
      expect(existsSync(tracePath as string)).toBe(true)
    })
  })

  it('retries target snapshots when refs are initially empty', async () => {
    const workspace = await writeWorkspace({
      steps: [
        { id: 'click-search', kind: 'click', target: { role: 'button', name: 'Search' } },
      ],
    })

    await withFakeGateway(async (port, calls) => {
      const result = await runRunner([
        '--workspace-dir', workspace,
        '--recipe-id', 'demo.search',
        '--params-json', '{"query":"matcha"}',
      ], {
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(port),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: 'runner-test-token',
      })

      expect(result.status).toBe(0)
      expect(calls.map((call) => call.action)).toEqual(['snapshot', 'snapshot', 'act'])
      expect(calls[2]).toMatchObject({
        action: 'act',
        request: { ref: 'button-1' },
      })
    }, [
      { snapshot: '', refs: {} },
      defaultSnapshot,
    ])
  })

  it('normalizes target labels without falling back to ref order', async () => {
    const workspace = await writeWorkspace({
      steps: [
        { id: 'type-name', kind: 'type', target: { role: 'textbox', name: '标签名称' }, text: '抹茶' },
        { id: 'confirm', kind: 'click', target: { role: 'button', name: '确定' } },
      ],
    })

    await withFakeGateway(async (port, calls) => {
      const result = await runRunner([
        '--workspace-dir', workspace,
        '--recipe-id', 'demo.search',
        '--params-json', '{"query":"matcha"}',
      ], {
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(port),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: 'runner-test-token',
      })

      expect(result.status).toBe(0)
      expect(calls[1]).toMatchObject({
        action: 'act',
        request: { kind: 'type', ref: 'field-2' },
      })
      expect(calls[3]).toMatchObject({
        action: 'act',
        request: { kind: 'click', ref: 'button-1' },
      })
    }, [
      {
        snapshot: '- textbox "* 标签名称" [ref=field-2]',
        refs: {
          'field-2': { role: 'textbox', name: '* 标签名称', componentId: 'demo.tag-name' },
        },
      },
      {
        snapshot: '- button "确 定" [ref=button-1]\n- button "确 定" [ref=button-9]',
        refs: {
          'button-1': { role: 'button', name: '确 定', componentId: 'demo.confirm-primary' },
          'button-9': { role: 'button', name: '确 定', componentId: 'demo.confirm-secondary' },
        },
      },
    ])
  })

  it('fails instead of sending untargeted act requests when target resolution is insufficient', async () => {
    const workspace = await writeWorkspace({
      steps: [
        { id: 'click-missing', kind: 'click', target: { role: 'button', name: 'Missing' } },
      ],
    })

    await withFakeGateway(async (port, calls) => {
      const result = await runRunner([
        '--workspace-dir', workspace,
        '--recipe-id', 'demo.search',
        '--params-json', '{"query":"matcha"}',
      ], {
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(port),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: 'runner-test-token',
      })

      expect(result.status).toBe(2)
      expect(result.parsed).toMatchObject({
        ok: false,
        status: 'failed',
        error: { code: 'target_unresolved' },
      })
      expect(calls.map((call) => call.action)).toEqual(['snapshot'])
    })
  })

  it('writes validated freshness and evidence in learning mode', async () => {
    const workspace = await writeWorkspace({
      steps: [
        { id: 'status', kind: 'status' },
        { id: 'click-search', kind: 'click', target: { role: 'button', name: 'Search', componentId: 'demo.search-button' } },
        { id: 'extract-result', kind: 'extract', pattern: 'Result: (\\w+)', output: 'resultText' },
      ],
    })

    await withFakeGateway(async (port) => {
      const result = await runRunner([
        '--workspace-dir', workspace,
        '--recipe-id', 'demo.search',
        '--params-json', '{"query":"matcha","apiToken":"secret-token"}',
        '--asset-update-mode', 'learning',
      ], {
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(port),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: 'runner-test-token',
      })

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(result.parsed.patchStatus).toBe('write_back')
      expect(result.parsed.changedAssets).toEqual(expect.arrayContaining([
        'platforms/demo/flows/demo.search.recipe.json',
        'platforms/demo/atlas/capabilities/demo.search.capability.json',
        'platforms/demo/platform.json',
        'platforms/demo/atlas/components/demo.search-button.component.json',
      ]))
      const recipe = JSON.parse(await readFile(path.join(workspace, 'browser-flows/platforms/demo/flows/demo.search.recipe.json'), 'utf8'))
      expect(recipe.freshness.failureCount).toBe(0)
      expect(recipe.evidenceRefs.join('\n')).not.toContain('secret-token')
      const component = JSON.parse(await readFile(path.join(workspace, 'browser-flows/platforms/demo/atlas/components/demo.search-button.component.json'), 'utf8'))
      expect(component.observedRoles).toContain('button')
      expect(component.observedLabels).toContain('Search')
    })
  })

  it('does not rewrite assets when the observed signature is unchanged', async () => {
    const workspace = await writeWorkspace({
      steps: [
        { id: 'click-search', kind: 'click', target: { role: 'button', name: 'Search', componentId: 'demo.search-button' } },
      ],
    })

    await withFakeGateway(async (port) => {
      const env = {
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(port),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: 'runner-test-token',
      }
      const args = [
        '--workspace-dir', workspace,
        '--recipe-id', 'demo.search',
        '--params-json', '{"query":"matcha"}',
        '--asset-update-mode', 'learning',
      ]
      const first = await runRunner(args, env)
      expect(first.status).toBe(0)
      expect(first.parsed.patchStatus).toBe('write_back')
      const recipePath = path.join(workspace, 'browser-flows/platforms/demo/flows/demo.search.recipe.json')
      const platformPath = path.join(workspace, 'browser-flows/platforms/demo/platform.json')
      const recipeBefore = await readFile(recipePath, 'utf8')
      const platformBefore = await readFile(platformPath, 'utf8')

      const second = await runRunner(args, env)
      expect(second.status).toBe(0)
      expect(second.parsed.patchStatus).toBe('no_changes')
      expect(second.parsed.changedAssets).toEqual([])
      expect(await readFile(recipePath, 'utf8')).toBe(recipeBefore)
      expect(await readFile(platformPath, 'utf8')).toBe(platformBefore)
    })
  })

  it('updates failure evidence without mutating recipe steps', async () => {
    const workspace = await writeWorkspace({
      steps: [
        { id: 'assert-result', kind: 'assertText', text: 'Missing: matcha' },
      ],
    })
    const recipePath = path.join(workspace, 'browser-flows/platforms/demo/flows/demo.search.recipe.json')
    const before = JSON.parse(await readFile(recipePath, 'utf8'))

    await withFakeGateway(async (port) => {
      const result = await runRunner([
        '--workspace-dir', workspace,
        '--recipe-id', 'demo.search',
        '--params-json', '{"query":"matcha"}',
        '--asset-update-mode', 'learning',
      ], {
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(port),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: 'runner-test-token',
      })

      expect(result.status).toBe(2)
      expect(result.parsed.patchStatus).toBe('write_back')
      const after = JSON.parse(await readFile(recipePath, 'utf8'))
      expect(after.steps).toEqual(before.steps)
      expect(after.freshness.failureCount).toBe(1)
      expect(after.blockers).toContain('assertion_failed')
    })
  })

  it('runs validation smoke after write-back when requested', async () => {
    const workspace = await writeWorkspace({
      steps: [
        { id: 'status', kind: 'status' },
      ],
    })

    await withFakeGateway(async (port, calls) => {
      const result = await runRunner([
        '--workspace-dir', workspace,
        '--recipe-id', 'demo.search',
        '--params-json', '{"query":"matcha"}',
        '--asset-update-mode', 'learning',
        '--validation-smoke',
      ], {
        MATCHACLAW_RUNTIME_HOST_GATEWAY_PORT: String(port),
        MATCHACLAW_RUNTIME_HOST_GATEWAY_TOKEN: 'runner-test-token',
      })

      expect(result.status).toBe(0)
      expect(result.parsed.postWriteBackValidation).toMatchObject({ ok: true, status: 'success' })
      expect(calls.map((call) => call.action)).toEqual(['status', 'status'])
    })
  })
})
