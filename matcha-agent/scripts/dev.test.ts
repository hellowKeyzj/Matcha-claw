import { describe, expect, test } from 'bun:test'
import { createDevLaunchSpec } from './dev.ts'

const DEFINE_ARGS = ['-d', 'MACRO.VERSION:"test"']
const FEATURE_ARGS = ['--feature', 'APP_SERVER', '--feature', 'BRIDGE_MODE']

function launch(argv: string[], env: Record<string, string | undefined> = {}) {
  return createDevLaunchSpec({
    argv,
    env,
    bunExecutable: '/bin/bun',
    cliPath: '/repo/src/entrypoints/cli.tsx',
    defineArgs: DEFINE_ARGS,
    featureArgs: FEATURE_ARGS,
  })
}

describe('createDevLaunchSpec', () => {
  test('runs normal CLI commands with dev defines and features only once', () => {
    expect(launch(['--version'])).toEqual({
      command: '/bin/bun',
      args: [
        'run',
        ...DEFINE_ARGS,
        ...FEATURE_ARGS,
        '/repo/src/entrypoints/cli.tsx',
        '--version',
      ],
      env: {},
    })
  })

  test('passes dev worker args to app-server after the app-server separator', () => {
    const spec = launch(['app-server', '--host', '127.0.0.1', '--port', '3210'])

    expect(spec.args).toEqual([
      'run',
      ...DEFINE_ARGS,
      ...FEATURE_ARGS,
      '/repo/src/entrypoints/cli.tsx',
      'app-server',
      '--host',
      '127.0.0.1',
      '--port',
      '3210',
      '--',
      'run',
      ...DEFINE_ARGS,
      ...FEATURE_ARGS,
      '/repo/src/entrypoints/cli.tsx',
      '--matcha-agent-worker-entry',
    ])
    expect(spec.env).toEqual({})
  })

  test('keeps explicit app-server worker args unchanged', () => {
    const spec = launch([
      'app-server',
      '--host',
      '127.0.0.1',
      '--',
      'custom-worker-entry',
      '--matcha-agent-worker-entry',
    ])

    expect(spec.args).toEqual([
      'run',
      ...DEFINE_ARGS,
      ...FEATURE_ARGS,
      '/repo/src/entrypoints/cli.tsx',
      'app-server',
      '--host',
      '127.0.0.1',
      '--',
      'custom-worker-entry',
      '--matcha-agent-worker-entry',
    ])
  })

  test('keeps env worker args unchanged for app-server', () => {
    const spec = launch(['app-server'], {
      MATCHA_AGENT_APP_SERVER_WORKER_ARGS:
        'custom-worker-entry --matcha-agent-worker-entry',
    })

    expect(spec.args).toEqual([
      'run',
      ...DEFINE_ARGS,
      ...FEATURE_ARGS,
      '/repo/src/entrypoints/cli.tsx',
      'app-server',
    ])
    expect(spec.env).toEqual({
      MATCHA_AGENT_APP_SERVER_WORKER_ARGS:
        'custom-worker-entry --matcha-agent-worker-entry',
    })
  })
})
