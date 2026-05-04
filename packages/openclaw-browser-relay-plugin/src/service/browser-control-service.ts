import type { PluginLogger } from 'openclaw/plugin-sdk'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  type BrowserActionParams,
  type BrowserActAction,
  type BrowserConnectionMode,
  type BrowserCookieInput,
  browserDataOperations,
  closeAgentTabsActions,
  type MouseButton,
  type RelayDirectAction,
  relayDirectActions,
  type BrowserStorageType,
  type WaitLoadState,
} from '../browser-action-contract.js'
import { BrowserRelayServer, type ReadyRelayTarget } from '../relay/server.js'
import {
  discoverChromeInstancesLight,
  getDirectCdpVersion,
  listDirectCdpTabs,
  M144_PLACEHOLDER_TARGET_ID,
  type ResolvedCdpEndpoint,
  resolveCdpEndpoint,
} from '../direct-cdp/discovery.js'
import { BrowserTabState } from '../state/browser-tab-state.js'
import { PlaywrightSession } from '../playwright/session.js'
import { PlaywrightActions } from '../playwright/actions.js'
import { InstalledProfileAutoLauncher } from '../browser-launch/installed-profile-auto-launcher.js'

export type BrowserControlServiceOptions = {
  logger: PluginLogger
  relay: BrowserRelayServer
  stateDir?: string
}

type BrowserActionErrorCode =
  | 'invalid_request'
  | 'unsupported_action'
  | 'browser_unavailable'
  | 'direct_cdp_unavailable'
  | 'no_current_target'
  | 'stale_snapshot_ref'
  | 'target_closed'
  | 'browser_closed'
  | 'page_context_destroyed'
  | 'browser_not_ready'
  | 'target_attach_timeout'
  | 'browser_auto_launch_unavailable'
  | 'browser_auto_launch_failed'
  | 'protocol_error'

type BrowserActionResult = Record<string, unknown> & {
  ok?: boolean
  error?: string
  errorCode?: BrowserActionErrorCode
  recoverable?: boolean
  retryable?: boolean
  suggestedNextActions?: string[]
}

type BrowserActionErrorOptions = {
  recoverable?: boolean
  retryable?: boolean
  suggestedNextActions?: string[]
}

type RelayDirectBrowserActionParams = Extract<BrowserActionParams, { action: RelayDirectAction }>
type PlaywrightBrowserActionParams = Extract<
  BrowserActionParams,
  {
    action:
      | 'navigate'
      | 'snapshot'
      | 'screenshot'
      | 'scroll'
      | 'errors'
      | 'requests'
      | 'cookies'
      | 'storage'
      | 'highlight'
      | 'upload'
      | 'dialog'
      | 'pdf'
      | 'act'
  }
>
type PlaywrightBrowserActionName = PlaywrightBrowserActionParams['action']

const playwrightActionNames = [
  'navigate',
  'snapshot',
  'screenshot',
  'scroll',
  'errors',
  'requests',
  'cookies',
  'storage',
  'highlight',
  'upload',
  'dialog',
  'pdf',
  'act',
] as const satisfies readonly PlaywrightBrowserActionName[]

type PlaywrightPageLike = {
  url(): string
}

type PlaywrightBrowserLike = {
  contexts(): Array<{
    pages(): PlaywrightPageLike[]
  }>
}

type BrowserCookieRecord = {
  name: string
  value: string
  domain?: string
  path?: string
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
  session?: boolean
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.map((entry) => String(entry).trim()).filter(Boolean)
    : undefined
}

function asDataOperation(value: unknown): (typeof browserDataOperations)[number] | undefined {
  const normalized = asString(value)
  return normalized && browserDataOperations.includes(normalized as (typeof browserDataOperations)[number])
    ? normalized as (typeof browserDataOperations)[number]
    : undefined
}

function asMouseButton(value: unknown): MouseButton | undefined {
  const normalized = asString(value)
  return normalized === 'left' || normalized === 'middle' || normalized === 'right'
    ? normalized
    : undefined
}

