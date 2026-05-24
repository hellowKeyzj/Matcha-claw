import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
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

async function withFakeGateway<T>(handler: (port: number, calls: Record<string, unknown>[]) => Promise<T>): Promise<T> {
  const port = await findFreePort()
  const token = 'runner-test-token'
  const calls: Record<string, unknown>[] = []
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
        socket.send(JSON.stringify({
          type: 'res',
          id: message.id,
          ok: true,
          payload: {
            ok: true,
            snapshot: '- button "Search" [ref=button-1]\nResult: matcha',
            refs: {
              'button-1': { role: 'button', name: 'Search', componentId: 'demo.search-button' },
            },
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
})
