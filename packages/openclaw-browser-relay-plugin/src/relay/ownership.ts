import { execFile } from 'node:child_process'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { PluginLogger } from 'openclaw/plugin-sdk'
import { createServer } from 'node:net'
import path from 'node:path'
import { resolveRelayPluginStatePath } from './paths.js'

const OWNER_FILE_NAME = 'relay-owner.json'
const PROCESS_INFO_TIMEOUT_MS = 5_000
const PORT_WAIT_TIMEOUT_MS = 10_000
const PORT_POLL_INTERVAL_MS = 100
const PROCESS_MATCH_TOLERANCE_MS = 5_000

export type RelayProcessInfo = {
  pid: number
  startedAtMs: number | null
  command: string
}

export type RelayOwnerRecord = RelayProcessInfo & {
  port: number
}

type RelayOwnershipOptions = {
  port: number
  logger: PluginLogger
  stateDir?: string
}

export function getRelayOwnerFilePath(stateDir?: string): string {
  return resolveRelayPluginStatePath(OWNER_FILE_NAME, stateDir)
}

function execFileAsync(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: PROCESS_INFO_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(error)
        return
      }
      resolve(stdout.trim())
    })
  })
}

function parseWindowsCreationDate(raw: string | undefined): number | null {
  const value = raw?.trim()
  if (!value) {
    return null
  }
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (!match) {
    return null
  }
  const [, year, month, day, hour, minute, second] = match
  const parsed = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  ).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

async function inspectRelayProcessWindows(pid: number): Promise<RelayProcessInfo | null> {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    'if ($null -eq $p) { exit 0 }',
    '$p | Select-Object ProcessId, CreationDate, CommandLine | ConvertTo-Json -Compress',
  ].join('; ')
  const stdout = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).catch(() => '')
  if (!stdout) {
    return null
  }
  const parsed = JSON.parse(stdout) as { ProcessId?: number; CreationDate?: string; CommandLine?: string }
  if (typeof parsed.ProcessId !== 'number') {
    return null
  }
  return {
    pid: parsed.ProcessId,
    startedAtMs: parseWindowsCreationDate(parsed.CreationDate),
    command: typeof parsed.CommandLine === 'string' ? parsed.CommandLine.trim() : '',
  }
}

async function inspectRelayProcessPosix(pid: number): Promise<RelayProcessInfo | null> {
  const stdout = await execFileAsync('ps', ['-p', String(pid), '-o', 'etimes=', '-o', 'command=']).catch(() => '')
  if (!stdout) {
    return null
  }
  const match = stdout.match(/^\s*(\d+)\s+([\s\S]+)$/)
  if (!match) {
    return null
  }
  const elapsedSeconds = Number(match[1])
  if (!Number.isFinite(elapsedSeconds)) {
    return null
  }
  return {
    pid,
    startedAtMs: Date.now() - elapsedSeconds * 1_000,
    command: match[2]?.trim() ?? '',
  }
}

export async function inspectRelayProcess(pid: number): Promise<RelayProcessInfo | null> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return null
  }
  return process.platform === 'win32'
    ? await inspectRelayProcessWindows(pid)
    : await inspectRelayProcessPosix(pid)
}

async function readRelayOwnerRecord(stateDir?: string): Promise<RelayOwnerRecord | null> {
  try {
    const filePath = getRelayOwnerFilePath(stateDir)
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as Partial<RelayOwnerRecord>
    if (!Number.isInteger(parsed.pid) || !Number.isInteger(parsed.port)) {
      return null
    }
    return {
      pid: parsed.pid,
      port: parsed.port,
      startedAtMs: typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs) ? parsed.startedAtMs : null,
      command: typeof parsed.command === 'string' ? parsed.command.trim() : '',
    }
  } catch {
    return null
  }
}

async function removeRelayOwnerRecord(stateDir?: string): Promise<void> {
  const filePath = getRelayOwnerFilePath(stateDir)
  await rm(filePath, { force: true }).catch(() => {})
}

function matchesRelayOwner(record: RelayOwnerRecord, live: RelayProcessInfo | null): boolean {
  if (!live || live.pid !== record.pid) {
    return false
  }
  if (record.command && live.command && record.command !== live.command) {
    return false
  }
  if (record.startedAtMs !== null && live.startedAtMs !== null) {
    return Math.abs(record.startedAtMs - live.startedAtMs) <= PROCESS_MATCH_TOLERANCE_MS
  }
  return true
}

