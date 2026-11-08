import type { PluginLogger } from '../plugin-types.js'
import path from 'node:path'
import fs from 'node:fs/promises'
import {
  type BrowserActionParams,
  type BrowserActionInvocation,
  type BrowserSessionCleanup,
  type BrowserUtilityAction,
  type BrowserActAction,
  type BrowserConnectionMode,
  type BrowserCookieInput,
  browserDataOperations,
  browserUtilityKinds,
  preserveBrowserActionReceipt,
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
import { browserPrincipalId, canAccessPage, canClosePage, claimPage, releasePage } from '../state/page-ownership.js'
import { PlaywrightSession, type PlaywrightInvocation } from '../playwright/session.js'
import { readRelayError } from '../relay/errors.js'
import { PlaywrightActions } from '../playwright/actions.js'
import { NativePageUpdatedError } from '../playwright/native-snapshot.js'
import { InstalledProfileAutoLauncher } from '../browser-launch/installed-profile-auto-launcher.js'
import { resolveLocalDownloadDirectory } from '../browser-launch/local-downloads.js'
import { prepareWorkspaceDownload, resolvePathWithinWorkspace, saveWorkspaceDownload, writeWorkspaceFile } from './workspace-files.js'
import { relayDebugWarn } from '../debug-logging.js'

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
      | 'utility'
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
  'utility',
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
    const cookieValue = typeof record.value === 'string' ? record.value : undefined
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

async function normalizeScreenshot(buffer: Buffer, imageType: 'png' | 'jpeg'): Promise<{ buffer: Buffer; imageType: 'png' | 'jpeg' }> {
  const MAX_BYTES = 5 * 1024 * 1024
  const MAX_SIDE = 2_000
  if (buffer.byteLength <= MAX_BYTES) return { buffer, imageType }

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
    return { buffer: output, imageType: 'png' }
  } catch {
    return { buffer, imageType }
  }
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
    const errors: unknown[] = []
    try { this.autoLauncher.stop() } catch (error) { errors.push(error) }
    try { await this.session.closeConnections() } catch (error) { errors.push(error) }
    try { await this.options.relay.releaseServiceResources() } catch (error) { errors.push(error) }
    this.session.clearCachedState()
    this.tabState.reset()
    if (errors.length) {
      throw new AggregateError(errors, `Browser control cleanup failed: ${errors.map((error) => error instanceof Error ? error.message : String(error)).join('; ')}`)
    }
  }

  async cleanupSession(cleanup: BrowserSessionCleanup): Promise<void> {
    const { context, scope } = cleanup
    const principalId = browserPrincipalId(context)
    const sessionGroupId = context.sessionGroupId ?? principalId
    await this.session.drainSession(cleanup)
    await this.session.cleanupSessionUtilities(cleanup)
    const relayTabs = this.options.relay.listTabs().filter((tab) => scope === 'group'
      ? tab.sessionGroupId === sessionGroupId
      : tab.claimedBy === principalId || !tab.claimedBy && tab.createdBy === principalId)
    const directTabs = this.tabState.allTargetIds.flatMap((targetId) => {
      const tab = this.tabState.getTab(targetId)!
      return (scope === 'group' ? tab.sessionGroupId === sessionGroupId : tab.claimedBy === principalId || !tab.claimedBy && tab.createdBy === principalId) ? [tab] : []
    })
    const errors: unknown[] = []
    let relayReleased = false
    try {
      await this.options.relay.releaseSessionClaims(principalId, sessionGroupId, scope)
      relayReleased = true
    } catch (error) { errors.push(error) }
    for (const tab of directTabs) {
      if (tab.claimedBy && (scope === 'group' || tab.claimedBy === principalId)) {
        this.tabState.registerTab(tab.targetId, releasePage(tab, tab.claimedBy))
      }
      this.session.clearCachedState(tab.targetId)
    }
    for (const tab of [...relayTabs, ...this.options.relay.listTabs().filter((tab) => scope === 'group'
      ? tab.sessionGroupId === sessionGroupId
      : tab.claimedBy === principalId || !tab.claimedBy && tab.createdBy === principalId)]) {
      this.session.clearCachedState(tab.targetId || tab.targetKey)
    }
    if (scope === 'group') {
      const targetIds = this.options.relay.listTabs()
        .filter((tab) => tab.sessionGroupId === sessionGroupId && tab.createdBy && !tab.isRetained)
        .map((tab) => tab.targetKey)
      if (relayReleased) try {
        const receipt = await this.options.relay.closeAgentTabs(targetIds, principalId, sessionGroupId)
        for (const targetId of [...receipt.closedIds, ...receipt.alreadyClosedIds]) this.session.clearCachedState(targetId)
        if (!receipt.success) throw new Error(`Browser session group cleanup failed: ${JSON.stringify(receipt)}`)
      } catch (error) { errors.push(error) }
      const toClose = directTabs.filter((tab) => tab.createdBy && !tab.retained)
      if (toClose.length) {
        const cdpUrl = this.session.getConnection('direct-cdp')?.cdpUrl
        if (!cdpUrl) errors.push(new Error('Direct CDP session cleanup could not be confirmed: original browser disconnected.'))
        else for (const tab of toClose) {
          try {
            await this.actions.closePage({ cdpUrl, targetId: tab.targetId, mode: 'direct-cdp' })
            this.tabState.closeTab(tab.targetId)
          } catch (error) { errors.push(error) }
        }
      }
      if (!errors.length) this.options.relay.completeSessionGroupCleanup(sessionGroupId)
    }
    if (errors.length) throw new AggregateError(errors, 'Browser session cleanup could not be confirmed')
  }

  async handleRequest(params: BrowserActionParams, invocation: BrowserActionInvocation = {}): Promise<BrowserActionResult> {
    const action = asString((params as { action?: unknown } | null | undefined)?.action)?.toLowerCase()
    if (!action) {
      return createErrorResult('invalid_request', 'action is required')
    }

    try {
      this.session.assertInvocationCurrent(invocation)
      if (action === 'utility' && params.action === 'utility' && params.request?.kind === 'download') {
        const result = await this.handleDownloadRequest(params, invocation)
        return result.downloadState === 'completed' ? preserveBrowserActionReceipt(result) : result
      }
      if (action === 'stop') {
        return await this.stopSession(invocation)
      }

      if (this.isRelayDirectActionName(action)) {
        return await this.handleRelayOrDirectAction(params as RelayDirectBrowserActionParams, invocation)
      }
      if (this.isPlaywrightActionName(action)) {
        return await this.handlePlaywrightAction(
          params as PlaywrightBrowserActionParams,
          this.resolveConnectionMode(params),
          invocation,
        )
      }
      return createErrorResult('unsupported_action', `Unsupported browser action: ${action}`)
    } catch (error) {
      const receipt = asRecord(error)
      return {
        ...this.classifyActionError(error, { action, connectionMode: this.resolveConnectionMode(params) }),
        ...(receipt?.actionPerformed === true ? { actionPerformed: true } : {}),
        ...(receipt?.observationComplete === false ? { observationComplete: false } : {}),
        ...(receipt?.partial ? { partial: receipt.partial } : {}),
      }
    }
  }

  getStatus(): BrowserActionResult {
    this.syncRelayCurrentTarget()
    const relayTabs = this.options.relay.listTabs()
    return {
      running: true,
      relayPort: this.options.relay.relayPort,
      extensionConnected: this.options.relay.hasExtensionConnection,
      attachedTabs: this.options.relay.listAttachments().length,
      trackedTabs: relayTabs.filter((entry) => entry.isAgent).length + this.tabState.agentTabCount,
      retainedTabs: relayTabs.filter((entry) => entry.isRetained).length + this.tabState.retainedTabCount,
      playwrightConnected: this.session.isPlaywrightConnected(),
    }
  }

  private isRelayDirectActionName(action: string): action is RelayDirectAction {
    return relayDirectActions.includes(action as RelayDirectAction)
  }

  private isPlaywrightActionName(action: string): action is PlaywrightBrowserActionName {
    return playwrightActionNames.includes(action as PlaywrightBrowserActionName)
  }

  private async handleRelayOrDirectAction(params: RelayDirectBrowserActionParams, invocation: BrowserActionInvocation): Promise<BrowserActionResult> {
    const action = params.action
    let autoLaunchError: Error | null = null
    if (this.resolveConnectionMode(params) === 'relay' && !this.options.relay.hasExtensionConnection && this.shouldAutoLaunchRelayAction(action)) {
      try {
        await this.autoLauncher.ensureRelayBrowserAvailable()
      } catch (error) {
        autoLaunchError = error instanceof Error ? error : new Error(String(error))
      }
    }

    this.session.assertInvocationCurrent(invocation)
    if (this.resolveConnectionMode(params) === 'relay' && this.options.relay.hasExtensionConnection) {
      const targetId = 'targetId' in params ? asString(params.targetId) : undefined
      return targetId && action === 'console'
        ? await this.options.relay.withTargetClaim(targetId, this.resolvePrincipalId(invocation), () => this.handleRelayAction(params, invocation), this.resolveSessionGroupId(invocation))
        : await this.handleRelayAction(params, invocation)
    }

    const directEndpoint = this.resolveConnectionMode(params) === 'direct-cdp'
      ? await this.resolveDirectEndpoint()
      : null
    this.session.assertInvocationCurrent(invocation)
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
        this.resolveConnectionMode(params) === 'direct-cdp' ? 'direct_cdp_unavailable' : 'browser_unavailable',
        this.resolveConnectionMode(params) === 'direct-cdp'
          ? 'No direct CDP browser detected.'
          : 'Browser extension not connected.',
        {
          recoverable: true,
          suggestedNextActions: ['start', 'open'],
        },
      )
    }

    return await this.handleDirectCdpAction(params, directEndpoint, invocation)
  }

  private async handleRelayAction(params: RelayDirectBrowserActionParams, invocation: PlaywrightInvocation): Promise<BrowserActionResult> {
    this.session.assertInvocationCurrent(invocation)
    this.syncRelayCurrentTarget()
    const attachments = this.options.relay.listAttachments()
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
      const tabs = this.options.relay.listTabs(this.resolvePrincipalId(invocation), this.resolveSessionGroupId(invocation))
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
          isAgent: entry.isAgent,
          isRetained: entry.isRetained,
        })),
      }
    }

    if (action === 'open') {
      const requestedUrl = this.resolveOpenUrl(params)
      const principalId = this.resolvePrincipalId(invocation)
      await this.options.relay.ensureExecutionWindowSelectionForBrowserUse(principalId, this.resolveSessionGroupId(invocation))
      this.session.assertInvocationCurrent(invocation)
      const created = await this.options.relay.openTarget(requestedUrl, {
        principalId,
        sessionGroupId: this.resolveSessionGroupId(invocation),
        ...(asBoolean(params.retain) !== undefined ? { retain: params.retain } : {}),
      })
      relayDebugWarn(
        this.options.logger,
        () => `[browser-relay] open action created target requestedUrl="${requestedUrl}" targetId=${created.targetId}`,
      )
      this.session.assertInvocationCurrent(invocation)
      const attachedTarget = await this.options.relay.resolveReadyTarget(String(created.targetId))
      this.session.assertInvocationCurrent(invocation)
      relayDebugWarn(
        this.options.logger,
        () => `[browser-relay] open action attached target requestedUrl="${requestedUrl}" targetId=${attachedTarget.targetId} sessionId=${attachedTarget.sessionId} windowId=${attachedTarget.windowId ?? 'null'} tabId=${attachedTarget.tabId ?? 'null'} url="${attachedTarget.url}" readyState="${attachedTarget.readyState}" mainFrameUrl="${attachedTarget.mainFrameUrl}"`,
      )
      const targetId = attachedTarget.targetId
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
      const principalId = this.resolvePrincipalId(invocation)
      await this.options.relay.withTargetClaim(targetId, principalId, async () => {
        this.session.assertInvocationCurrent(invocation)
        await this.options.relay.focusTarget(targetId)
        this.session.assertInvocationCurrent(invocation)
      }, this.resolveSessionGroupId(invocation))
      this.tabState.setCurrentTarget(targetId)
      this.tabState.touchTab(targetId)
      return { ok: true, targetId }
    }

    if (action === 'close') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return createErrorResult('invalid_request', 'targetId is required for action=close')
      }
      return await this.closeControlledTarget(targetId, 'relay', invocation)
    }

    if (action === 'console') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return createErrorResult('invalid_request', 'targetId is required for action=console')
      }
      const endpoint = this.resolveRelayEndpoint()
      if (!endpoint) return createErrorResult('browser_unavailable', 'Browser extension not connected.')
      return await this.handleConsoleAction(params, endpoint.preferredUrl, targetId, 'relay', invocation)
    }

    if (!closeAgentTabsActions.includes(action)) {
      return createErrorResult('unsupported_action', `Unsupported relay action: ${action}`)
    }

    return await this.closeSessionRelayTabs(this.resolvePrincipalId(invocation), invocation)
  }

  private async handleDirectCdpAction(
    params: RelayDirectBrowserActionParams,
    endpoint: ResolvedCdpEndpoint,
    invocation: PlaywrightInvocation,
  ): Promise<BrowserActionResult> {
    this.session.assertInvocationCurrent(invocation)
    const action = params.action
    const cdpUrl = endpoint.preferredUrl

    if (action === 'start' || action === 'status' || action === 'profiles') {
      const version = await getDirectCdpVersion(endpoint.port)
      const tabs = await this.syncDirectTabs(cdpUrl, endpoint.port, invocation)
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
      const principalId = this.resolvePrincipalId(invocation)
      const tabs = await this.syncDirectTabs(cdpUrl, endpoint.port, invocation)
      return {
        ok: true,
        tabs: tabs.filter((tab) => canAccessPage(this.tabState.getTab(tab.targetId) ?? { createdBy: null, claimedBy: null, sessionGroupId: null, retained: false }, principalId, this.resolveSessionGroupId(invocation))).map((tab) => ({
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
      const principalId = this.resolvePrincipalId(invocation)
      const result = await this.session.sendBrowserCdpCommand(cdpUrl, 'Target.createTarget', {
        url: requestedUrl,
      }, 'direct-cdp', invocation, (created) => {
        const targetId = String(created?.targetId ?? '').trim()
        if (targetId) this.tabState.registerTab(targetId, {
          retained: asBoolean(params.retain) === true,
          createdBy: principalId,
          claimedBy: principalId,
          sessionGroupId: this.resolveSessionGroupId(invocation),
        })
      })
      const targetId = String(result?.targetId ?? '').trim()
      if (!targetId) {
        return createErrorResult('protocol_error', 'Target.createTarget returned no targetId', {
          recoverable: true,
          retryable: true,
          suggestedNextActions: ['open'],
        })
      }
      this.session.assertInvocationCurrent(invocation)
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
      this.claimDirectTarget(targetId, invocation)
      const page = await this.session.getPageForTargetId({ ...invocation, cdpUrl, targetId, mode: 'direct-cdp' })
      this.session.assertInvocationCurrent(invocation)
      await this.session.runInvocation(invocation, () => page.bringToFront())
      this.tabState.setCurrentTarget(targetId)
      this.tabState.touchTab(targetId)
      return { ok: true, targetId }
    }

    if (action === 'close') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return createErrorResult('invalid_request', 'targetId is required for action=close')
      }
      return await this.closeControlledTarget(targetId, 'direct-cdp', invocation, cdpUrl)
    }

    if (action === 'console') {
      const targetId = asString(params.targetId)
      if (!targetId) return createErrorResult('invalid_request', 'targetId is required for action=console')
      this.claimDirectTarget(targetId, invocation)
      return await this.handleConsoleAction(params, cdpUrl, targetId, 'direct-cdp', invocation)
    }

    if (action === 'closeagenttabs' || action === 'close_agent_tabs') {
      return await this.closeSessionDirectTabs(cdpUrl, invocation)
    }

    return createErrorResult('unsupported_action', `Unsupported direct CDP action: ${action}`)
  }

  private async handleConsoleAction(
    params: Extract<BrowserActionParams, { action: 'console' }>,
    cdpUrl: string,
    targetId: string,
    mode: BrowserConnectionMode,
    invocation: PlaywrightInvocation,
  ): Promise<BrowserActionResult> {
    invocation = this.session.withInvocationDeadline(invocation, params.timeoutMs ?? 30_000)
    return await this.session.withPageOperation({ ...invocation, cdpUrl, targetId, mode }, () => this.executeConsoleAction(params, cdpUrl, targetId, mode, invocation))
  }

  private async executeConsoleAction(
    params: Extract<BrowserActionParams, { action: 'console' }>,
    cdpUrl: string,
    targetId: string,
    mode: BrowserConnectionMode,
    invocation: PlaywrightInvocation,
  ): Promise<BrowserActionResult> {
    if (typeof params.expression !== 'string' && typeof params.scriptPath !== 'string') {
      return { ok: true, ...await this.actions.consoleMessages({ ...invocation, cdpUrl, targetId, mode, level: params.level }) }
    }
    const workspaceDir = asString(params.workspaceDir)
    let expression = params.expression
    if (!expression && typeof params.scriptPath === 'string') {
      const scriptPath = resolvePathWithinWorkspace(params.scriptPath, workspaceDir)
      if (!scriptPath) return createErrorResult('invalid_request', 'scriptPath must be a valid path under the workspace')
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const realPath = await fs.realpath(scriptPath)
          const realWorkspace = workspaceDir ? await fs.realpath(workspaceDir) : undefined
          if (!resolvePathWithinWorkspace(realPath, realWorkspace)) return createErrorResult('invalid_request', 'scriptPath must resolve under the workspace')
          expression = await fs.readFile(realPath, 'utf8')
          break
        } catch (error) {
          if (attempt || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          await this.session.runInvocation(invocation, () => new Promise((resolve) => setTimeout(resolve, 300)))
        }
      }
      this.session.assertInvocationCurrent(invocation)
    }
    if (!expression?.trim()) return createErrorResult('invalid_request', 'expression or scriptPath resolved to empty script')
    const result = await this.session.withFrameCdpSession({ ...invocation, cdpUrl, targetId, mode }, asString(params.frameId), async ({ send, contextId }) => await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, ...(contextId !== undefined ? { contextId } : {}),
    }))
    if (result.exceptionDetails || result.result?.subtype === 'error') {
      return createErrorResult('protocol_error', String(result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? result.result?.description ?? 'Console expression failed'), { retryable: false })
    }
    const value = result.result?.value
    const record = asRecord(value)
    const payload = record && '__result' in record ? record.__result : value
    const debug = Array.isArray(record?.__debug) ? record.__debug.map(String) : []
    let save: Record<string, unknown> | undefined
    if (params.savePath) {
      const savePath = resolvePathWithinWorkspace(params.savePath, workspaceDir)
      if (!savePath) save = { status: 'skipped', reason: 'Path outside workspace or invalid.' }
      else if (payload == null) save = { status: 'skipped', reason: 'No return value.' }
      else {
        try {
          await writeWorkspaceFile(savePath, JSON.stringify(payload, null, 2), workspaceDir, () => this.session.assertInvocationCurrent(invocation))
          save = { status: 'written', path: savePath }
        } catch (error) {
          this.session.assertInvocationCurrent(invocation)
          save = { status: 'failed', reason: error instanceof Error ? error.message : String(error) }
        }
      }
    }
    return { ok: true, targetId, result: payload, ...(debug.length ? { debug } : {}), ...(save ? { save } : {}) }
  }

  private async handlePlaywrightAction(
    params: PlaywrightBrowserActionParams,
    connectionMode: BrowserConnectionMode,
    invocation: PlaywrightInvocation,
  ): Promise<BrowserActionResult> {
    invocation = this.session.withInvocationDeadline(invocation, params.action === 'navigate' ? 120_000 : (params.action === 'act' || params.action === 'utility' ? asNumber(params.request?.timeoutMs) : undefined) ?? asNumber(params.timeoutMs) ?? (params.action === 'utility' && ['goBack', 'goForward', 'reload'].includes(params.request?.kind ?? '') ? 10_000 : 120_000))
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
    const requestedTargetId = params.action === 'act' || params.action === 'utility'
      ? asString(params.request?.targetId) ?? asString(params.targetId)
      : asString(params.targetId)
    const principalId = this.resolvePrincipalId(invocation)
    this.session.assertInvocationCurrent(invocation)
    if (mode === 'relay' && !requestedTargetId) {
      await this.options.relay.ensureExecutionWindowSelectionForBrowserUse(principalId, this.resolveSessionGroupId(invocation))
      this.session.assertInvocationCurrent(invocation)
    }
    const targetId = mode === 'relay'
      ? await this.resolveRelayExecutionTarget(requestedTargetId)
      : this.resolveDirectExecutionTarget(requestedTargetId)

    this.session.assertInvocationCurrent(invocation)
    this.tabState.touchTab(targetId)
    if (params.action === 'act' && params.request?.kind === 'close') return await this.executePlaywrightAction(params, cdpUrl, targetId, mode, invocation, workspaceDir)
    const execute = () => this.session.withPageOperation({ ...invocation, cdpUrl, targetId, mode }, () => this.executePlaywrightAction(params, cdpUrl, targetId, mode, invocation, workspaceDir))
    if (mode === 'relay') {
      return await this.options.relay.withTargetClaim(targetId, principalId, execute, this.resolveSessionGroupId(invocation))
    }
    this.claimDirectTarget(targetId, invocation)
    return await execute()
  }

  private async executePlaywrightAction(
    params: PlaywrightBrowserActionParams,
    cdpUrl: string,
    targetId: string,
    mode: BrowserConnectionMode,
    invocation: PlaywrightInvocation,
    workspaceDir?: string,
  ): Promise<BrowserActionResult> {
    this.session.assertInvocationCurrent(invocation)
    const action = params.action

    if (params.action === 'utility' && params.request?.kind !== 'pdf') {
      const request = params.request
      if (!request || !browserUtilityKinds.includes(request.kind)) return createErrorResult('invalid_request', 'A supported utility request.kind is required')
      switch (request.kind) {
        case 'highlight': case 'upload': case 'dialog': case 'errors': case 'cookies':
          return await this.executePlaywrightAction({ ...params, ...request, action: request.kind } as PlaywrightBrowserActionParams, cdpUrl, targetId, mode, invocation, workspaceDir)
        case 'har': {
          const workspace = invocation.context?.workspaceDir
          const savePath = workspace && resolvePathWithinWorkspace(request.savePath, workspace)
          if (!savePath) return createErrorResult('invalid_request', 'HAR savePath is required and must be under the trusted workspace')
          const result = await this.session.executeUtility({ ...invocation, cdpUrl, targetId, mode }, request)
          if (typeof result.content !== 'string') throw new Error('HAR capture did not return file content')
          await this.session.runInvocation(invocation, () => writeWorkspaceFile(savePath, result.content as string, workspace, () => this.session.assertInvocationCurrent(invocation)))
          if (request.clear === true) await this.session.clearNetwork({ ...invocation, cdpUrl, targetId, mode })
          return { ok: true, targetId, entries: result.entries, savePath, bytes: result.content.length }
        }
        case 'som': {
          const result = await this.session.executeUtility({ ...invocation, cdpUrl, targetId, mode }, request, async () => {
            const viewport = await this.session.sendPageCdpCommand({ ...invocation, cdpUrl, targetId, mode }, 'Runtime.evaluate', { expression: '({x:scrollX,y:scrollY,width:document.documentElement.clientWidth,height:document.documentElement.clientHeight})', returnByValue: true })
            const clip = viewport?.result?.value
            const image = await this.session.sendPageCdpCommand({ ...invocation, cdpUrl, targetId, mode }, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { ...clip, scale: 1 } })
            const normalized = await normalizeScreenshot(Buffer.from(image.data, 'base64'), 'png')
            this.session.assertInvocationCurrent(invocation)
            return normalized.buffer.toString('base64')
          })
          return { ok: true, targetId, ...result }
        }
        default:
          return { ok: true, targetId, ...await this.session.executeUtility({ ...invocation, cdpUrl, targetId, mode }, request) }
      }
    }

    if (action === 'navigate') {
      const url = requiredString(params.url, 'url')
      const result = await this.actions.navigate({
        ...invocation,
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
        ...invocation,
        cdpUrl,
        targetId,
        mode,
        selector: asString(params.selector),
        frameSelector: asString(params.frame),
        limit: asNumber(params.limit),
        maxChars: asNumber(params.maxChars),
        timeoutMs: asNumber(params.timeoutMs),
        options: {
          interactive: asBoolean(params.interactive),
          compact: asBoolean(params.compact) ?? asBoolean(params.efficient),
          maxDepth: asNumber(params.depth),
        },
        scope: params.scope,
        filter: params.filter,
      })
      return {
        ok: true,
        targetId,
        url: result.pageUrl,
        snapshot: result.snapshot,
        refs: result.refs,
        stats: result.stats,
        ...(result.totalCount !== undefined ? { totalCount: result.totalCount } : {}),
        ...(result.matchedCount !== undefined ? { matchedCount: result.matchedCount } : {}),
        ...(result.returnedCount !== undefined ? { returnedCount: result.returnedCount } : {}),
        ...(result.truncated ? { truncated: true } : {}),
        ...(result.sparse ? { sparse: true } : {}),
        ...(result.refRange ? { refRange: result.refRange } : {}),
        degraded: result.degraded,
        source: result.source,
        ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
        ...(result.frames ? { frames: result.frames } : {}),
        ...(result.actionKey ? { actionKey: result.actionKey } : {}),
      }
    }

    if (action === 'screenshot') {
      const savePath = resolvePathWithinWorkspace(asString(params.savePath), workspaceDir)
      if (params.savePath !== undefined && !savePath) {
        return createErrorResult('invalid_request', 'savePath must be a valid path under the workspace')
      }
      const imageType = params.type === 'jpeg' ? 'jpeg' : 'png'
      const result = await this.actions.screenshot({
        ...invocation,
        cdpUrl,
        targetId,
        mode,
        ref: asString(params.ref),
        element: asString(params.element),
        fullPage: asBoolean(params.fullPage),
        type: imageType,
        quality: asNumber(params.quality),
        timeoutMs: asNumber(params.timeoutMs),
        animations: asString(params.animations) === 'allow' ? 'allow' : 'disabled',
        caret: asString(params.caret) === 'initial' ? 'initial' : 'hide',
        scale: asString(params.scale) === 'device' ? 'device' : 'css',
        omitBackground: asBoolean(params.omitBackground),
      })
      const normalized = await normalizeScreenshot(result.buffer, imageType)
      if (savePath) {
        this.session.assertInvocationCurrent(invocation)
        await fs.mkdir(path.dirname(savePath), { recursive: true })
        this.session.assertInvocationCurrent(invocation)
        await fs.writeFile(savePath, normalized.buffer)
      }
      return {
        ok: true,
        targetId,
        url: result.pageUrl,
        imageBase64: normalized.buffer.toString('base64'),
        imageType: normalized.imageType,
        ...(savePath ? { savedTo: savePath } : {}),
      }
    }

    if (action === 'scroll') {
      return { ok: true, targetId, result: await this.actions.scroll({ ...invocation, cdpUrl, targetId, mode, direction: asString(params.scrollDirection), amount: asNumber(params.scrollAmount) }) }
    }

    if (action === 'errors') {
      return { ok: true, ...(await this.actions.pageErrors({ ...invocation, cdpUrl, targetId, mode, clear: asBoolean(params.clear) })) }
    }

    if (action === 'requests') {
      return { ok: true, ...(await this.actions.networkRequests({ ...invocation, cdpUrl, targetId, mode, filter: asString(params.filter), clear: asBoolean(params.clear) })) }
    }

    if (action === 'cookies') {
      const operation = asDataOperation(params.operation)
      if (!operation) {
        return createErrorResult('invalid_request', 'operation must be get, set, or clear for action=cookies')
      }
      return {
        ok: true,
        data: await this.handleCookiesAction({
          ...invocation,
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
          ...invocation,
          cdpUrl,
          targetId,
          mode,
          storageType,
          operation,
          key: typeof params.key === 'string' ? params.key : undefined,
          value: typeof params.value === 'string' ? params.value : typeof params.value === 'number' || typeof params.value === 'boolean' ? String(params.value) : undefined,
        }),
      }
    }

    if (action === 'highlight') {
      await this.actions.highlight({
        ...invocation,
        cdpUrl,
        targetId,
        mode,
        ref: asString(params.ref),
        backendNodeId: params.backendNodeId,
        frameId: params.frameId,
        durationMs: asNumber(params.durationMs),
      })
      return { ok: true, targetId }
    }

    if (action === 'upload') {
      const ref = asString(params.ref)
      const inputRef = asString(params.inputRef)
      const element = asString(params.element)
      if (!ref && !inputRef && !element && params.backendNodeId === undefined) return createErrorResult('invalid_request', 'ref, inputRef or element is required for action=upload')
      const paths = asStringArray(params.paths)
      if (!paths?.length) {
        return createErrorResult('invalid_request', 'paths is required for action=upload')
      }
      const resolvedPaths: string[] = []
      for (const entry of paths) {
        const resolved = resolvePathWithinWorkspace(entry, workspaceDir)
        if (!resolved) return createErrorResult('invalid_request', 'Every upload path must be under the workspace')
        const realPath = await fs.realpath(resolved)
        if (!resolvePathWithinWorkspace(realPath, workspaceDir)) return createErrorResult('invalid_request', 'Every upload path must resolve under the workspace')
        resolvedPaths.push(realPath)
      }
      if (ref && !inputRef && !element && params.backendNodeId === undefined) {
        const upload = this.session.withInvocationDeadline({ ...invocation, cdpUrl, targetId, mode, timeoutMs: params.timeoutMs }, 10_000)
        const chooser = await this.actions.armFileChooser({ ...upload, paths: resolvedPaths })
        await this.actions.click({ ...upload, ref })
        await chooser.waitAndSetFiles()
      } else {
        await this.actions.setInputFiles({ ...invocation, cdpUrl, targetId, mode, paths: resolvedPaths, inputRef, element, backendNodeId: params.backendNodeId, frameId: params.frameId })
      }
      return { ok: true, targetId, paths: resolvedPaths }
    }

    if (action === 'dialog') {
      await this.actions.armDialog({
        ...invocation,
        cdpUrl,
        targetId,
        mode,
        accept: asBoolean(params.accept),
        promptText: typeof params.promptText === 'string' ? params.promptText : undefined,
      })
      return { ok: true, targetId, accept: asBoolean(params.accept) === true }
    }

    if (params.action === 'pdf' || params.action === 'utility' && params.request?.kind === 'pdf') {
      const utility = params.action === 'utility' && params.request?.kind === 'pdf' ? params.request : undefined
      const workspace = utility ? invocation.context?.workspaceDir : workspaceDir
      const requestedPath = asString(utility?.savePath ?? (params.action === 'pdf' ? params.savePath : undefined)) ?? (utility ? undefined : `browser-${sanitizeFileName(targetId ?? 'page')}.pdf`)
      const savePath = utility && !workspace ? null : resolvePathWithinWorkspace(requestedPath, workspace)
      if (requestedPath && !savePath) return createErrorResult('invalid_request', 'savePath must be a valid path under the workspace')
      const pdf = await this.actions.pdf({ ...invocation, cdpUrl, targetId, mode, ...(utility ? { landscape: utility.landscape, printBackground: utility.printBackground === true, paper: utility.paper, scale: utility.scale } : {}) })
      if (savePath) {
        if (utility) await this.session.runInvocation(invocation, () => writeWorkspaceFile(savePath, pdf.buffer, workspace, () => this.session.assertInvocationCurrent(invocation)))
        else {
          this.session.assertInvocationCurrent(invocation)
          await fs.mkdir(path.dirname(savePath), { recursive: true })
          this.session.assertInvocationCurrent(invocation)
          await fs.writeFile(savePath, pdf.buffer)
        }
      }
      return {
        ok: true,
        targetId,
        pdfBase64: pdf.buffer.toString('base64'),
        ...(savePath ? { savedTo: savePath } : {}),
      }
    }

    if (action === 'act') {
      return await this.handleActRequest(params, cdpUrl, targetId, mode, invocation)
    }

    return createErrorResult('unsupported_action', `Unsupported browser action: ${action}`)
  }

  private resolvePrincipalId(invocation: BrowserActionInvocation): string {
    if (!invocation.context) throw new Error('Trusted browser invocation context is required')
    return browserPrincipalId(invocation.context)
  }

  private resolveSessionGroupId(invocation: BrowserActionInvocation): string {
    return invocation.context?.sessionGroupId ?? this.resolvePrincipalId(invocation)
  }

  private claimDirectTarget(targetId: string, invocation: PlaywrightInvocation): void {
    this.session.assertInvocationCurrent(invocation)
    const ownership = this.tabState.getTab(targetId) ?? { createdBy: null, claimedBy: null, sessionGroupId: null, retained: false }
    this.tabState.registerTab(targetId, claimPage(ownership, this.resolvePrincipalId(invocation), this.resolveSessionGroupId(invocation)))
  }

  private async closeControlledTarget(
    targetId: string,
    mode: BrowserConnectionMode,
    invocation: PlaywrightInvocation,
    cdpUrl?: string,
  ): Promise<BrowserActionResult> {
    this.session.assertInvocationCurrent(invocation)
    const principalId = this.resolvePrincipalId(invocation)
    const nativeTab = mode === 'relay'
      ? this.options.relay.listTabs().find((entry) => entry.targetId === targetId || entry.targetKey === targetId)
      : undefined
    const ownership = mode === 'relay'
      ? nativeTab && { createdBy: nativeTab.createdBy, claimedBy: nativeTab.claimedBy, sessionGroupId: nativeTab.sessionGroupId, retained: nativeTab.isRetained }
      : this.tabState.getTab(targetId)
    if (!ownership || !canClosePage(ownership, principalId)) {
      return { ok: false, success: false, targetId, skipped: true, reason: 'Only this session’s non-retained, unclaimed-by-others agent pages can be closed.', retryable: false }
    }
    if (mode === 'relay') {
      const receipt = await this.options.relay.closeTarget(targetId, principalId)
      if (receipt.success && !receipt.skipped) {
        this.tabState.closeTab(targetId)
        this.session.clearCachedState(targetId)
      }
      return { ok: receipt.success, targetId, ...receipt }
    }
    await this.actions.closePage({ ...invocation, cdpUrl: requiredString(cdpUrl, 'cdpUrl'), targetId, mode })
    this.tabState.closeTab(targetId)
    this.session.clearCachedState(targetId)
    return { ok: true, success: true, targetId }
  }

  private async closeSessionRelayTabs(principalId: string, invocation: PlaywrightInvocation): Promise<BrowserActionResult> {
    this.session.assertInvocationCurrent(invocation)
    const targetIds = this.options.relay.listTabs()
      .filter((entry) => canClosePage({ createdBy: entry.createdBy, claimedBy: entry.claimedBy, sessionGroupId: entry.sessionGroupId, retained: entry.isRetained }, principalId))
      .map((entry) => entry.targetId || entry.targetKey)
    const receipt = await this.options.relay.closeAgentTabs(targetIds, principalId)
    for (const targetId of [...receipt.closedIds, ...receipt.alreadyClosedIds]) {
      this.tabState.closeTab(targetId)
      this.session.clearCachedState(targetId)
    }
    return { ok: receipt.success, ...receipt }
  }

  private async closeSessionDirectTabs(cdpUrl: string, invocation: PlaywrightInvocation): Promise<BrowserActionResult> {
    const principalId = this.resolvePrincipalId(invocation)
    const closedIds: string[] = []
    const failedDetails: BrowserActionResult[] = []
    for (const targetId of this.tabState.nonRetainedIds) {
      const ownership = this.tabState.getTab(targetId)!
      if (!canClosePage(ownership, principalId)) continue
      this.session.assertInvocationCurrent(invocation)
      try {
        const receipt = await this.closeControlledTarget(targetId, 'direct-cdp', invocation, cdpUrl)
        if (receipt.ok) closedIds.push(targetId)
        else failedDetails.push(receipt)
      } catch (error) {
        failedDetails.push({ targetId, ...this.classifyActionError(error, { action: 'close', connectionMode: 'direct-cdp' }) })
      }
    }
    const unknown = failedDetails.some((entry) => entry.outcome === 'unknown')
    return {
      ok: failedDetails.length === 0,
      closed: closedIds.length,
      closedIds,
      retained: this.tabState.allTargetIds.filter((id) => this.tabState.getTab(id)?.createdBy === principalId && this.tabState.isRetained(id)).length,
      failed: failedDetails.length,
      failedDetails,
      ...(unknown ? { outcome: 'unknown', retryable: false } : {}),
    }
  }

  private async stopSession(invocation: PlaywrightInvocation): Promise<BrowserActionResult> {
    const principalId = this.resolvePrincipalId(invocation)
    await this.session.drainSession({ context: invocation.context!, scope: 'executor' })
    await this.session.cleanupSessionUtilities({ context: invocation.context!, scope: 'executor' })
    this.session.assertInvocationCurrent(invocation)
    await this.options.relay.releaseSessionClaims(principalId, this.resolveSessionGroupId(invocation))
    this.session.assertInvocationCurrent(invocation)
    for (const targetId of this.tabState.allTargetIds) {
      const ownership = this.tabState.getTab(targetId)!
      if (ownership.claimedBy === principalId) this.tabState.registerTab(targetId, releasePage(ownership, principalId))
    }
    const relay = this.options.relay.hasExtensionConnection
      ? await this.closeSessionRelayTabs(principalId, invocation)
      : undefined
    const directIds = this.tabState.nonRetainedIds.filter((id) => canClosePage(this.tabState.getTab(id)!, principalId))
    let direct: BrowserActionResult | undefined
    if (directIds.length) {
      const cdpUrl = this.session.getConnection('direct-cdp')?.cdpUrl
      this.session.assertInvocationCurrent(invocation)
      direct = cdpUrl
        ? await this.closeSessionDirectTabs(cdpUrl, invocation)
        : createErrorResult('direct_cdp_unavailable', 'Original direct CDP browser disconnected; session pages were not closed.', { retryable: false })
    }
    const ok = relay?.ok !== false && direct?.ok !== false
    return { ok, stopped: ok, ...(relay ? { relay } : {}), ...(direct ? { direct } : {}) }
  }

  private async handleDownloadRequest(params: BrowserUtilityAction, invocation: BrowserActionInvocation): Promise<BrowserActionResult> {
    const request = params.request
    if (request?.kind !== 'download') return createErrorResult('invalid_request', 'download request is required')
    if (this.resolveConnectionMode(params) !== 'relay') {
      return createErrorResult('unsupported_action', 'utility.download requires an extension-backed browser.')
    }
    if (request.savePath !== undefined && request.dir !== undefined) {
      return createErrorResult('invalid_request', 'download savePath and dir are mutually exclusive', { retryable: false })
    }
    if (!invocation.context?.workspaceDir) {
      return createErrorResult('invalid_request', 'download requires a trusted workspace', { retryable: false })
    }
    const timeoutMs = request.timeoutMs ?? params.timeoutMs ?? 60_000
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
      return createErrorResult('invalid_request', 'download timeoutMs must be between 1 and 600000 milliseconds')
    }
    const trigger = request.trigger
    if (trigger && trigger.kind !== 'click' && trigger.kind !== 'clickCoords') {
      return createErrorResult('invalid_request', 'download trigger must be click or clickCoords')
    }
    const requestedTargetId = asString(trigger?.targetId) ?? asString(request.targetId) ?? asString(params.targetId)
    if (trigger?.kind === 'clickCoords' && (asNumber(trigger.x) === undefined || asNumber(trigger.y) === undefined)) {
      return createErrorResult('invalid_request', 'x and y are required for download clickCoords trigger')
    }
    if (trigger?.kind === 'click' && !asString(trigger.ref) && !asString(trigger.selector) && trigger.backendNodeId === undefined) {
      return createErrorResult('invalid_request', 'ref, selector or backendNodeId is required for download click trigger')
    }
    const principalId = this.resolvePrincipalId(invocation)
    if (!this.options.relay.hasExtensionConnection) await this.autoLauncher.ensureRelayBrowserAvailable()
    this.session.assertInvocationCurrent(invocation)
    if (!requestedTargetId) await this.options.relay.ensureExecutionWindowSelectionForBrowserUse(principalId, this.resolveSessionGroupId(invocation))
    this.session.assertInvocationCurrent(invocation)
    const targetId = await this.resolveRelayExecutionTarget(requestedTargetId)
    this.session.assertInvocationCurrent(invocation)
    const endpoint = this.resolveRelayEndpoint()
    if (!endpoint) return createErrorResult('browser_unavailable', 'Browser extension not connected.')
    const operation: PlaywrightInvocation = { ...invocation, deadlineAt: Date.now() + timeoutMs }
    const assertCurrent = () => this.session.assertInvocationCurrent(operation)
    return await this.options.relay.withTargetClaim(targetId, principalId, async () => {
      assertCurrent()
      const browserInstanceId = this.options.relay.listTabs().find((tab) => tab.targetId === targetId || tab.targetKey === targetId)?.browserInstanceId
      if (!browserInstanceId) return createErrorResult('browser_unavailable', 'Download browser instance is no longer available.', { retryable: false })
      const sourceDirectory = await this.session.runInvocation(operation, () => resolveLocalDownloadDirectory(browserInstanceId, assertCurrent))
      const destination = await this.session.runInvocation(operation, () => prepareWorkspaceDownload(request, invocation.context?.workspaceDir, assertCurrent))
      assertCurrent()
      const download = await this.options.relay.watchDownload(targetId, this.session.remainingTimeout(operation, timeoutMs), trigger ? async (context) => {
        context.signal.throwIfAborted()
        invocation.signal?.throwIfAborted()
        invocation.assertInvocationCurrent?.()
        if (trigger) {
          const result = await this.session.withPageOperation({ ...invocation, ...context, cdpUrl: endpoint.preferredUrl, targetId, mode: 'relay' }, () => this.handleActRequest({ action: 'act', request: { ...trigger, targetId }, timeoutMs: trigger.timeoutMs ?? timeoutMs }, endpoint.preferredUrl, targetId, 'relay', { ...invocation, ...context }))
          if (result.ok === false || result.actionPerformed === false) {
            throw Object.assign(new Error(String(result.error ?? result.reason ?? 'Download trigger failed')), {
              errorDetail: asRecord(result.errorDetail) ?? { code: result.errorCode, outcome: result.actionPerformed === false ? 'not_performed' : result.outcome ?? 'unknown', retryable: result.retryable ?? false },
            })
          }
        }
      } : undefined, invocation.signal)
      const receipt = {
        action: 'utility.download',
        browserInstanceId: download.browserInstanceId,
        attribution: 'browser_time_window',
        downloadId: download.downloadId,
        downloadState: 'completed',
        triggerOutcome: download.triggerOutcome,
        ...(download.triggerError ? { triggerError: download.triggerError } : {}),
        url: download.url,
        mime: download.mime,
        startTimeMs: download.startTimeMs,
        browserFilePath: download.filePath,
        fileSizeBytes: download.fileSizeBytes,
      }
      let saved: Awaited<ReturnType<typeof saveWorkspaceDownload>> | undefined
      let pendingSavePath: string | undefined
      try {
        if (download.browserInstanceId !== browserInstanceId) throw new Error('Download browser instance changed before saving.')
        await this.session.runInvocation(operation, async () => {
          saved = await saveWorkspaceDownload(download, sourceDirectory, destination, assertCurrent, (savePath) => { pendingSavePath = savePath })
        })
        return { ok: true, ...receipt, ...saved, saveOutcome: 'saved' }
      } catch (error) {
        // A submitted filesystem operation remains tracked by the original invocation until it settles.
        if (saved) return { ok: true, ...receipt, ...saved, saveOutcome: 'saved' }
        const failure = this.classifyActionError(error, { action: 'utility.download', connectionMode: 'relay' })
        const partial = asRecord(asRecord(error)?.partial)
        return {
          ...failure,
          ...receipt,
          ...(pendingSavePath ? { pendingSavePath } : {}),
          ...(partial ?? {}),
          ok: false,
          saveOutcome: partial?.saveOutcome ?? (failure.outcome === 'unknown' ? 'unknown' : 'failed'),
          retryable: false,
          hint: 'The browser download completed. Do not repeat the download trigger; inspect the save outcome and file locations.',
        }
      }
    }, this.resolveSessionGroupId(invocation))
  }

  private async handleActRequest(
    params: BrowserActAction,
    cdpUrl: string,
    defaultTargetId: string | undefined,
    mode: 'relay' | 'direct-cdp',
    invocation: PlaywrightInvocation = {},
  ): Promise<BrowserActionResult> {
    const kind = params.request?.kind
    if (!kind || !['click', 'clickCoords', 'type', 'press', 'hover', 'scrollIntoView', 'select'].includes(kind)) {
      return await this.executeActRequest(params, cdpUrl, defaultTargetId, mode, invocation)
    }
    return await this.actions.observeAction(
      { ...invocation, cdpUrl, targetId: params.request?.targetId ?? defaultTargetId, mode },
      kind === 'click' || kind === 'clickCoords' || kind === 'press' || (kind === 'type' && params.request?.submit === true),
      () => this.executeActRequest(params, cdpUrl, defaultTargetId, mode, invocation),
    )
  }

  private async executeActRequest(
    params: BrowserActAction,
    cdpUrl: string,
    defaultTargetId: string | undefined,
    mode: 'relay' | 'direct-cdp',
    invocation: PlaywrightInvocation = {},
  ): Promise<BrowserActionResult> {
    this.session.assertInvocationCurrent(invocation)
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
          ...invocation,
          cdpUrl,
          targetId,
          mode,
          fnBody: requiredString(payload.fn ?? payload.expression, 'fn'),
          ref: payload.ref,
          frameId: payload.frameId,
          timeoutMs,
        }),
      }
    }

    if (!payload.kind) {
      return createErrorResult('invalid_request', 'request.kind is required')
    }

    switch (payload.kind) {
      case 'click': {
        const selector = asString(payload.selector)
        const result = await this.actions.click({
          ...invocation,
          cdpUrl,
          targetId,
          mode,
          ref: selector ? undefined : asString(payload.ref),
          backendNodeId: payload.backendNodeId,
          frameId: payload.frameId,
          selector,
          timeoutMs,
          doubleClick: payload.doubleClick,
          button: asMouseButton(payload.button),
          modifiers: payload.modifiers,
          humanize: payload.humanize,
        })
        return { ok: true, action: 'act.click', targetId, ...result }
      }
      case 'clickCoords': {
        const x = asNumber(payload.x)
        const y = asNumber(payload.y)
        if (x === undefined || y === undefined) {
          return createErrorResult('invalid_request', 'x and y are required for request.kind=clickCoords')
        }
        await this.actions.click({
          ...invocation,
          cdpUrl,
          targetId,
          mode,
          x,
          y,
          timeoutMs,
          doubleClick: payload.doubleClick,
          button: asMouseButton(payload.button),
          modifiers: payload.modifiers,
          humanize: payload.humanize,
          delayMs: asNumber(payload.delayMs),
        })
        return { ok: true, action: 'act.clickCoords', targetId }
      }
      case 'type': {
        if (typeof payload.text !== 'string') return createErrorResult('invalid_request', 'text is required')
        const result = await this.actions.type({ ...invocation, cdpUrl, targetId, mode, ref: asString(payload.ref), backendNodeId: payload.backendNodeId, frameId: payload.frameId, text: payload.text, submit: payload.submit, slowly: payload.slowly, clearFirst: payload.clearFirst, timeoutMs })
        return { ok: true, action: 'act.type', targetId, ...result }
      }
      case 'press':
        await this.actions.press({ ...invocation, cdpUrl, targetId, mode, key: requiredString(payload.key, 'key'), delayMs: payload.delayMs })
        return { ok: true, action: 'act.press', targetId }
      case 'hover':
        return { ok: true, action: 'act.hover', targetId, ...await this.actions.hover({ ...invocation, cdpUrl, targetId, mode, ref: asString(payload.ref), backendNodeId: payload.backendNodeId, frameId: payload.frameId, timeoutMs }) }
      case 'scrollIntoView':
        return { ok: true, action: 'act.scrollIntoView', targetId, ...await this.actions.scrollIntoView({ ...invocation, cdpUrl, targetId, mode, ref: asString(payload.ref), backendNodeId: payload.backendNodeId, frameId: payload.frameId, timeoutMs }) }
      case 'drag':
        return { ok: true, action: 'act.drag', targetId, ...await this.actions.drag({ ...invocation, cdpUrl, targetId, mode, startRef: requiredString(payload.startRef, 'startRef'), endRef: requiredString(payload.endRef, 'endRef'), timeoutMs }) }
      case 'select':
        return { ok: true, action: 'act.select', targetId, ...await this.actions.select({ ...invocation, cdpUrl, targetId, mode, ref: asString(payload.ref), backendNodeId: payload.backendNodeId, frameId: payload.frameId, values: payload.values ?? [], timeoutMs }) }
      case 'fill': {
        if (!Array.isArray(payload.fields) || !payload.fields.length) return createErrorResult('invalid_request', 'fields must be a non-empty array')
        const fields = payload.fields.map((field) => {
          const ref = asString(field?.ref)
          if (!ref && field?.backendNodeId === undefined) throw new Error('fill requires ref or backendNodeId')
          const type = asString(field.type) ?? 'text'
          if (!['text', 'select', 'checkbox', 'radio'].includes(type)) throw new Error('fill type must be text/select/checkbox/radio')
          return { ...field, ref, type }
        })
        const result = await this.actions.fill({ ...invocation, cdpUrl, targetId, mode, fields, timeoutMs })
        return result.failed.length
          ? { ok: false, action: 'act.fill', targetId, error: 'BROWSER_FILL_PARTIAL_FAILURE', retryable: false, partial: result }
          : { ok: true, action: 'act.fill', targetId, appliedCount: result.applied.length }
      }
      case 'resize':
        await this.actions.resize({ ...invocation, cdpUrl, targetId, mode, width: payload.width ?? 0, height: payload.height ?? 0 })
        return { ok: true, action: 'act.resize', targetId }
      case 'wait':
        await this.actions.waitFor({
          ...invocation,
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
            ...invocation,
            cdpUrl,
            targetId,
            mode,
            fnBody: requiredString(payload.fn ?? payload.expression, 'fn'),
            ref: payload.ref,
            frameId: payload.frameId,
            timeoutMs,
          }),
        }
      case 'close':
        return { ...await this.closeControlledTarget(requiredString(targetId, 'targetId'), mode, invocation, cdpUrl), action: 'act.close' }
      case 'scroll':
        return {
          ok: true,
          action: 'act.scroll',
          targetId,
          result: await this.actions.scroll({
            ...invocation,
            cdpUrl,
            targetId,
            mode,
            direction: payload.scrollDirection,
            amount: payload.scrollAmount,
            pace: true,
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

  private async syncDirectTabs(cdpUrl: string, port: number, invocation: PlaywrightInvocation): Promise<Array<{ targetId: string; url: string; title: string; type?: string }>> {
    const tabs = await this.tabState.withSyncLock(async () => {
      this.session.assertInvocationCurrent(invocation)
      let list = await listDirectCdpTabs(port)
      this.session.assertInvocationCurrent(invocation)
      if (list.length === 1 && list[0]?.targetId === M144_PLACEHOLDER_TARGET_ID) {
        try {
          const connection = await this.session.connectBrowser(cdpUrl, 'direct-cdp', invocation)
          this.session.assertInvocationCurrent(invocation)
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
        } catch (error) {
          this.session.assertInvocationCurrent(invocation)
          throw error
        }
      }

      this.session.assertInvocationCurrent(invocation)
      const validTargetIds = new Set(list.map((entry) => entry.targetId).filter(Boolean))
      this.tabState.purgeStale(validTargetIds)
      return list
    })

    const principalId = invocation.context ? browserPrincipalId(invocation.context) : undefined
    for (const idleTargetId of this.tabState.getIdleTabs(10 * 60 * 1000)) {
      if (!principalId || !canClosePage(this.tabState.getTab(idleTargetId)!, principalId)) continue
      this.session.assertInvocationCurrent(invocation)
      try {
        await this.closeControlledTarget(idleTargetId, 'direct-cdp', invocation, cdpUrl)
      } catch {
        this.session.assertInvocationCurrent(invocation)
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
  } & PlaywrightInvocation): Promise<unknown> {
    this.session.assertInvocationCurrent(input)
    if (!input.targetId) {
      throw new Error('targetId is required')
    }

    if (input.mode === 'relay') {
      return await this.handleRelayCookiesAction(input.targetId, input.operation, input.cookies, input)
    }

    return await this.handleDirectCdpCookiesAction({ ...input, mode: input.mode }, input.targetId)
  }

  private async handleRelayCookiesAction(
    targetId: string,
    operation: 'get' | 'set' | 'clear',
    cookies: BrowserCookieInput[] | undefined,
    invocation: PlaywrightInvocation,
  ): Promise<unknown> {
    this.session.assertInvocationCurrent(invocation)
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
    } & PlaywrightInvocation,
    targetId: string,
  ): Promise<unknown> {
    this.session.assertInvocationCurrent(input)
    const page = await this.session.getPageForTargetId({
      ...input,
      cdpUrl: input.cdpUrl,
      targetId,
      mode: input.mode,
    })
    this.session.assertInvocationCurrent(input)
    const pageUrl = typeof page?.url === 'function' ? String(page.url()).trim() : ''
    const currentPageCookieUrl = this.resolveCookieCapableUrl(pageUrl)

    if (input.operation === 'get') {
      if (!currentPageCookieUrl) {
        return []
      }
      const result = await this.session.sendPageCdpCommand(
        { ...input, cdpUrl: input.cdpUrl, targetId, mode: input.mode },
        'Network.getCookies',
        { urls: [currentPageCookieUrl] },
      )
      const cookies = Array.isArray(result?.cookies) ? result.cookies : []
      return cookies.map((cookie: unknown) => normalizeBrowserCookieRecord(cookie)).filter(Boolean)
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
        { ...input, cdpUrl: input.cdpUrl, targetId, mode: input.mode },
        'Network.setCookies',
        { cookies: normalizedCookies },
      )
      return { ok: true }
    }

    if (!currentPageCookieUrl) {
      return { ok: true }
    }

    const existing = await this.session.sendPageCdpCommand(
      { ...input, cdpUrl: input.cdpUrl, targetId, mode: input.mode },
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
        { ...input, cdpUrl: input.cdpUrl, targetId, mode: input.mode },
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
    if (error instanceof NativePageUpdatedError) {
      const partial = asRecord(asRecord(error)?.partial)
      const appliedCount = Array.isArray(partial?.applied) ? partial.applied.length : 0
      return {
        ok: appliedCount === 0,
        actionPerformed: appliedCount > 0,
        pageUpdated: true,
        reason: error.reason,
        ...(partial ? { partial } : {}),
        ...(appliedCount ? { error: 'BROWSER_FILL_PARTIAL_FAILURE', appliedCount, retryable: false, hint: 'Earlier fields were applied. Inspect the updated page and continue only with remaining fields; do not repeat the whole fill.' } : {}),
        ...(error.freshSnapshot ? { snapshot: error.freshSnapshot.snapshot, refs: error.freshSnapshot.refs } : {}),
      }
    }
    const { message: originalMessage, errorDetail } = readRelayError(error)
    const mappedMessage = this.session.mapActionError(new Error(originalMessage))
    const combinedMessage = `${originalMessage}\n${mappedMessage}`
    if (errorDetail) {
      return {
        ...createErrorResult('protocol_error', mappedMessage, {
          ...(errorDetail.outcome === 'unknown' ? { retryable: false } : typeof errorDetail.retryable === 'boolean' ? { retryable: errorDetail.retryable } : {}),
        }),
        errorDetail,
        ...(asRecord(error)?.partial ? { partial: asRecord(error)!.partial } : {}),
        ...(typeof errorDetail.outcome === 'string' ? { outcome: errorDetail.outcome } : {}),
      }
    }

    if (/timeout|timed out|deadline|cancel|abort/i.test(combinedMessage)) {
      return {
        ...createErrorResult('protocol_error', mappedMessage, { retryable: false }),
        outcome: 'unknown',
      }
    }

    if (combinedMessage.includes('No current browser target available.')) {
      return createErrorResult('no_current_target', mappedMessage, {
        recoverable: true,
        suggestedNextActions: ['tabs', 'open', 'focus'],
      })
    }

    if (combinedMessage.includes('Unknown ref "') || combinedMessage.includes('Unknown fused ref:')) {
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
      return { ...createErrorResult('page_context_destroyed', mappedMessage, { recoverable: true, retryable: false }), outcome: 'unknown' }
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
