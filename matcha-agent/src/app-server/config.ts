import { resolve } from 'node:path'
import type { AppServerConfig } from './protocol/types.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 0
const DEFAULT_STORAGE_ROOT = '.matcha-agent-app-server'
const DEFAULT_WORKER_READY_TIMEOUT_MS = 30_000
const DEFAULT_WORKER_HEARTBEAT_TIMEOUT_MS = 45_000
const DEFAULT_MAX_CLIENT_QUEUE_SIZE = 256
const WORKER_ARGS_SEPARATOR = '--'

export type AppServerConfigParseResult =
  | { resultType: 'success'; config: AppServerConfig }
  | { resultType: 'invalid'; message: string }

export type AppServerConfigEnv = Record<string, string | undefined>

export function parseAppServerConfig(
  argv: string[],
  env: AppServerConfigEnv = process.env,
  cwd = process.cwd(),
): AppServerConfigParseResult {
  const parsedArgv = parseArgv(argv)
  if (parsedArgv.resultType === 'invalid') return parsedArgv

  const host =
    parsedArgv.options.host ?? env.MATCHA_AGENT_APP_SERVER_HOST ?? DEFAULT_HOST
  const port = parsePort(
    parsedArgv.options.port ?? env.MATCHA_AGENT_APP_SERVER_PORT,
    DEFAULT_PORT,
    'port',
  )
  if (port.resultType === 'invalid') return port

  const storageRoot = resolve(
    cwd,
    parsedArgv.options.storageRoot ??
      env.MATCHA_AGENT_APP_SERVER_STORAGE_ROOT ??
      DEFAULT_STORAGE_ROOT,
  )
  const authToken =
    parsedArgv.options.authToken ?? env.MATCHA_AGENT_APP_SERVER_AUTH_TOKEN
  const workerCommand =
    parsedArgv.options.workerCommand ??
    env.MATCHA_AGENT_APP_SERVER_WORKER_COMMAND ??
    process.execPath
  const workerArgs =
    parsedArgv.workerArgs.length > 0
      ? parsedArgv.workerArgs
      : env.MATCHA_AGENT_APP_SERVER_WORKER_ARGS !== undefined
        ? splitWorkerArgs(env.MATCHA_AGENT_APP_SERVER_WORKER_ARGS)
        : defaultWorkerArgs()

  const workerReadyTimeoutMs = parsePositiveInteger(
    parsedArgv.options.workerReadyTimeoutMs ??
      env.MATCHA_AGENT_APP_SERVER_WORKER_READY_TIMEOUT_MS,
    DEFAULT_WORKER_READY_TIMEOUT_MS,
    'workerReadyTimeoutMs',
  )
  if (workerReadyTimeoutMs.resultType === 'invalid') return workerReadyTimeoutMs

  const workerHeartbeatTimeoutMs = parsePositiveInteger(
    parsedArgv.options.workerHeartbeatTimeoutMs ??
      env.MATCHA_AGENT_APP_SERVER_WORKER_HEARTBEAT_TIMEOUT_MS,
    DEFAULT_WORKER_HEARTBEAT_TIMEOUT_MS,
    'workerHeartbeatTimeoutMs',
  )
  if (workerHeartbeatTimeoutMs.resultType === 'invalid')
    return workerHeartbeatTimeoutMs

  const maxClientQueueSize = parsePositiveInteger(
    parsedArgv.options.maxClientQueueSize ??
      env.MATCHA_AGENT_APP_SERVER_MAX_CLIENT_QUEUE_SIZE,
    DEFAULT_MAX_CLIENT_QUEUE_SIZE,
    'maxClientQueueSize',
  )
  if (maxClientQueueSize.resultType === 'invalid') return maxClientQueueSize

  return {
    resultType: 'success',
    config: {
      host,
      port: port.value,
      storageRoot,
      ...(authToken !== undefined && authToken !== '' ? { authToken } : {}),
      workerCommand,
      workerArgs,
      workerReadyTimeoutMs: workerReadyTimeoutMs.value,
      workerHeartbeatTimeoutMs: workerHeartbeatTimeoutMs.value,
      maxClientQueueSize: maxClientQueueSize.value,
    },
  }
}

