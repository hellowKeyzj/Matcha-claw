import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { imageResultFromFile, wrapExternalContent } from 'openclaw/plugin-sdk/browser-support'

type BrowserRelayToolContext = {
  sessionKey?: string
  workspaceDir?: string
}

type BrowserRelayToolParams = Record<string, unknown>

type BrowserRelayControl = {
  handleRequest: (params: Record<string, unknown>) => Promise<Record<string, unknown>>
}

const browserToolActions = [
  'open',
  'close',
  'stop',
  'start',
  'status',
  'console',
  'focus',
  'snapshot',
  'navigate',
  'profiles',
  'dialog',
  'tabs',
  'screenshot',
  'pdf',
  'upload',
  'act',
  'scroll',
  'errors',
  'requests',
  'cookies',
  'storage',
  'highlight',
  'closeagenttabs',
  'close_agent_tabs',
] as const

const browserRequestKinds = [
  'select',
  'type',
  'fill',
  'close',
  'resize',
  'wait',
  'hover',
  'click',
  'press',
  'drag',
  'evaluate',
  'scroll',
  'scrollIntoView',
] as const

const browserRelayToolParameters = {
  type: 'object',
  additionalProperties: true,
  required: ['action'],
  properties: {
    action: { type: 'string', enum: [...browserToolActions] },
    target: { type: 'string', enum: ['node', 'sandbox', 'host'] },
    node: { type: 'string' },
    profile: { type: 'string' },
    targetUrl: { type: 'string' },
    url: { type: 'string' },
    targetId: { type: 'string' },
    connectionMode: { type: 'string', enum: ['relay', 'direct-cdp'] },
    limit: { type: 'number' },
    maxChars: { type: 'number' },
    mode: { type: 'string', enum: ['efficient'] },
    snapshotFormat: { type: 'string', enum: ['aria', 'ai'] },
    refs: { type: 'string', enum: ['role', 'aria'] },
    interactive: { type: 'boolean' },
    compact: { type: 'boolean' },
    efficient: { type: 'boolean' },
    depth: { type: 'number' },
    selector: { type: 'string' },
    frame: { type: 'string' },
    labels: { type: 'boolean' },
    fullPage: { type: 'boolean' },
    ref: { type: 'string' },
    element: { type: 'string' },
    type: { type: 'string', enum: ['jpeg', 'png'] },
    quality: { type: 'number' },
    level: { type: 'string' },
    paths: { type: 'array', items: { type: 'string' } },
    inputRef: { type: 'string' },
    timeoutMs: { type: 'number' },
    accept: { type: 'boolean' },
    promptText: { type: 'string' },
    expression: { type: 'string' },
    savePath: { type: 'string' },
    retain: { type: 'boolean' },
    clear: { type: 'boolean' },
    filter: { type: 'string' },
    operation: { type: 'string', enum: ['get', 'set', 'clear'] },
    cookies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
      },
    },
    storageType: { type: 'string', enum: ['local', 'session'] },
    key: { type: 'string' },
    value: { type: ['string', 'number', 'boolean'] },
    durationMs: { type: 'number' },
    animations: { type: 'string', enum: ['allow', 'disabled'] },
    caret: { type: 'string', enum: ['hide', 'initial'] },
    scale: { type: 'string', enum: ['css', 'device'] },
    omitBackground: { type: 'boolean' },
    scrollDirection: { type: 'string' },
    scrollAmount: { type: 'number' },
    waitUntil: { type: 'string' },
    kind: { type: 'string', enum: [...browserRequestKinds] },
    doubleClick: { type: 'boolean' },
    button: { type: 'string' },
    modifiers: { type: 'array', items: { type: 'string' } },
    text: { type: 'string' },
    submit: { type: 'boolean' },
    slowly: { type: 'boolean' },
    clearFirst: { type: 'boolean' },
    keyPress: { type: 'string' },
    delayMs: { type: 'number' },
    startRef: { type: 'string' },
    endRef: { type: 'string' },
    values: { type: 'array', items: { type: 'string' } },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: true,
      },
    },
    width: { type: 'number' },
    height: { type: 'number' },
    timeMs: { type: 'number' },
    textGone: { type: 'string' },
    loadState: { type: 'string' },
    fn: { type: 'string' },
    request: {
      type: 'object',
      additionalProperties: true,
      properties: {
        kind: { type: 'string', enum: [...browserRequestKinds] },
        targetId: { type: 'string' },
        ref: { type: 'string' },
        doubleClick: { type: 'boolean' },
        button: { type: 'string' },
        modifiers: { type: 'array', items: { type: 'string' } },
        text: { type: 'string' },
        submit: { type: 'boolean' },
        slowly: { type: 'boolean' },
        clearFirst: { type: 'boolean' },
        key: { type: 'string' },
        delayMs: { type: 'number' },
        startRef: { type: 'string' },
        endRef: { type: 'string' },
        values: { type: 'array', items: { type: 'string' } },
        fields: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: true,
          },
        },
        width: { type: 'number' },
        height: { type: 'number' },
        timeMs: { type: 'number' },
        selector: { type: 'string' },
        url: { type: 'string' },
        loadState: { type: 'string' },
        textGone: { type: 'string' },
        timeoutMs: { type: 'number' },
        fn: { type: 'string' },
        expression: { type: 'string' },
        scrollDirection: { type: 'string' },
        scrollAmount: { type: 'number' },
      },
    },
  },
} as const

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function wrapBrowserExternalJson(
  kind: 'console' | 'tabs',
  payload: unknown,
  includeWarning = false,
) {
  return {
    wrappedText: wrapExternalContent(asJsonText(payload), {
      source: 'browser',
      includeWarning,
    }),
    safeDetails: {
      ok: true,
      externalContent: {
        untrusted: true,
        source: 'browser',
        kind,
        wrapped: true,
      },
    },
  }
}

