import type { PluginLogger } from 'openclaw/plugin-sdk'
import path from 'node:path'
import fs from 'node:fs/promises'
import { BrowserRelayServer } from '../relay/server.js'
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

export type BrowserControlServiceOptions = {
  logger: PluginLogger
  relay: BrowserRelayServer
}

type BrowserActionParams = Record<string, unknown>
type ConnectionMode = 'relay' | 'direct-cdp'

type BrowserActionResult = Record<string, unknown> & {
  ok?: boolean
  error?: string
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
    const sharpModule = await import('sharp')
    const sharp = typeof sharpModule.default === 'function' ? sharpModule.default : sharpModule
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

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

export class BrowserControlService {
  private readonly tabState = new BrowserTabState()
  private readonly session: PlaywrightSession
  private readonly actions: PlaywrightActions

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
  }

  async stop(): Promise<void> {
    await this.session.closeConnections()
    this.tabState.reset()
  }

  async handleRequest(params: BrowserActionParams): Promise<BrowserActionResult> {
    const action = (asString(params.action) ?? '').toLowerCase()
    if (!action) {
      return { ok: false, error: 'action is required' }
    }

    try {
      if (this.isRelayDirectAction(action)) {
        return await this.handleRelayOrDirectAction(action, params)
      }
      return await this.handlePlaywrightAction(
        action,
        params,
        this.resolveConnectionMode(params),
      )
    } catch (error) {
      return {
        ok: false,
        error: this.session.mapActionError(error),
      }
    }
  }

  getStatus(): BrowserActionResult {
    this.syncRelayExecutionTarget()
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

  private isRelayDirectAction(action: string): boolean {
    return ['start', 'status', 'profiles', 'tabs', 'open', 'focus', 'close', 'console', 'closeagenttabs', 'close_agent_tabs'].includes(action)
  }

  private async handleRelayOrDirectAction(action: string, params: BrowserActionParams): Promise<BrowserActionResult> {
    if (this.options.relay.hasExtensionConnection) {
      return await this.handleRelayAction(action, params)
    }

    const directEndpoint = await this.resolveDirectEndpoint()
    if (!directEndpoint) {
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
      return {
        ok: false,
        error: 'Browser extension not connected and no direct CDP browser detected.'
      }
    }

    return await this.handleDirectCdpAction(action, params, directEndpoint)
  }

  private async handleRelayAction(action: string, params: BrowserActionParams): Promise<BrowserActionResult> {
    this.syncRelayExecutionTarget()
    const attachments = this.options.relay.listAttachments()
    const tabs = this.options.relay.listTabs()
    const relayPort = this.options.relay.relayPort

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
      const targetUrl = asString(params.targetUrl) ?? 'about:blank'
      const created = await this.options.relay.openTarget(targetUrl)
      const targetId = String(created.targetId)
      const sessionKey = asString(params.sessionKey)
      this.tabState.registerTab(targetId, {
        retain: asBoolean(params.retain) === true,
        sessionKey,
      })
      this.tabState.touchTab(targetId)
      this.options.relay.updateTargetUrl(targetId, targetUrl)
      return { ok: true, targetId, url: targetUrl, title: '' }
    }

    if (action === 'focus') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return { ok: false, error: 'targetId is required for action=focus' }
      }
      await this.options.relay.focusTarget(targetId)
      this.tabState.touchTab(targetId)
      return { ok: true, targetId }
    }

    if (action === 'close') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return { ok: false, error: 'targetId is required for action=close' }
      }
      await this.options.relay.closeTarget(targetId)
      this.tabState.closeTab(targetId)
      return { ok: true, targetId }
    }

    if (action === 'console') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return { ok: false, error: 'targetId is required for action=console' }
      }
      const expression = asString(params.expression)
      if (!expression) {
        return { ok: false, error: 'expression is required for action=console' }
      }
      const result = await this.options.relay.evaluate(targetId, expression)
      return { ok: true, targetId, result }
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
    action: string,
    params: BrowserActionParams,
    endpoint: ResolvedCdpEndpoint,
  ): Promise<BrowserActionResult> {
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
      const targetUrl = asString(params.targetUrl) ?? 'about:blank'
      const result = await this.session.sendBrowserCdpCommand(cdpUrl, 'Target.createTarget', {
        url: targetUrl,
      }, 'direct-cdp')
      const targetId = String(result?.targetId ?? '').trim()
      if (!targetId) {
        return { ok: false, error: 'Target.createTarget returned no targetId' }
      }
      this.tabState.registerTab(targetId, {
        retain: asBoolean(params.retain) === true,
        sessionKey: asString(params.sessionKey),
      })
      this.tabState.touchTab(targetId)
      return { ok: true, targetId, url: targetUrl, title: '' }
    }

    if (action === 'focus') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return { ok: false, error: 'targetId is required for action=focus' }
      }
      const page = await this.session.getPageForTargetId({ cdpUrl, targetId, mode: 'direct-cdp' })
      await page.bringToFront()
      this.tabState.touchTab(targetId)
      return { ok: true, targetId }
    }

    if (action === 'close') {
      const targetId = asString(params.targetId)
      if (!targetId) {
        return { ok: false, error: 'targetId is required for action=close' }
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
        return { ok: false, error: 'targetId and expression are required for action=console' }
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

    return { ok: false, error: `Unsupported direct CDP action: ${action}` }
  }

  private async handlePlaywrightAction(
    action: string,
    params: BrowserActionParams,
    connectionMode: ConnectionMode,
  ): Promise<BrowserActionResult> {
    const endpoint = connectionMode === 'direct-cdp'
      ? await this.resolveDirectEndpoint()
      : this.resolveRelayEndpoint()
    if (!endpoint) {
      return {
        ok: false,
        error:
          connectionMode === 'direct-cdp'
            ? 'No direct CDP browser detected. Start Chrome with remote debugging enabled before using direct-cdp mode.'
            : 'Browser extension not connected. Start the managed browser or connect an extension-backed browser first.',
      }
    }

    const targetId =
      connectionMode === 'relay'
        ? this.resolveExecutionTarget(asString(params.targetId))
        : asString(params.targetId)
    const mode = connectionMode
    const cdpUrl = endpoint.preferredUrl
    const workspaceDir = asString(params.workspaceDir)

    if (targetId) {
      this.tabState.touchTab(targetId)
    }

    if (action === 'navigate') {
      const result = await this.actions.navigate({
        cdpUrl,
        targetId,
        mode,
        url: requiredString(params.targetUrl, 'targetUrl'),
        timeoutMs: asNumber(params.timeoutMs),
        waitUntil: asString(params.waitUntil),
      })
      return { ok: true, action: 'navigate', targetId, ...result }
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

    if (action === 'close') {
      await this.actions.closePage({ cdpUrl, targetId, mode })
      if (targetId) {
        this.tabState.closeTab(targetId)
      }
      return { ok: true, targetId }
    }

    if (action === 'console') {
      const expression = asString(params.expression)
      if (expression) {
        const evaluationResult = await this.actions.evaluate({
          cdpUrl,
          targetId,
          mode,
          fnBody: expression,
          timeoutMs: asNumber(params.timeoutMs),
          ref: asString(params.ref),
        })
        const savePath = resolvePathWithinWorkspace(asString(params.savePath), workspaceDir)
        if (savePath) {
          await fs.mkdir(path.dirname(savePath), { recursive: true })
          await fs.writeFile(savePath, serializeJson(evaluationResult), 'utf8')
        }
        return { ok: true, targetId, result: evaluationResult, ...(savePath ? { savedTo: savePath } : {}) }
      }
      return await this.actions.consoleMessages({
        cdpUrl,
        targetId,
        mode,
        level: asString(params.level),
      })
    }

    if (action === 'errors') {
      return { ok: true, ...(await this.actions.pageErrors({ cdpUrl, targetId, mode, clear: asBoolean(params.clear) })) }
    }

    if (action === 'requests') {
      return { ok: true, ...(await this.actions.networkRequests({ cdpUrl, targetId, mode, filter: asString(params.filter), clear: asBoolean(params.clear) })) }
    }

    if (action === 'cookies') {
      const operation = asString(params.operation) as 'get' | 'set' | 'clear' | undefined
      if (!operation || !['get', 'set', 'clear'].includes(operation)) {
        return { ok: false, error: 'operation must be get, set, or clear for action=cookies' }
      }
      return { ok: true, data: await this.actions.cookies({ cdpUrl, targetId, mode, operation, cookies: Array.isArray(params.cookies) ? (params.cookies as any[]) : undefined }) }
    }

    if (action === 'storage') {
      const storageType = asString(params.storageType) === 'session' ? 'session' : 'local'
      const operation = asString(params.operation) as 'get' | 'set' | 'clear' | undefined
      if (!operation || !['get', 'set', 'clear'].includes(operation)) {
        return { ok: false, error: 'operation must be get, set, or clear for action=storage' }
      }
      return { ok: true, data: await this.actions.storage({ cdpUrl, targetId, mode, storageType, operation, key: asString(params.key), value: asString(params.value) }) }
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
        return { ok: false, error: 'paths is required for action=upload' }
      }
      const resolvedPaths = paths
        .map((entry) => resolvePathWithinWorkspace(entry, workspaceDir))
        .filter((entry): entry is string => Boolean(entry))
      if (!resolvedPaths.length) {
        return { ok: false, error: 'No valid upload paths after validation' }
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

    return { ok: false, error: `Unsupported browser action: ${action}` }
  }

  private async handleActRequest(
    params: BrowserActionParams,
    cdpUrl: string,
    defaultTargetId: string | undefined,
    mode: 'relay' | 'direct-cdp',
  ): Promise<BrowserActionResult> {
    const request = params.request
    if (!request || typeof request !== 'object') {
      return { ok: false, error: 'request is required for action=act' }
    }

    const payload = request as Record<string, unknown>
    const kind = asString(payload.kind) ?? (asString(payload.fn) || asString(payload.expression) ? 'evaluate' : undefined)
    if (!kind) {
      return { ok: false, error: 'request.kind is required' }
    }

    const targetId = asString(payload.targetId) ?? defaultTargetId
    const timeoutMs = asNumber(payload.timeoutMs) ?? asNumber(params.timeoutMs)

    switch (kind) {
      case 'click':
        await this.actions.click({ cdpUrl, targetId, mode, ref: requiredString(payload.ref, 'ref'), timeoutMs, doubleClick: asBoolean(payload.doubleClick), button: asString(payload.button) as any, modifiers: asStringArray(payload.modifiers) })
        return { ok: true, action: 'act.click', targetId }
      case 'type':
        await this.actions.type({ cdpUrl, targetId, mode, ref: requiredString(payload.ref, 'ref'), text: requiredString(payload.text, 'text'), submit: asBoolean(payload.submit), slowly: asBoolean(payload.slowly), clearFirst: asBoolean(payload.clearFirst), timeoutMs })
        return { ok: true, action: 'act.type', targetId }
      case 'press':
        await this.actions.press({ cdpUrl, targetId, mode, key: requiredString(payload.key, 'key'), delayMs: asNumber(payload.delayMs) })
        return { ok: true, action: 'act.press', targetId }
      case 'hover':
        await this.actions.hover({ cdpUrl, targetId, mode, ref: requiredString(payload.ref, 'ref'), timeoutMs })
        return { ok: true, action: 'act.hover', targetId }
      case 'scrollintoview':
        await this.actions.scrollIntoView({ cdpUrl, targetId, mode, ref: requiredString(payload.ref, 'ref'), timeoutMs })
        return { ok: true, action: 'act.scrollIntoView', targetId }
      case 'drag':
        await this.actions.drag({ cdpUrl, targetId, mode, startRef: requiredString(payload.startRef, 'startRef'), endRef: requiredString(payload.endRef, 'endRef'), timeoutMs })
        return { ok: true, action: 'act.drag', targetId }
      case 'select':
        await this.actions.select({ cdpUrl, targetId, mode, ref: requiredString(payload.ref, 'ref'), values: asStringArray(payload.values) ?? [], timeoutMs })
        return { ok: true, action: 'act.select', targetId }
      case 'fill':
        await this.actions.fill({
          cdpUrl,
          targetId,
          mode,
          fields: Array.isArray(payload.fields) ? (payload.fields as any[]).map((field) => ({ ref: String(field.ref ?? ''), type: String(field.type ?? ''), value: field.value })) : [],
          timeoutMs,
        })
        return { ok: true, action: 'act.fill', targetId }
      case 'resize':
        await this.actions.resize({ cdpUrl, targetId, mode, width: asNumber(payload.width) ?? 0, height: asNumber(payload.height) ?? 0 })
        return { ok: true, action: 'act.resize', targetId }
      case 'wait':
        await this.actions.waitFor({
          cdpUrl,
          targetId,
          mode,
          timeoutMs,
          timeMs: asNumber(payload.timeMs),
          text: asString(payload.text),
          textGone: asString(payload.textGone),
          selector: asString(payload.selector),
          url: asString(payload.url),
          loadState: asString(payload.loadState) as any,
          fnBody: asString(payload.fn),
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
            ref: asString(payload.ref),
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
            direction: asString(payload.scrollDirection),
            amount: asNumber(payload.scrollAmount),
          }),
        }
      default:
        return { ok: false, error: `unsupported act kind: ${kind}` }
    }
  }

  private resolveConnectionMode(params: BrowserActionParams): ConnectionMode {
    return asString(params.connectionMode) === 'direct-cdp' ? 'direct-cdp' : 'relay'
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
          const browser = connection.browser
          list = browser
            .contexts()
            .flatMap((context: any) => context.pages())
            .map((currentPage: any) => ({
              targetId: currentPage?._delegate?._targetId ?? '',
              url: currentPage.url(),
              title: '',
              type: 'page',
            }))
            .filter((entry: { targetId: string }) => entry.targetId)
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

  private syncRelayExecutionTarget(): void {
    const selected = this.options.relay.listAttachments().find((entry) => entry.selected && entry.primary)
    if (!selected?.targetId || selected.windowId == null || selected.tabId == null) {
      this.tabState.clearSelectedExecutionTarget()
      return
    }
    this.tabState.setSelectedExecutionTarget({
      browserInstanceId: selected.browserInstanceId,
      windowId: selected.windowId,
      tabId: selected.tabId,
      targetId: selected.targetId,
    })
  }

  private resolveExecutionTarget(explicitTargetId?: string): string {
    if (explicitTargetId) return explicitTargetId
    this.syncRelayExecutionTarget()
    const selected = this.tabState.currentSelectedPhysicalTargetId
    if (selected) {
      return selected
    }
    throw new Error('No default browser target available. Select a window and keep its active page attached.')
  }
}

function requiredString(value: unknown, field: string): string {
  const normalized = asString(value)
  if (!normalized) {
    throw new Error(`${field} is required`)
  }
  return normalized
}