type ParsedArgvOptions = {
  host?: string
  port?: string
  storageRoot?: string
  authToken?: string
  workerCommand?: string
  workerReadyTimeoutMs?: string
  workerHeartbeatTimeoutMs?: string
  maxClientQueueSize?: string
}

type ParsedArgvResult =
  | { resultType: 'success'; options: ParsedArgvOptions; workerArgs: string[] }
  | { resultType: 'invalid'; message: string }

function parseArgv(argv: string[]): ParsedArgvResult {
  const options: ParsedArgvOptions = {}
  const workerArgs: string[] = []

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === WORKER_ARGS_SEPARATOR) {
      workerArgs.push(...argv.slice(index + 1))
      break
    }

    const parsedOption = parseOption(argument, argv[index + 1])
    if (parsedOption.resultType === 'invalid') return parsedOption
    if (parsedOption.resultType === 'notOption') {
      workerArgs.push(argument)
      continue
    }

    options[parsedOption.key] = parsedOption.value
    if (parsedOption.consumedNextArgument) index++
  }

  return { resultType: 'success', options, workerArgs }
}

type ParsedOptionResult =
  | {
      resultType: 'option'
      key: keyof ParsedArgvOptions
      value: string
      consumedNextArgument: boolean
    }
  | { resultType: 'notOption' }
  | { resultType: 'invalid'; message: string }

function parseOption(
  argument: string,
  nextArgument: string | undefined,
): ParsedOptionResult {
  if (!argument.startsWith('--')) return { resultType: 'notOption' }

  const equalsIndex = argument.indexOf('=')
  const optionName =
    equalsIndex === -1 ? argument.slice(2) : argument.slice(2, equalsIndex)
  const inlineValue =
    equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1)
  const key = optionKeyForName(optionName)
  if (!key)
    return {
      resultType: 'invalid',
      message: `Unknown app-server option: --${optionName}`,
    }

  if (inlineValue !== undefined) {
    return {
      resultType: 'option',
      key,
      value: inlineValue,
      consumedNextArgument: false,
    }
  }

  if (nextArgument === undefined || nextArgument.startsWith('--')) {
    return {
      resultType: 'invalid',
      message: `Missing value for app-server option: --${optionName}`,
    }
  }

  return {
    resultType: 'option',
    key,
    value: nextArgument,
    consumedNextArgument: true,
  }
}

function optionKeyForName(name: string): keyof ParsedArgvOptions | undefined {
  switch (name) {
    case 'host':
      return 'host'
    case 'port':
      return 'port'
    case 'storage-root':
      return 'storageRoot'
    case 'auth-token':
      return 'authToken'
    case 'worker-command':
      return 'workerCommand'
    case 'worker-ready-timeout-ms':
      return 'workerReadyTimeoutMs'
    case 'worker-heartbeat-timeout-ms':
      return 'workerHeartbeatTimeoutMs'
    case 'max-client-queue-size':
      return 'maxClientQueueSize'
    default:
      return undefined
  }
}

type NumberParseResult =
  | { resultType: 'success'; value: number }
  | { resultType: 'invalid'; message: string }

function parsePort(
  value: string | undefined,
  defaultValue: number,
  label: string,
): NumberParseResult {
  if (value === undefined || value === '')
    return { resultType: 'success', value: defaultValue }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    return {
      resultType: 'invalid',
      message: `${label} must be an integer between 0 and 65535`,
    }
  }
  return { resultType: 'success', value: parsed }
}

function parsePositiveInteger(
  value: string | undefined,
  defaultValue: number,
  label: string,
): NumberParseResult {
  if (value === undefined || value === '')
    return { resultType: 'success', value: defaultValue }
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return {
      resultType: 'invalid',
      message: `${label} must be a positive integer`,
    }
  }
  return { resultType: 'success', value: parsed }
}

function defaultWorkerArgs(): string[] {
  const entrypoint = process.argv[1]
  if (!entrypoint) return ['--matcha-agent-worker-entry']
  return [entrypoint, '--matcha-agent-worker-entry']
}

function splitWorkerArgs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return []
  return value.split(' ').filter(argument => argument.length > 0)
}
