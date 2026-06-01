import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { basename, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { StdinMessage, StdoutMessage } from './controlTypes.js'
import type { SDKUserMessage } from './coreTypes.js'
import { distRoot } from '../../utils/distRoot.js'
import type { Options } from './runtimeTypes.js'

export type ProcessTransportOptions = {
  prompt?: string
  options?: Options
  onInitializeRequestId?: (requestId: string) => void
}

export type ProcessTransportEvent =
  | { type: 'message'; message: StdoutMessage }
  | { type: 'error'; error: Error }
  | { type: 'exit'; code: number | null; signal: NodeJS.Signals | null }

export class ProcessTransport {
  private child: ReturnType<typeof spawn> | undefined
  private readonly listeners = new Set<(event: ProcessTransportEvent) => void>()

  constructor(private readonly params: ProcessTransportOptions) {}

  start(): void {
    if (this.child) return

    const executable = this.resolveExecutable()
    const args = this.buildArgs()
    const child = spawn(executable.command, [...executable.args, ...args], {
      cwd: this.params.options?.cwd,
      env: {
        ...process.env,
        ...this.params.options?.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    child.on('error', error => {
      this.emit({ type: 'error', error })
    })
    child.on('exit', (code, signal) => {
      this.emit({ type: 'exit', code, signal })
    })

    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', line => {
      const trimmed = line.trim()
      if (!trimmed) return
      try {
        this.emit({
          type: 'message',
          message: JSON.parse(trimmed) as StdoutMessage,
        })
      } catch (cause) {
        this.emit({
          type: 'error',
          error: new Error(`Failed to parse SDK stdout JSON: ${trimmed}`, {
            cause,
          }),
        })
      }
    })

    child.stderr.on('data', chunk => {
      const text = String(chunk).trim()
      if (!text) return
      this.emit({ type: 'error', error: new Error(text) })
    })

    this.sendInitialize()
    if (this.params.prompt !== undefined) {
      this.sendUserPrompt(this.params.prompt)
    }
  }

  onEvent(listener: (event: ProcessTransportEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  send(message: StdinMessage): void {
    const stdin = this.child?.stdin
    if (!stdin?.writable) {
      throw new Error('SDK process transport is not writable')
    }
    stdin.write(`${JSON.stringify(message)}\n`)
  }

  close(): void {
    const child = this.child
    if (!child) return
    child.stdin?.end()
    if (!child.killed) child.kill('SIGTERM')
  }

  private emit(event: ProcessTransportEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private sendInitialize(): void {
    const options = this.params.options ?? {}
    const requestId = randomUUID()
    this.params.onInitializeRequestId?.(requestId)
    const request: StdinMessage = {
      type: 'control_request',
      request_id: requestId,
      request: {
        subtype: 'initialize',
        hooks: options.hooks as never,
        sdkMcpServers: options.sdkMcpServers?.map(server => server.name),
        jsonSchema: options.jsonSchema,
        systemPrompt: options.systemPrompt,
        appendSystemPrompt: options.appendSystemPrompt,
        agents: options.agents as never,
        promptSuggestions: options.promptSuggestions,
        agentProgressSummaries: options.agentProgressSummaries,
      },
    }
    this.send(request)
  }

  private sendUserPrompt(prompt: string): void {
    const message: SDKUserMessage = {
      type: 'user',
      content: prompt,
      uuid: randomUUID(),
      session_id: '',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
    }
    this.send(message as unknown as StdinMessage)
  }

  private buildArgs(): string[] {
    const options = this.params.options ?? {}
    const args = [
      '-p',
      '',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
    ]

    if (options.model) args.push('--model', options.model)
    if (options.permissionMode) {
      args.push('--permission-mode', options.permissionMode)
    }
    for (const tool of options.allowedTools ?? []) {
      args.push('--allowedTools', tool)
    }
    for (const tool of options.disallowedTools ?? []) {
      args.push('--disallowedTools', tool)
    }
    if (typeof options.maxTurns === 'number') {
      args.push('--max-turns', String(options.maxTurns))
    }
    if (typeof options.maxBudgetUsd === 'number') {
      args.push('--max-budget-usd', String(options.maxBudgetUsd))
    }
    if (typeof options.taskBudget === 'number') {
      args.push('--task-budget', String(options.taskBudget))
    }
    if (options.mcpServers) {
      args.push(
        '--mcp-config',
        JSON.stringify({ mcpServers: options.mcpServers }),
      )
    }
    if (options.resume) args.push('--resume', options.resume)
    if (options.continue) args.push('--continue')
    if (options.forkSession) args.push('--fork-session')
    if (options.includePartialMessages) args.push('--include-partial-messages')

    return args
  }

  private resolveExecutable(): { command: string; args: string[] } {
    const options = this.params.options ?? {}
    const explicit = options.pathToMatchaExecutable ?? options.executable
    if (explicit) return { command: explicit, args: [] }

    if (basename(distRoot) === 'dist') {
      return {
        command: process.execPath,
        args: [resolve(distRoot, 'cli-node.js')],
      }
    }

    return {
      command: 'bun',
      args: [resolve(distRoot, 'src/entrypoints/cli.tsx')],
    }
  }
}
