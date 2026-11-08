import type { OpenClawConfig } from 'openclaw/plugin-sdk/plugin-entry'
import { isIncognitoSessionKey, isSubagentSessionKey, normalizeAgentIdStrict, parseAgentSessionKey } from 'openclaw/plugin-sdk/routing'
import { getSessionEntry, resolveStorePath } from 'openclaw/plugin-sdk/session-store-runtime'
import type { BrowserActionContext } from '../browser-action-contract.js'
import { browserPrincipalId } from '../state/page-ownership.js'

function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0')
}

export function resolveBrowserContext(context: BrowserActionContext, config: OpenClawConfig): BrowserActionContext {
  if (!identifier(context.agentId) || !identifier(context.sessionKey) || !identifier(context.sessionId)) {
    throw new Error('Browser ownership requires a trusted OpenClaw agentId, sessionKey and sessionId.')
  }
  const seen = new Set<string>()
  let sessionKey = context.sessionKey
  let expectedSessionId: string | undefined = context.sessionId
  let leafSessionKey = sessionKey
  for (let depth = 0; depth < 64; depth += 1) {
    const parsed = parseAgentSessionKey(sessionKey)
    const agentId = parsed && normalizeAgentIdStrict(parsed.agentId)
    if (!parsed || !agentId?.ok || agentId.value !== parsed.agentId || depth === 0 && parsed.agentId !== context.agentId) {
      throw new Error('The OpenClaw browser session identity is invalid.')
    }
    sessionKey = `agent:${parsed.agentId}:${parsed.rest}`
    if (depth === 0) leafSessionKey = sessionKey
    if (isIncognitoSessionKey(sessionKey)) throw new Error('Process-only OpenClaw sessions cannot own browser pages.')
    if (seen.has(sessionKey)) throw new Error('The OpenClaw browser session lineage contains a cycle.')
    seen.add(sessionKey)
    const entry = getSessionEntry({
      agentId: parsed.agentId,
      sessionKey,
      storePath: resolveStorePath(config.session?.store, { agentId: parsed.agentId }),
      readConsistency: 'latest',
      hydrateSkillPromptRefs: false,
    })
    if (!entry || !identifier(entry.sessionId) || expectedSessionId !== undefined && entry.sessionId !== expectedSessionId) {
      throw new Error('The OpenClaw browser session lineage is no longer current.')
    }
    if (entry.incognito || entry.initializationPending) throw new Error('The OpenClaw browser session is not available for browser ownership.')
    if (entry.parentSessionKey !== undefined || entry.spawnedBy !== undefined) {
      const parentKey = entry.parentSessionKey ?? entry.spawnedBy
      if (!identifier(parentKey) || entry.spawnedBy !== undefined && entry.spawnedBy !== parentKey
        || entry.parentSessionId !== undefined && !identifier(entry.parentSessionId)) {
        throw new Error('The OpenClaw browser session has inconsistent parent receipts.')
      }
      // Key-only dashboard grouping is navigation, not browser execution ancestry.
      if (entry.spawnedBy !== undefined || entry.parentSessionId !== undefined || isSubagentSessionKey(sessionKey)) {
        sessionKey = parentKey
        expectedSessionId = entry.parentSessionId
        continue
      }
    }
    if (entry.parentSessionId !== undefined || isSubagentSessionKey(sessionKey)) {
      throw new Error('The OpenClaw browser child session has no trusted parent receipt.')
    }
    return {
      ...context,
      sessionKey: leafSessionKey,
      rootSessionKey: sessionKey,
      sessionGroupId: browserPrincipalId({ ...context, agentId: parsed.agentId, sessionKey }),
    }
  }
  throw new Error('The OpenClaw browser session lineage is too deep.')
}