async function ensureTempFile(extension: string, base64Data: string): Promise<string> {
  const tempDir = path.join(os.tmpdir(), 'matchaclaw-browser-relay')
  await fs.mkdir(tempDir, { recursive: true })
  const filePath = path.join(tempDir, `${randomUUID()}.${extension}`)
  await fs.writeFile(filePath, Buffer.from(base64Data, 'base64'))
  return filePath
}

async function resolveImagePath(result: Record<string, unknown>): Promise<string | null> {
  const savedTo = asString(result.savedTo)
  if (savedTo) return savedTo

  const imageBase64 = asString(result.imageBase64)
  if (!imageBase64) return null

  const imageType = asString(result.imageType) === 'jpeg' ? 'jpg' : 'png'
  return await ensureTempFile(imageType, imageBase64)
}

async function resolvePdfPath(result: Record<string, unknown>): Promise<string | null> {
  const savedTo = asString(result.savedTo)
  if (savedTo) return savedTo

  const pdfBase64 = asString(result.pdfBase64)
  if (!pdfBase64) return null

  return await ensureTempFile('pdf', pdfBase64)
}

function formatTabsResult(result: Record<string, unknown>) {
  const tabs = Array.isArray(result.tabs) ? result.tabs : []
  const wrapped = wrapBrowserExternalJson('tabs', { tabs })
  return {
    content: [{ type: 'text' as const, text: wrapped.wrappedText }],
    details: {
      ...wrapped.safeDetails,
      tabCount: tabs.length,
    },
  }
}

function formatConsoleResult(result: Record<string, unknown>) {
  const wrapped = wrapBrowserExternalJson('console', result)
  return {
    content: [{ type: 'text' as const, text: wrapped.wrappedText }],
    details: {
      ...wrapped.safeDetails,
      ...(asString(result.targetId) ? { targetId: asString(result.targetId) } : {}),
      ...(Array.isArray(result.messages) ? { messageCount: result.messages.length } : {}),
    },
  }
}

async function formatSnapshotResult(result: Record<string, unknown>) {
  const snapshotText = typeof result.snapshot === 'string' ? result.snapshot : asJsonText(result)
  const wrappedSnapshot = wrapExternalContent(snapshotText, {
    source: 'browser',
    includeWarning: true,
  })
  const safeDetails = {
    ok: true,
    format: 'ai',
    ...(asString(result.targetId) ? { targetId: asString(result.targetId) } : {}),
    ...(asString(result.url) ? { url: asString(result.url) } : {}),
    ...(result.stats && typeof result.stats === 'object' ? { stats: result.stats } : {}),
    ...(result.refs && typeof result.refs === 'object' && !Array.isArray(result.refs)
      ? { refs: Object.keys(result.refs as Record<string, unknown>).length }
      : {}),
    externalContent: {
      untrusted: true,
      source: 'browser',
      kind: 'snapshot',
      format: 'ai',
      wrapped: true,
    },
  }

  return {
    content: [{ type: 'text' as const, text: wrappedSnapshot }],
    details: safeDetails,
  }
}

async function formatScreenshotResult(result: Record<string, unknown>) {
  const imagePath = await resolveImagePath(result)
  if (!imagePath) {
    return {
      content: [{ type: 'text' as const, text: asJsonText(result) }],
      details: result,
    }
  }

  return await imageResultFromFile({
    label: 'browser:screenshot',
    path: imagePath,
    details: {
      ...result,
      path: imagePath,
    },
  })
}

async function formatPdfResult(result: Record<string, unknown>) {
  const pdfPath = await resolvePdfPath(result)
  if (!pdfPath) {
    return {
      content: [{ type: 'text' as const, text: asJsonText(result) }],
      details: result,
    }
  }

  return {
    content: [{ type: 'text' as const, text: `FILE:${pdfPath}` }],
    details: {
      ...result,
      path: pdfPath,
    },
  }
}

async function formatRelayToolResult(
  params: BrowserRelayToolParams,
  result: Record<string, unknown>,
) {
  const action = asString(params.action)?.toLowerCase()
  if (result.ok === false) {
    return {
      content: [{ type: 'text' as const, text: asJsonText(result) }],
      details: result,
    }
  }

  if (action === 'tabs') {
    return formatTabsResult(result)
  }

  if (action === 'snapshot') {
    return await formatSnapshotResult(result)
  }

  if (action === 'console' && !asString(params.expression) && Array.isArray(result.messages)) {
    return formatConsoleResult(result)
  }

  if (action === 'screenshot') {
    return await formatScreenshotResult(result)
  }

  if (action === 'pdf') {
    return await formatPdfResult(result)
  }

  return {
    content: [{ type: 'text' as const, text: asJsonText(result) }],
    details: result,
  }
}

export function createBrowserRelayTool(
  toolCtx: BrowserRelayToolContext,
  resolveControl: () => BrowserRelayControl,
) {
  return {
    name: 'browser',
    label: 'Browser',
    description:
      'Control the browser through MatchaClaw Browser Relay. Default mode uses the extension relay; direct-cdp is debug-only and must be requested explicitly.',
    parameters: browserRelayToolParameters,
    async execute(_toolCallId: string, params: BrowserRelayToolParams) {
      const result = await resolveControl().handleRequest({
        ...params,
        ...(toolCtx.sessionKey ? { sessionKey: toolCtx.sessionKey } : {}),
        ...(toolCtx.workspaceDir ? { workspaceDir: toolCtx.workspaceDir } : {}),
      })

      return await formatRelayToolResult(params, result)
    },
  }
}