function asWaitLoadState(value: unknown): WaitLoadState | undefined {
  const normalized = asString(value)
  return normalized === 'load' || normalized === 'domcontentloaded' || normalized === 'networkidle'
    ? normalized
    : undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function asCookieArray(value: unknown): BrowserCookieInput[] | undefined {
  if (!Array.isArray(value)) return undefined

  const cookies: BrowserCookieInput[] = []
  for (const entry of value) {
    const record = asRecord(entry)
    if (!record) continue
    const name = asString(record?.name)
    const cookieValue = asString(record?.value)
    if (!name || cookieValue === undefined) continue
    cookies.push({
      name,
      value: cookieValue,
      url: asString(record.url),
      domain: asString(record.domain),
      path: asString(record.path),
    })
  }

  return cookies
}

function normalizeBrowserCookieRecord(cookie: unknown): BrowserCookieRecord | null {
  if (!cookie || typeof cookie !== 'object') return null

  const record = cookie as Record<string, unknown>
  const name = asString(record.name)
  const value = typeof record.value === 'string' ? record.value : undefined
  if (!name || value === undefined) return null

  return {
    name,
    value,
    domain: typeof record.domain === 'string' ? record.domain : undefined,
    path: typeof record.path === 'string' ? record.path : undefined,
    expires: typeof record.expires === 'number'
      ? record.expires
      : typeof record.expirationDate === 'number'
        ? record.expirationDate
        : undefined,
    httpOnly: typeof record.httpOnly === 'boolean' ? record.httpOnly : undefined,
    secure: typeof record.secure === 'boolean' ? record.secure : undefined,
    sameSite: typeof record.sameSite === 'string' ? record.sameSite : undefined,
    session: typeof record.session === 'boolean'
      ? record.session
      : typeof record.expirationDate === 'number'
        ? false
        : undefined,
  }
}

function sanitizeFileName(input: string): string {
  return [...input].map((char) => {
    const code = char.charCodeAt(0)
    if (code >= 0 && code <= 31) return '_'
    return /[<>:"/\\|?*]/.test(char) ? '_' : char
  }).join('')
}

async function normalizeScreenshot(buffer: Buffer): Promise<Buffer> {
  const MAX_BYTES = 5 * 1024 * 1024
  const MAX_SIDE = 2_000
  if (buffer.byteLength <= MAX_BYTES) return buffer

  try {
    const sharp = (await import('sharp')).default
    const image = sharp(buffer)
    const metadata = await image.metadata()
    const resize = {
      width: (metadata.width ?? 0) > (metadata.height ?? 0) ? MAX_SIDE : undefined,
      height: (metadata.height ?? 0) >= (metadata.width ?? 0) ? MAX_SIDE : undefined,
      fit: 'inside' as const,
      withoutEnlargement: true,
    }

    let compressionLevel = 6
    let output = await image.resize(resize).png({ compressionLevel }).toBuffer()
    while (output.byteLength > MAX_BYTES && compressionLevel < 9) {
      compressionLevel += 1
      output = await sharp(buffer).resize(resize).png({ compressionLevel }).toBuffer()
    }
    return output
  } catch {
    return buffer
  }
}

function resolvePathWithinWorkspace(filePath: string | undefined, workspaceDir?: string): string | null {
  if (!filePath) return null
  const trimmed = filePath.trim()
  if (!trimmed) return null
  if (!workspaceDir) return path.resolve(trimmed)

  const resolvedWorkspace = path.resolve(workspaceDir)
  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(resolvedWorkspace, trimmed)
  return candidate === resolvedWorkspace || candidate.startsWith(`${resolvedWorkspace}${path.sep}`)
    ? candidate
    : null
}

function createErrorResult(
  errorCode: BrowserActionErrorCode,
  error: string,
  options: BrowserActionErrorOptions = {},
): BrowserActionResult {
  return {
    ok: false,
    error,
    errorCode,
    ...(options.recoverable !== undefined ? { recoverable: options.recoverable } : {}),
    ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
    ...(options.suggestedNextActions?.length ? { suggestedNextActions: options.suggestedNextActions } : {}),
  }
}

export class BrowserControlService {
  private readonly tabState = new BrowserTabState()
  private readonly session: PlaywrightSession
  private readonly actions: PlaywrightActions
  private readonly autoLauncher: InstalledProfileAutoLauncher

  constructor(private readonly options: BrowserControlServiceOptions) {
    this.session = new PlaywrightSession(
      options.logger,
      this.tabState,
      () => ({
        connected: options.relay.hasExtensionConnection,
        relayPort: options.relay.relayPort,
        authHeaders: options.relay.authHeaders,
      }),
    )
    this.actions = new PlaywrightActions(this.session)
    this.autoLauncher = new InstalledProfileAutoLauncher({
      logger: options.logger,
      relay: options.relay,
      stateDir: options.stateDir,
    })
  }

  async stop(): Promise<void> {
    this.autoLauncher.stop()
    await this.session.closeConnections()
    this.tabState.reset()
  }

  async handleRequest(params: BrowserActionParams): Promise<BrowserActionResult> {
    const action = asString((params as { action?: unknown } | null | undefined)?.action)?.toLowerCase()
    if (!action) {
      return createErrorResult('invalid_request', 'action is required')
    }

    try {
      if (action === 'stop') {
        await this.stop()
        return { ok: true, stopped: true }
      }

      if (this.isRelayDirectActionName(action)) {
        return await this.handleRelayOrDirectAction(params as RelayDirectBrowserActionParams)
      }
      if (this.isPlaywrightActionName(action)) {
        return await this.handlePlaywrightAction(
          params as PlaywrightBrowserActionParams,
          this.resolveConnectionMode(params),
        )
      }
      return createErrorResult('unsupported_action', `Unsupported browser action: ${action}`)
    } catch (error) {
      return this.classifyActionError(error, { action, connectionMode: this.resolveConnectionMode(params) })
    }
  }

  getStatus(): BrowserActionResult {
    this.syncRelayCurrentTarget()
    return {
      running: true,
      relayPort: this.options.relay.relayPort,
      extensionConnected: this.options.relay.hasExtensionConnection,
      attachedTabs: this.options.relay.listAttachments().length,
      trackedTabs: this.tabState.agentTabCount,
      retainedTabs: this.tabState.retainedTabCount,
      playwrightConnected: this.session.isPlaywrightConnected(),
    }
  }

  private isRelayDirectActionName(action: string): action is RelayDirectAction {
    return relayDirectActions.includes(action as RelayDirectAction)
  }

  private isPlaywrightActionName(action: string): action is PlaywrightBrowserActionName {
    return playwrightActionNames.includes(action as PlaywrightBrowserActionName)
  }

  private async handleRelayOrDirectAction(params: RelayDirectBrowserActionParams): Promise<BrowserActionResult> {
    const action = params.action
    let autoLaunchError: Error | null = null
    if (!this.options.relay.hasExtensionConnection && this.shouldAutoLaunchRelayAction(action)) {
      try {
        await this.autoLauncher.ensureRelayBrowserAvailable()
      } catch (error) {
        autoLaunchError = error instanceof Error ? error : new Error(String(error))
      }
    }

    if (this.options.relay.hasExtensionConnection) {
      return await this.handleRelayAction(params)
    }

    const directEndpoint = await this.resolveDirectEndpoint()
    if (!directEndpoint) {
      if (autoLaunchError) {
        throw autoLaunchError
      }
      if (action === 'start' || action === 'status' || action === 'profiles') {
        return {
          ok: true,
          enabled: true,
          profile: 'chrome',
          running: false,
          cdpReady: false,
          connectionType: 'none',
          tabCount: 0,
          pid: null,
          headless: false,
          relayPort: this.options.relay.relayPort,
        }
      }
      return createErrorResult(
        'browser_unavailable',
        'Browser extension not connected and no direct CDP browser detected.',
        {
          recoverable: true,
          suggestedNextActions: ['start', 'open'],
        },
      )
    }

    return await this.handleDirectCdpAction(params, directEndpoint)
  }

  private async handleRelayAction(params: RelayDirectBrowserActionParams): Promise<BrowserActionResult> {
    this.syncRelayCurrentTarget()
    const attachments = this.options.relay.listAttachments()
    const tabs = this.options.relay.listTabs()
    const relayPort = this.options.relay.relayPort
    const action = params.action

    if (action === 'start') {
      return {
        ok: true,
        profile: 'chrome',
        relayListening: relayPort !== null,
        relayPort,
        relayReady: this.options.relay.hasExtensionConnection,
        attachedTabs: attachments.length,
        message:
          attachments.length > 0
            ? `${attachments.length} tab(s) attached.`
            : `Relay listening on 127.0.0.1:${relayPort}. Click the extension icon to attach.`,
      }
    }

    if (action === 'status') {
      return {
        ok: true,
        enabled: true,
        profile: 'chrome',
        running: attachments.length > 0,
        cdpReady: true,
        connectionType: 'extension',
        tabCount: attachments.length,
        pid: null,
        headless: false,
        relayPort,
      }
    }

    if (action === 'profiles') {
      return {
        ok: true,
        profiles: [{ name: 'chrome', running: attachments.length > 0, tabCount: attachments.length, isDefault: true }],
      }
    }

    if (action === 'tabs') {
      return {
        ok: true,
        running: true,
        extensionConnected: true,
        tabs: tabs.map((entry) => ({
          targetKey: entry.targetKey,
          targetId: entry.physical ? entry.targetId : null,
          title: entry.title || '(no title)',
          url: entry.url || '(no url)',
          browserInstanceId: entry.browserInstanceId,
          browserName: entry.browserName,
          windowId: entry.windowId,
          tabId: entry.tabId,
          active: entry.active,
          physical: entry.physical,
          isSelectedBrowser: entry.selectedBrowser,
          isSelectedWindow: entry.selectedWindow,
          isPrimary: entry.primary,
          isAgent: entry.physical ? this.tabState.isAgent(entry.targetId) : false,
          isRetained: entry.physical ? this.tabState.isRetained(entry.targetId) : false,
        })),
      }
    }

    if (action === 'open') {
      const requestedUrl = this.resolveOpenUrl(params)
      const created = await this.options.relay.openTarget(requestedUrl)
      this.options.logger.warn?.(
        `[browser-relay] open action created target requestedUrl="${requestedUrl}" targetId=${created.targetId}`,
      )
      const attachedTarget = await this.options.relay.resolveReadyTarget(String(created.targetId))
      this.options.logger.warn?.(
        `[browser-relay] open action attached target requestedUrl="${requestedUrl}" targetId=${attachedTarget.targetId} sessionId=${attachedTarget.sessionId} windowId=${attachedTarget.windowId ?? 'null'} tabId=${attachedTarget.tabId ?? 'null'} url="${attachedTarget.url}" readyState="${attachedTarget.readyState}" mainFrameUrl="${attachedTarget.mainFrameUrl}"`,
      )
      const targetId = attachedTarget.targetId
      const sessionKey = asString(params.sessionKey)
      this.tabState.registerTab(targetId, {
        retain: asBoolean(params.retain) === true,
        sessionKey,
      })
      this.tabState.setCurrentTarget(targetId)
      this.tabState.touchTab(targetId)
      const openedUrl = attachedTarget.url || requestedUrl
      this.options.relay.updateTargetUrl(targetId, openedUrl)
      await this.options.relay.selectExecutionWindowForTargetIfUnset(targetId)
      return {
        ok: true,
        action: 'open',
        targetId,
        requestedUrl,
        url: openedUrl,
      }
    }

    if (action === 'focus') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return createErrorResult('invalid_request', 'targetId is required for action=focus')
      }
      await this.options.relay.focusTarget(targetId)
      this.tabState.setCurrentTarget(targetId)
      this.tabState.touchTab(targetId)
      return { ok: true, targetId }
    }

    if (action === 'close') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return createErrorResult('invalid_request', 'targetId is required for action=close')
      }
      await this.options.relay.closeTarget(targetId)
      this.tabState.closeTab(targetId)
      return { ok: true, targetId }
    }

    if (action === 'console') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return createErrorResult('invalid_request', 'targetId is required for action=console')
      }
      const expression = asString(params.expression)
      if (!expression) {
        return createErrorResult('invalid_request', 'expression is required for action=console')
      }
      const result = await this.options.relay.evaluate(targetId, expression)
      return { ok: true, targetId, result }
    }

    if (!closeAgentTabsActions.includes(action)) {
      return createErrorResult('unsupported_action', `Unsupported relay action: ${action}`)
    }

    const closeAgentTabsResult = await this.options.relay.closeAllAgentTabs()
    this.tabState.reset()
    return {
      ok: true,
      closed: (closeAgentTabsResult as { closed?: number }).closed ?? 0,
      retained: (closeAgentTabsResult as { retained?: number }).retained ?? 0,
    }
  }

  private async handleDirectCdpAction(
    params: RelayDirectBrowserActionParams,
    endpoint: ResolvedCdpEndpoint,
  ): Promise<BrowserActionResult> {
    const action = params.action
    const cdpUrl = endpoint.preferredUrl

    if (action === 'start' || action === 'status' || action === 'profiles') {
      const version = await getDirectCdpVersion(endpoint.port)
      const tabs = await this.syncDirectTabs(cdpUrl, endpoint.port)
      return {
        ok: true,
        enabled: true,
        profile: 'chrome',
        running: true,
        cdpReady: true,
        connectionType: 'direct-cdp',
        browser: version?.browser ?? 'Chrome',
        tabCount: tabs.length,
        pid: null,
        headless: false,
        relayPort: this.options.relay.relayPort,
        directCdpPort: endpoint.port,
        profiles: action === 'profiles' ? [{ name: 'chrome', running: true, tabCount: tabs.length, isDefault: true }] : undefined,
      }
    }

    if (action === 'tabs') {
      const tabs = await this.syncDirectTabs(cdpUrl, endpoint.port)
      return {
        ok: true,
        tabs: tabs.map((tab) => ({
          targetId: tab.targetId,
          title: tab.title,
          url: tab.url,
          isAgent: this.tabState.isAgent(tab.targetId),
          isRetained: this.tabState.isRetained(tab.targetId),
        })),
      }
    }

    if (action === 'open') {
      const requestedUrl = this.resolveOpenUrl(params)
      const result = await this.session.sendBrowserCdpCommand(cdpUrl, 'Target.createTarget', {
        url: requestedUrl,
      }, 'direct-cdp')
      const targetId = String(result?.targetId ?? '').trim()
      if (!targetId) {
        return createErrorResult('protocol_error', 'Target.createTarget returned no targetId', {
          recoverable: true,
          retryable: true,
          suggestedNextActions: ['open'],
        })
      }
      this.tabState.registerTab(targetId, {
        retain: asBoolean(params.retain) === true,
        sessionKey: asString(params.sessionKey),
      })
      this.tabState.setCurrentTarget(targetId)
      this.tabState.touchTab(targetId)
      return {
        ok: true,
        action: 'open',
        targetId,
        requestedUrl,
        url: requestedUrl,
      }
    }

    if (action === 'focus') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return createErrorResult('invalid_request', 'targetId is required for action=focus')
      }
      const page = await this.session.getPageForTargetId({ cdpUrl, targetId, mode: 'direct-cdp' })
      await page.bringToFront()
      this.tabState.setCurrentTarget(targetId)
      this.tabState.touchTab(targetId)
      return { ok: true, targetId }
    }

    if (action === 'close') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return createErrorResult('invalid_request', 'targetId is required for action=close')
      }
      const page = await this.session.getPageForTargetId({ cdpUrl, targetId, mode: 'direct-cdp' })
      await page.close()
      this.tabState.closeTab(targetId)
      return { ok: true, targetId }
    }

    if (action === 'console') {
      const targetId = asString(params.targetId)
      const expression = asString(params.expression)
      if (!targetId || !expression) {
        return createErrorResult('invalid_request', 'targetId and expression are required for action=console')
      }
      const result = await this.actions.evaluate({
        cdpUrl,
        targetId,
        mode: 'direct-cdp',
        fnBody: expression,
      })
      return { ok: true, targetId, result }
    }

    if (action === 'closeagenttabs' || action === 'close_agent_tabs') {
      const targetIds = this.tabState.nonRetainedIds
      let closed = 0
      for (const targetId of targetIds) {
        try {
          const page = await this.session.getPageForTargetId({ cdpUrl, targetId, mode: 'direct-cdp' })
          await page.close()
          this.tabState.closeTab(targetId)
          closed += 1
        } catch {
          // noop
        }
      }
      return { ok: true, closed, retained: this.tabState.retainedTabCount }
    }

    return createErrorResult('unsupported_action', `Unsupported direct CDP action: ${action}`)
  }

  private async handlePlaywrightAction(
    params: PlaywrightBrowserActionParams,
    connectionMode: BrowserConnectionMode,
  ): Promise<BrowserActionResult> {
    if (connectionMode === 'relay' && !this.options.relay.hasExtensionConnection) {
      await this.autoLauncher.ensureRelayBrowserAvailable()
    }

    const endpoint = connectionMode === 'direct-cdp'
      ? await this.resolveDirectEndpoint()
      : this.resolveRelayEndpoint()
    if (!endpoint) {
      return connectionMode === 'direct-cdp'
        ? createErrorResult(
          'direct_cdp_unavailable',
          'No direct CDP browser detected. Start Chrome with remote debugging enabled before using direct-cdp mode.',
          {
            recoverable: true,
          },
        )
        : createErrorResult(
          'browser_unavailable',
          'Browser extension not connected. Start the managed browser or connect an extension-backed browser first.',
          {
            recoverable: true,
            suggestedNextActions: ['start', 'open'],
          },
        )
    }

    const mode = connectionMode
    const cdpUrl = endpoint.preferredUrl
    const workspaceDir = asString(params.workspaceDir)
    if (mode === 'relay' && !asString(params.targetId)) {
      await this.options.relay.ensureExecutionWindowSelectionForBrowserUse()
    }
    const targetId = mode === 'relay'
      ? await this.resolveRelayExecutionTarget(asString(params.targetId))
      : this.resolveDirectExecutionTarget(asString(params.targetId))

    if (targetId) {
      this.tabState.touchTab(targetId)
    }

    const action = params.action

    if (action === 'navigate') {
      const url = requiredString(params.url, 'url')
      const result = await this.actions.navigate({
        cdpUrl,
        targetId,
        mode,
        url,
        timeoutMs: asNumber(params.timeoutMs),
        waitUntil: asString(params.waitUntil),
      })
      return { ok: true, action: 'navigate', targetId, requestedUrl: url, ...result }
    }

    if (action === 'snapshot') {
      const result = await this.actions.snapshot({
        cdpUrl,
        targetId,
        mode,
        selector: asString(params.selector),
        frameSelector: asString(params.frame),
        timeoutMs: asNumber(params.timeoutMs),
        options: {
          interactive: asBoolean(params.interactive),
          compact: asBoolean(params.compact) ?? asBoolean(params.efficient),
          maxDepth: asNumber(params.depth),
        },
      })
      return { ok: true, targetId, url: result.pageUrl, snapshot: result.snapshot, refs: result.refs, stats: result.stats }
    }

    if (action === 'screenshot') {
      const result = await this.actions.screenshot({
        cdpUrl,
        targetId,
        mode,
        ref: asString(params.ref),
        element: asString(params.element),
        fullPage: asBoolean(params.fullPage),
        type: asString(params.type) === 'jpeg' ? 'jpeg' : 'png',
        quality: asNumber(params.quality),
        timeoutMs: asNumber(params.timeoutMs),
        animations: asString(params.animations) === 'allow' ? 'allow' : 'disabled',
        caret: asString(params.caret) === 'initial' ? 'initial' : 'hide',
        scale: asString(params.scale) === 'device' ? 'device' : 'css',
        omitBackground: asBoolean(params.omitBackground),
      })
      const normalizedBuffer = await normalizeScreenshot(result.buffer)
      const savePath = resolvePathWithinWorkspace(asString(params.savePath), workspaceDir)
      if (savePath) {
        await fs.mkdir(path.dirname(savePath), { recursive: true })
        await fs.writeFile(savePath, normalizedBuffer)
      }
      return {
        ok: true,
        targetId,
        url: result.pageUrl,
        imageBase64: normalizedBuffer.toString('base64'),
        imageType: 'png',
        ...(savePath ? { savedTo: savePath } : {}),
      }
    }

    if (action === 'scroll') {
      return { ok: true, targetId, result: await this.actions.scroll({ cdpUrl, targetId, mode, direction: asString(params.scrollDirection), amount: asNumber(params.scrollAmount) }) }
    }

    if (action === 'errors') {
      return { ok: true, ...(await this.actions.pageErrors({ cdpUrl, targetId, mode, clear: asBoolean(params.clear) })) }
    }

    if (action === 'requests') {
      return { ok: true, ...(await this.actions.networkRequests({ cdpUrl, targetId, mode, filter: asString(params.filter), clear: asBoolean(params.clear) })) }
    }

    if (action === 'cookies') {
      const operation = asDataOperation(params.operation)
      if (!operation) {
        return createErrorResult('invalid_request', 'operation must be get, set, or clear for action=cookies')
      }
      return {
        ok: true,
        data: await this.handleCookiesAction({
          cdpUrl,
          targetId,
          mode,
          operation,
          cookies: asCookieArray(params.cookies),
        }),
      }
    }

    if (action === 'storage') {
      const storageType: BrowserStorageType = params.storageType === 'session' ? 'session' : 'local'
      const operation = asDataOperation(params.operation)
      if (!operation) {
        return createErrorResult('invalid_request', 'operation must be get, set, or clear for action=storage')
      }
      return {
        ok: true,
        data: await this.actions.storage({
          cdpUrl,
          targetId,
          mode,
          storageType,
          operation,
          key: asString(params.key),
          value: asString(params.value),
        }),
      }
    }

    if (action === 'highlight') {
      await this.actions.highlight({
        cdpUrl,
        targetId,
        mode,
        ref: requiredString(params.ref, 'ref'),
        durationMs: asNumber(params.durationMs),
      })
      return { ok: true, targetId }
    }

    if (action === 'upload') {
      const paths = asStringArray(params.paths)
      if (!paths?.length) {
        return createErrorResult('invalid_request', 'paths is required for action=upload')
      }
      const resolvedPaths = paths
        .map((entry) => resolvePathWithinWorkspace(entry, workspaceDir))
        .filter((entry): entry is string => Boolean(entry))
      if (!resolvedPaths.length) {
        return createErrorResult('invalid_request', 'No valid upload paths after validation')
      }
      await this.actions.setInputFiles({
        cdpUrl,
        targetId,
        mode,
        paths: resolvedPaths,
        inputRef: asString(params.inputRef),
        element: asString(params.element),
      })
      return { ok: true, targetId, paths: resolvedPaths }
    }

    if (action === 'dialog') {
      await this.actions.armDialog({
        cdpUrl,
        targetId,
        mode,
        accept: asBoolean(params.accept),
        promptText: asString(params.promptText),
      })
      return { ok: true, targetId, accept: asBoolean(params.accept) === true }
    }

    if (action === 'pdf') {
      const pdf = await this.actions.pdf({ cdpUrl, targetId, mode })
      const savePath = resolvePathWithinWorkspace(asString(params.savePath) ?? `browser-${sanitizeFileName(targetId ?? 'page')}.pdf`, workspaceDir)
      if (savePath) {
        await fs.mkdir(path.dirname(savePath), { recursive: true })
        await fs.writeFile(savePath, pdf.buffer)
      }
      return {
        ok: true,
        targetId,
        pdfBase64: pdf.buffer.toString('base64'),
        ...(savePath ? { savedTo: savePath } : {}),
      }
    }

    if (action === 'act') {
      return await this.handleActRequest(params, cdpUrl, targetId, mode)
    }

    return createErrorResult('unsupported_action', `Unsupported browser action: ${action}`)
  }

  private async handleActRequest(
    params: BrowserActAction,
    cdpUrl: string,
    defaultTargetId: string | undefined,
    mode: 'relay' | 'direct-cdp',
  ): Promise<BrowserActionResult> {
    const request = params.request
    if (!request) {
      return createErrorResult('invalid_request', 'request is required for action=act')
    }

    const payload = request
    const targetId = payload.targetId ?? defaultTargetId
    const timeoutMs = payload.timeoutMs ?? asNumber(params.timeoutMs)
    const inferredEvaluate = !payload.kind && (asString(payload.fn) || asString(payload.expression))

    if (inferredEvaluate) {
      return {
        ok: true,
        action: 'act.evaluate',
        targetId,
        result: await this.actions.evaluate({
          cdpUrl,
          targetId,
          mode,
          fnBody: requiredString(payload.fn ?? payload.expression, 'fn'),
          ref: payload.ref,
          timeoutMs,
        }),
      }
    }

    if (!payload.kind) {
      return createErrorResult('invalid_request', 'request.kind is required')
    }

    switch (payload.kind) {
      case 'click':
        await this.actions.click({
          cdpUrl,
          targetId,
          mode,
          ref: requiredString(payload.ref, 'ref'),
          timeoutMs,
          doubleClick: payload.doubleClick,
          button: asMouseButton(payload.button),
          modifiers: payload.modifiers,
        })
        return { ok: true, action: 'act.click', targetId }
      case 'type':
        await this.actions.type({ cdpUrl, targetId, mode, ref: requiredString(payload.ref, 'ref'), text: requiredString(payload.text, 'text'), submit: payload.submit, slowly: payload.slowly, clearFirst: payload.clearFirst, timeoutMs })
        return { ok: true, action: 'act.type', targetId }
      case 'press':
        await this.actions.press({ cdpUrl, targetId, mode, key: requiredString(payload.key, 'key'), delayMs: payload.delayMs })
        return { ok: true, action: 'act.press', targetId }
      case 'hover':
        await this.actions.hover({ cdpUrl, targetId, mode, ref: requiredString(payload.ref, 'ref'), timeoutMs })
        return { ok: true, action: 'act.hover', targetId }
      case 'scrollIntoView':
        await this.actions.scrollIntoView({ cdpUrl, targetId, mode, ref: requiredString(payload.ref, 'ref'), timeoutMs })
        return { ok: true, action: 'act.scrollIntoView', targetId }
      case 'drag':
        await this.actions.drag({ cdpUrl, targetId, mode, startRef: requiredString(payload.startRef, 'startRef'), endRef: requiredString(payload.endRef, 'endRef'), timeoutMs })
        return { ok: true, action: 'act.drag', targetId }
      case 'select':
        await this.actions.select({ cdpUrl, targetId, mode, ref: requiredString(payload.ref, 'ref'), values: payload.values ?? [], timeoutMs })
        return { ok: true, action: 'act.select', targetId }
      case 'fill':
        await this.actions.fill({
          cdpUrl,
          targetId,
          mode,
          fields: payload.fields ?? [],
          timeoutMs,
        })
        return { ok: true, action: 'act.fill', targetId }
      case 'resize':
        await this.actions.resize({ cdpUrl, targetId, mode, width: payload.width ?? 0, height: payload.height ?? 0 })
        return { ok: true, action: 'act.resize', targetId }
      case 'wait':
        await this.actions.waitFor({
          cdpUrl,
          targetId,
          mode,
          timeoutMs,
          timeMs: payload.timeMs,
          text: payload.text,
          textGone: payload.textGone,
          selector: payload.selector,
          url: payload.url,
          loadState: asWaitLoadState(payload.loadState),
          fnBody: payload.fn,
        })
        return { ok: true, action: 'act.wait', targetId }
      case 'evaluate':
        return {
          ok: true,
          action: 'act.evaluate',
          targetId,
          result: await this.actions.evaluate({
            cdpUrl,
            targetId,
            mode,
            fnBody: requiredString(payload.fn ?? payload.expression, 'fn'),
            ref: payload.ref,
            timeoutMs,
          }),
        }
      case 'close':
        await this.actions.closePage({ cdpUrl, targetId, mode })
        if (targetId) {
          this.tabState.closeTab(targetId)
        }
        return { ok: true, action: 'act.close', targetId }
      case 'scroll':
        return {
          ok: true,
          action: 'act.scroll',
          targetId,
          result: await this.actions.scroll({
            cdpUrl,
            targetId,
            mode,
            direction: payload.scrollDirection,
            amount: payload.scrollAmount,
          }),
        }
      default:
        return createErrorResult('unsupported_action', 'unsupported act kind')
    }
  }

  private resolveConnectionMode(params: BrowserActionParams): BrowserConnectionMode {
    return 'connectionMode' in params && params.connectionMode === 'direct-cdp' ? 'direct-cdp' : 'relay'
  }

  private resolveOpenUrl(params: Extract<BrowserActionParams, { action: 'open' }>): string {
    return asString(params.url) ?? 'about:blank'
  }

  private shouldAutoLaunchRelayAction(action: string): boolean {
    return action === 'start' || action === 'open'
  }

  private resolveRelayEndpoint(): ResolvedCdpEndpoint | null {
    const relayPort = this.options.relay.relayPort
    if (!this.options.relay.hasExtensionConnection || relayPort === null) {
      return null
    }
    return {
      httpUrl: `http://127.0.0.1:${relayPort}`,
      wsUrl: null,
      port: relayPort,
      preferredUrl: `http://127.0.0.1:${relayPort}`,
    }
  }

  private async resolveDirectEndpoint(): Promise<ResolvedCdpEndpoint | null> {
    const instances = await discoverChromeInstancesLight()
    const instance = instances[0]
    return instance
      ? resolveCdpEndpoint({ directCdpPort: instance.port, directCdpWsUrl: instance.wsUrl })
      : null
  }

  private async syncDirectTabs(cdpUrl: string, port: number): Promise<Array<{ targetId: string; url: string; title: string; type?: string }>> {
    const tabs = await this.tabState.withSyncLock(async () => {
      let list = await listDirectCdpTabs(port)
      if (list.length === 1 && list[0]?.targetId === M144_PLACEHOLDER_TARGET_ID) {
        try {
          const connection = await this.session.connectBrowser(cdpUrl, 'direct-cdp')
          const browser = connection.browser as PlaywrightBrowserLike
          const discoveredPages = browser
            .contexts()
            .flatMap((context) => context.pages())
          list = (await Promise.all(
            discoveredPages.map(async (currentPage) => ({
              targetId: await this.session.resolvePageTargetId(currentPage) ?? '',
              url: currentPage.url(),
              title: '',
              type: 'page',
            })),
          )).filter((entry: { targetId: string }) => entry.targetId)
        } catch {
          list = []
        }
      }

      const validTargetIds = new Set(list.map((entry) => entry.targetId).filter(Boolean))
      this.tabState.purgeStale(validTargetIds)
      return list
    })

    for (const idleTargetId of this.tabState.getIdleTabs(10 * 60 * 1000)) {
      try {
        const page = await this.session.getPageForTargetId({ cdpUrl, targetId: idleTargetId, mode: 'direct-cdp' })
        await page.close()
        this.tabState.closeTab(idleTargetId)
      } catch {
        // noop
      }
    }

    return tabs
  }

  private async handleCookiesAction(input: {
    cdpUrl: string
    targetId?: string
    mode: 'relay' | 'direct-cdp'
    operation: 'get' | 'set' | 'clear'
    cookies?: BrowserCookieInput[]
  }): Promise<unknown> {
    if (!input.targetId) {
      throw new Error('targetId is required')
    }

    if (input.mode === 'relay') {
      return await this.handleRelayCookiesAction(input.targetId, input.operation, input.cookies)
    }

    return await this.handleDirectCdpCookiesAction(input, input.targetId)
  }

  private async handleRelayCookiesAction(
    targetId: string,
    operation: 'get' | 'set' | 'clear',
    cookies?: BrowserCookieInput[],
  ): Promise<unknown> {
    if (operation === 'get') {
      return (await this.options.relay.getCookies(targetId))
        .map((cookie) => normalizeBrowserCookieRecord(cookie))
        .filter(Boolean)
    }

    if (operation === 'set') {
      if (!cookies?.length) {
        throw new Error('cookies are required for operation=set')
      }
      await this.options.relay.setCookies(targetId, cookies)
      return { ok: true }
    }

    await this.options.relay.clearCookies(targetId)
    return { ok: true }
  }

  private async handleDirectCdpCookiesAction(
    input: {
      cdpUrl: string
      mode: 'direct-cdp'
      operation: 'get' | 'set' | 'clear'
      cookies?: BrowserCookieInput[]
    },
    targetId: string,
  ): Promise<unknown> {
    const page = await this.session.getPageForTargetId({
      cdpUrl: input.cdpUrl,
      targetId,
      mode: input.mode,
    })
    const pageUrl = typeof page?.url === 'function' ? String(page.url()).trim() : ''
    const currentPageCookieUrl = this.resolveCookieCapableUrl(pageUrl)

    if (input.operation === 'get') {
      if (!currentPageCookieUrl) {
        return []
      }
      const result = await this.session.sendPageCdpCommand(
        { cdpUrl: input.cdpUrl, targetId, mode: input.mode },
        'Network.getCookies',
        { urls: [currentPageCookieUrl] },
      )
      const cookies = Array.isArray(result?.cookies) ? result.cookies : []
      return cookies.map((cookie) => normalizeBrowserCookieRecord(cookie)).filter(Boolean)
    }

    if (input.operation === 'set') {
      if (!input.cookies?.length) {
        throw new Error('cookies are required for operation=set')
      }

      const normalizedCookies = input.cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        url: cookie.url ?? currentPageCookieUrl ?? undefined,
        ...(cookie.domain ? { domain: cookie.domain } : {}),
        ...(cookie.path ? { path: cookie.path } : {}),
      }))
      if (normalizedCookies.some((cookie) => !cookie.url && !cookie.domain)) {
        throw new Error('A cookie url is required when the current page has no cookie-capable URL.')
      }

      await this.session.sendPageCdpCommand(
        { cdpUrl: input.cdpUrl, targetId, mode: input.mode },
        'Network.setCookies',
        { cookies: normalizedCookies },
      )
      return { ok: true }
    }

    if (!currentPageCookieUrl) {
      return { ok: true }
    }

    const existing = await this.session.sendPageCdpCommand(
      { cdpUrl: input.cdpUrl, targetId, mode: input.mode },
      'Network.getCookies',
      { urls: [currentPageCookieUrl] },
    )
    const cookies = Array.isArray(existing?.cookies) ? existing.cookies : []
    for (const cookie of cookies) {
      if (!cookie || typeof cookie !== 'object') continue
      const record = cookie as Record<string, unknown>
      const name = typeof record.name === 'string' ? record.name : ''
      if (!name) continue
      await this.session.sendPageCdpCommand(
        { cdpUrl: input.cdpUrl, targetId, mode: input.mode },
        'Network.deleteCookies',
        {
          name,
          ...(typeof record.domain === 'string' ? { domain: record.domain } : {}),
          ...(typeof record.path === 'string' ? { path: record.path } : {}),
        },
      )
    }
    return { ok: true }
  }

  private resolveCookieCapableUrl(url: string): string | null {
    try {
      const parsed = new URL(url)
      return parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? parsed.toString()
        : null
    } catch {
      return null
    }
  }

  private syncRelayCurrentTarget(): void {
    const current = this.options.relay.listAttachments().find((entry) => entry.selected && entry.primary)
    if (!current?.targetId) {
      this.tabState.clearCurrentTarget()
      return
    }
    this.tabState.setCurrentTarget(current.targetId)
  }

  private async resolveRelayExecutionTarget(explicitTargetId?: string): Promise<string> {
    const readyTarget = explicitTargetId
      ? await this.options.relay.resolveReadyTarget(explicitTargetId)
      : await this.resolveCurrentRelayReadyTarget()
    this.tabState.setCurrentTarget(readyTarget.targetId)
    return readyTarget.targetId
  }

  private async resolveCurrentRelayReadyTarget(): Promise<ReadyRelayTarget> {
    this.syncRelayCurrentTarget()
    const currentTargetId = this.tabState.currentTargetId
    if (!currentTargetId) {
      throw new Error('No current browser target available. Open or focus a page before using browser actions.')
    }
    return await this.options.relay.resolveReadyTarget(currentTargetId)
  }

  private resolveDirectExecutionTarget(explicitTargetId?: string): string {
    if (explicitTargetId) return explicitTargetId

    const currentTargetId = this.tabState.currentTargetId
    if (!currentTargetId) {
      throw new Error('No current browser target available. Open or focus a page before using browser actions.')
    }
    return currentTargetId
  }

  private classifyActionError(
    error: unknown,
    context: { action: string; connectionMode: BrowserConnectionMode },
  ): BrowserActionResult {
    const originalMessage = error instanceof Error ? error.message : String(error)
    const mappedMessage = this.session.mapActionError(error)
    const combinedMessage = `${originalMessage}\n${mappedMessage}`

    if (combinedMessage.includes('No current browser target available.')) {
      return createErrorResult('no_current_target', mappedMessage, {
        recoverable: true,
        suggestedNextActions: ['tabs', 'open', 'focus'],
      })
    }

    if (combinedMessage.includes('Unknown ref "')) {
      return createErrorResult('stale_snapshot_ref', mappedMessage, {
        recoverable: true,
        suggestedNextActions: ['snapshot'],
      })
    }

    if (combinedMessage.includes('Timed out waiting for target "') && combinedMessage.includes('" to become attached.')) {
      return createErrorResult('target_attach_timeout', mappedMessage, {
        recoverable: true,
        retryable: true,
        suggestedNextActions: ['open'],
      })
    }

    if (combinedMessage.includes('Target closed') || combinedMessage.includes('Target page, context or browser has been closed')) {
      return createErrorResult('target_closed', mappedMessage, {
        recoverable: true,
        suggestedNextActions: ['tabs', 'open', 'focus'],
      })
    }

    if (combinedMessage.includes('Browser has been closed') || combinedMessage.includes('Browser closed')) {
      return createErrorResult('browser_closed', mappedMessage, {
        recoverable: true,
        suggestedNextActions: ['start', 'open'],
      })
    }

    if (combinedMessage.includes('Execution context was destroyed')) {
      return createErrorResult('page_context_destroyed', mappedMessage, {
        recoverable: true,
        retryable: true,
      })
    }

    if (
      combinedMessage.includes('connectOverCDP') && combinedMessage.includes('Timeout')
      || combinedMessage.includes('CDP WebSocket connection timed out')
      || combinedMessage.includes('CDP WebSocket error')
      || combinedMessage.includes('HTTP endpoint is not reachable')
      || combinedMessage.includes('CDP endpoint is not reachable')
      || combinedMessage.includes('is not ready for browser control yet')
    ) {
      return createErrorResult('browser_not_ready', mappedMessage, {
        recoverable: true,
        retryable: true,
      })
    }

    if (combinedMessage.includes('Target browser instance is not connected.')) {
      return createErrorResult('browser_unavailable', mappedMessage, {
        recoverable: true,
        suggestedNextActions: ['tabs', 'open'],
      })
    }

    if (combinedMessage.includes('No usable Chrome profile with MatchaClaw Browser Relay enabled was found.')) {
      return createErrorResult('browser_auto_launch_unavailable', mappedMessage)
    }

    if (combinedMessage.includes('MatchaClaw Browser Relay did not reconnect.')) {
      return createErrorResult('browser_auto_launch_failed', mappedMessage, {
        recoverable: true,
        suggestedNextActions: ['start', 'open'],
      })
    }

    if (
      combinedMessage.includes('Browser extension not connected and no direct CDP browser detected.')
      || combinedMessage.includes('Chrome extension not connected')
      || (combinedMessage.includes('Browser extension not connected.') && context.connectionMode === 'relay')
      || (combinedMessage.includes('No CDP endpoint available') && context.connectionMode === 'relay')
    ) {
      return createErrorResult('browser_unavailable', mappedMessage, {
        recoverable: true,
        suggestedNextActions: ['start', 'open'],
      })
    }

    if (
      combinedMessage.includes('No direct CDP browser detected.')
      || (combinedMessage.includes('No CDP endpoint available') && context.connectionMode === 'direct-cdp')
      || combinedMessage.includes('Direct CDP auto-connect already attempted.')
    ) {
      return createErrorResult('direct_cdp_unavailable', mappedMessage, {
        recoverable: true,
      })
    }

    if (originalMessage.endsWith(' is required') || originalMessage.includes(' are required')) {
      return createErrorResult('invalid_request', mappedMessage)
    }

    return createErrorResult('protocol_error', mappedMessage)
  }
}

function requiredString(value: unknown, field: string): string {
  const normalized = asString(value)
  if (!normalized) {
    throw new Error(`${field} is required`)
  }
  return normalized
}