async function isPortFree(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => {
      probe.close(() => resolve(true))
    })
    probe.listen(port, '127.0.0.1')
  })
}

async function waitForPortFree(port: number): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < PORT_WAIT_TIMEOUT_MS) {
    if (await isPortFree(port)) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS))
  }
  throw new Error(`Relay port ${port} did not become free after ${PORT_WAIT_TIMEOUT_MS}ms`)
}

async function terminateRelayOwnerProcess(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
    return
  }

  if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/F', '/PID', String(pid), '/T']).catch(() => {})
    return
  }

  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }

  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    if ((await inspectRelayProcess(pid)) === null) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, PORT_POLL_INTERVAL_MS))
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // noop
  }
}

async function describeListeningProcess(pid: number): Promise<string> {
  const live = await inspectRelayProcess(pid)
  if (!live) {
    return `pid=${pid}`
  }
  if (!live.command) {
    return `pid=${pid}`
  }
  return `pid=${pid}, command=${live.command}`
}

async function getListeningProcessIds(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const script = [
      `$connections = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
      'if ($connections) { $connections | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique | ConvertTo-Json -Compress }',
    ].join('; ')
    const stdout = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]).catch(() => '')
    if (!stdout) {
      return []
    }
    const parsed = JSON.parse(stdout) as number | number[]
    return (Array.isArray(parsed) ? parsed : [parsed]).filter((value) => Number.isInteger(value) && value > 0)
  }

  const stdout = await execFileAsync('lsof', ['-nP', '-iTCP@127.0.0.1:' + port, '-sTCP:LISTEN', '-t']).catch(() => '')
  if (!stdout) {
    return []
  }
  return stdout
    .split(/\r?\n/)
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0)
}

export async function ensureRelayPortOwnership(options: RelayOwnershipOptions): Promise<void> {
  if (!Number.isInteger(options.port) || options.port <= 0) {
    return
  }

  const ownerRecord = await readRelayOwnerRecord(options.stateDir)
  if (await isPortFree(options.port)) {
    if (ownerRecord) {
      await removeRelayOwnerRecord(options.stateDir)
    }
    return
  }

  if (ownerRecord?.port === options.port) {
    const liveOwner = await inspectRelayProcess(ownerRecord.pid)
    if (matchesRelayOwner(ownerRecord, liveOwner)) {
      options.logger.warn?.(
        `[browser-relay] reclaiming stale relay owner pid=${ownerRecord.pid} on 127.0.0.1:${options.port}`,
      )
      await terminateRelayOwnerProcess(ownerRecord.pid)
      await waitForPortFree(options.port)
      await removeRelayOwnerRecord(options.stateDir)
      return
    }
  }

  const listeningPids = await getListeningProcessIds(options.port)
  const ownerDescription = listeningPids.length > 0
    ? await describeListeningProcess(listeningPids[0])
    : 'owner=unknown'
  throw new Error(`Relay port ${options.port} is already in use by another process (${ownerDescription})`)
}

export async function claimRelayPortOwnership(options: RelayOwnershipOptions): Promise<void> {
  if (!Number.isInteger(options.port) || options.port <= 0) {
    return
  }

  const liveProcess = await inspectRelayProcess(process.pid)
  const record: RelayOwnerRecord = {
    pid: process.pid,
    port: options.port,
    startedAtMs: liveProcess?.startedAtMs ?? null,
    command: liveProcess?.command ?? '',
  }
  const filePath = getRelayOwnerFilePath(options.stateDir)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8')
}

export async function releaseRelayPortOwnership(options: Pick<RelayOwnershipOptions, 'port' | 'stateDir'>): Promise<void> {
  if (!Number.isInteger(options.port) || options.port <= 0) {
    return
  }

  const ownerRecord = await readRelayOwnerRecord(options.stateDir)
  if (ownerRecord?.pid === process.pid && ownerRecord.port === options.port) {
    await removeRelayOwnerRecord(options.stateDir)
    return
  }

  try {
    await access(getRelayOwnerFilePath(options.stateDir))
  } catch {
    return
  }
}
