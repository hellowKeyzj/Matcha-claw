import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { WSContext } from 'hono/ws'
import * as acp from '@agentclientprotocol/sdk'
import { send } from './client-send.js'
import {
  PERMISSION_TIMEOUT_MS,
  generateRequestId,
  getAgentConfig,
  logPerm,
  logWs,
} from './runtime-state.js'
import { clients } from './runtime-state.js'
import type { ClientState } from './types.js'

// Create a Client implementation that forwards events to WebSocket
export function createClient(
  ws: WSContext,
  clientState: ClientState,
): acp.Client {
  return {
    async requestPermission(params) {
      const requestId = generateRequestId()
      logPerm.debug({ requestId, title: params.toolCall.title }, 'requested')

      const outcomePromise = new Promise<
        { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string }
      >(resolve => {
        const timeout = setTimeout(() => {
          logPerm.warn({ requestId }, 'timed out')
          clientState.pendingPermissions.delete(requestId)
          resolve({ outcome: 'cancelled' })
        }, PERMISSION_TIMEOUT_MS)

        clientState.pendingPermissions.set(requestId, { resolve, timeout })
      })

      send(ws, 'permission_request', {
        requestId,
        sessionId: params.sessionId,
        options: params.options,
        toolCall: params.toolCall,
      })

      const outcome = await outcomePromise
      logPerm.debug({ requestId, outcome: outcome.outcome }, 'resolved')

      return { outcome }
    },

    async sessionUpdate(params) {
      send(ws, 'session_update', params)
    },

    async readTextFile(params) {
      const filePath = resolveWorkspaceFilePath(params.path)
      logWs.debug({ path: params.path }, 'readTextFile')
      return { content: await readFile(filePath, 'utf8') }
    },

    async writeTextFile(params) {
      const filePath = resolveWorkspaceFilePath(params.path)
      logWs.debug({ path: params.path }, 'writeTextFile')
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, params.content, 'utf8')
      return {}
    },
  }
}

// Handle permission response from client
function resolveWorkspaceFilePath(path: string): string {
  const workspaceRoot = resolve(getAgentConfig().cwd)
  const filePath = isAbsolute(path)
    ? resolve(path)
    : resolve(workspaceRoot, path)
  const relativePath = relative(workspaceRoot, filePath)
  if (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  ) {
    return filePath
  }
  throw new Error(`File path escapes ACP workspace: ${path}`)
}

export function handlePermissionResponse(
  ws: WSContext,
  payload: {
    requestId: string
    outcome:
      | { outcome: 'cancelled' }
      | { outcome: 'selected'; optionId: string }
  },
): void {
  const state = clients.get(ws)
  if (!state) {
    logPerm.warn('response from unknown client')
    return
  }

  const pending = state.pendingPermissions.get(payload.requestId)
  if (!pending) {
    logPerm.warn(
      { requestId: payload.requestId },
      'response for unknown request',
    )
    return
  }

  clearTimeout(pending.timeout)
  state.pendingPermissions.delete(payload.requestId)
  pending.resolve(payload.outcome)
}

// Cancel all pending permissions for a client (called on disconnect)
export function cancelPendingPermissions(clientState: ClientState): void {
  for (const [requestId, pending] of clientState.pendingPermissions) {
    logPerm.debug({ requestId }, 'cancelled on disconnect')
    clearTimeout(pending.timeout)
    pending.resolve({ outcome: 'cancelled' })
  }
  clientState.pendingPermissions.clear()
}
