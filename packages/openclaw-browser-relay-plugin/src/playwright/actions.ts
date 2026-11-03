import type { PlaywrightInvocation, PlaywrightSession } from './session.js'
import { relayOperationError } from '../relay/downloads.js'
import { readRelayError } from '../relay/errors.js'
import type { BrowserSnapshotAction, BrowserActRequest, BrowserPdfOptions } from '../browser-action-contract.js'
import type { SnapshotFilterOptions } from './snapshot-filter.js'
import { NativePageUpdatedError, renderRawSnapshot, type NativeSnapshotResult } from './native-snapshot.js'
import { selectSnapshotScope } from './native-snapshot-dom.js'
import { captureRawRows } from './native-snapshot-raw.js'
import { actNativeElement, evaluateNativeElement, screenshotNativeElementClip, setNativeInputFiles, highlightNativeElement, moveNativePointer } from './native-elements.js'

type BrowserStorageHandle = 'localStorage' | 'sessionStorage'
type NativeElementInput = { ref?: string; backendNodeId?: number; frameId?: string }

function requiredString(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new Error(`${field} is required`)
  }
  return normalized
}

function isDetachedFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Frame has been detached') || message.includes('frame was detached')
}

function mapLocatorError(error: unknown, ref: string): Error {
  const { message, errorDetail } = readRelayError(error)
  if (errorDetail) return Object.assign(new Error(message), { errorDetail })
  if (message.includes('strict mode violation')) {
    const match = message.match(/resolved to (\d+) elements/)
    const count = match?.[1] ?? 'multiple'
    return new Error(`Selector "${ref}" matched ${count} elements. Run a new snapshot and use a different ref.`)
  }
  if ((message.includes('Timeout') || message.includes('waiting for')) && (message.includes('to be visible') || message.includes('not visible'))) {
    return new Error(`Element "${ref}" not found or not visible. Run a new snapshot to see current page elements.`)
  }
  if (message.includes('intercepts pointer events') || message.includes('not receive pointer events')) {
    return new Error(`Element "${ref}" is not interactable (hidden or covered). Try scrolling it into view or re-snapshotting.`)
  }
  return error instanceof Error ? error : new Error(message)
}

async function evaluateFunctionOnPage(page: any, fnBody: string, timeoutMs: number): Promise<unknown> {
  const evaluator = new Function(
    'args',
    `
      "use strict";
      const { fnBody, timeoutMs } = args;
      let candidate;
      try {
        candidate = eval("(" + fnBody + ")");
      } catch (error) {
        throw new Error("Invalid evaluate function: " + (error && error.message ? error.message : String(error)));
      }
      const result = typeof candidate === "function" ? candidate() : candidate;
      if (result && typeof result.then === "function") {
        return Promise.race([
          result,
          new Promise((_, reject) => {
            setTimeout(() => reject(new Error("evaluate timed out after " + timeoutMs + "ms")), timeoutMs);
          }),
        ]);
      }
      return result;
    `,
  )
  return await page.evaluate(evaluator, { fnBody, timeoutMs })
}

export class PlaywrightActions {
  constructor(private readonly session: PlaywrightSession) {}

  private async actNative(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp' } & PlaywrightInvocation, request: BrowserActRequest | ({ kind: 'setChecked'; checked: boolean } & NativeElementInput), humanize: boolean) {
    return await this.session.withNativeTransport(input, async (transport, owner, actorKey) => await actNativeElement(request, (target) => owner.resolve(actorKey, target, transport), transport, humanize))
  }

  async observeAction<T extends Record<string, unknown>>(
    input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp' } & PlaywrightInvocation,
    watchTabs: boolean,
    operation: () => Promise<T>,
  ): Promise<T> {
    const page = await this.session.getPageForTargetId(input)
    const state = this.session.ensurePageState(page)
    const cursor = state.nextEventSeq
    const previousInvocation = state.eventInvocation
    state.eventInvocation = input
    const browser = (await this.session.connectBrowser(input.cdpUrl, input.mode, input)).browser
    const pages = () => browser.contexts().flatMap((context: any) => context.pages()) as any[]
    const previousPages = watchTabs ? new Set(pages()) : undefined
    try {
      const result = await operation()
      if (result.ok === false || result.actionPerformed === false) return result
      try {
        const newTabs: Array<{ targetId: string; url: string; title: string }> = []
        if (previousPages) {
          const until = Date.now() + 400
          await this.session.runInvocation(input, () => new Promise((resolve) => setTimeout(resolve, 80)))
          while (true) {
            for (const candidate of pages().filter((entry) => !previousPages.has(entry))) {
              const targetId = await this.session.runInvocation(input, () => this.session.resolvePageTargetId(candidate, input))
              if (targetId) newTabs.push({ targetId, url: candidate.url(), title: await this.session.runInvocation(input, () => candidate.title()) })
            }
            if (newTabs.length || Date.now() >= until) break
            await this.session.runInvocation(input, () => new Promise((resolve) => setTimeout(resolve, Math.min(100, until - Date.now()))))
          }
        }
        const pageEvents = state.events.filter((event) => event.seq > cursor)
        let hint = result.domChanged === true ? 'The page DOM changed during this action. Take a fresh snapshot before acting on newly rendered elements.' : undefined
        if (newTabs.length) hint = 'The action opened new tab(s). Continue in the new tab targetId — the operated page did not navigate.'
        if (pageEvents.some((event) => event.kind === 'dialog')) hint = 'A JavaScript dialog opened during this action and was auto-answered (see pageEvents). Verify the resulting state before proceeding.'
        else if (pageEvents.some((event) => event.kind === 'rendererCrash')) hint = 'The renderer crashed during this action. Re-check with a snapshot before retrying.'
        return { ...result, ...(newTabs.length ? { newTabs } : {}), ...(pageEvents.length ? { pageEvents } : {}), ...(hint ? { hint } : {}) }
      } catch (error) {
        const { message, errorDetail } = readRelayError(error)
        if (input.signal?.aborted || !/timeout|timed out|deadline/i.test(`${errorDetail?.code ?? ''} ${message}`)) throw error
        return { ...result, actionPerformed: true, observationComplete: false, warning: { code: 'ACTION_OBSERVATION_TIMEOUT', message: 'The action was performed, but post-action observation timed out. Inspect the page before deciding what to do next; do not repeat the input automatically.' } }
      }
    } finally {
      if (state.eventInvocation === input) state.eventInvocation = previousInvocation
    }
  }

  async navigate(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; url: string; timeoutMs?: number; waitUntil?: string } & PlaywrightInvocation): Promise<{ url: string }> {
    const url = requiredString(input.url, 'url')
    const observationTimeout = input.timeoutMs ?? 10_000
    input = { ...this.session.withInvocationDeadline({ ...input, timeoutMs: undefined }, 120_000), timeoutMs: undefined }
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)
    await this.session.logPageSnapshot('navigate before goto', page, input.targetId)
    this.session.assertInvocationCurrent(input)
    try {
      const result = await this.session.sendPageCdpCommand(input, 'Page.navigate', { url })
      if (result?.errorText) throw new Error(`Navigation failed: ${result.errorText}`)
      const timeout = Math.max(1, Math.min(observationTimeout, this.session.remainingTimeout(input)))
      await this.session.runInvocation(input, async () => {
        try {
          if (input.waitUntil === 'networkidle') await this.session.waitForNetworkIdle({ ...input, timeoutMs: timeout })
          else await page.waitForFunction(input.waitUntil === 'domcontentloaded'
            ? '["interactive", "complete"].includes(document.readyState)'
            : 'document.readyState === "complete"', undefined, { timeout, polling: 100 })
        } catch (error) {
          if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error
        }
      })
      await this.session.logPageSnapshot('navigate after goto', page, input.targetId)
      this.session.assertInvocationCurrent(input)
    } catch (error) {
      await this.session.logPageSnapshot('navigate failed', page, input.targetId, error)
      if (!isDetachedFrameError(error)) throw error

      // Only rebuild the projection on the next independent invocation; goto may have committed.
      await this.session.closeConnections(input.mode).catch(() => {})
      const { message, errorDetail } = readRelayError(error)
      throw relayOperationError(message, 'NAVIGATION_OUTCOME_UNKNOWN', { ...errorDetail, outcome: 'unknown', retryable: false })
    }

    return { url }
  }

  async snapshot(input: {
    cdpUrl: string
    targetId?: string
    mode?: 'relay' | 'direct-cdp'
    selector?: string
    frameSelector?: string
    limit?: number
    maxChars?: number
    timeoutMs?: number
    options?: { interactive?: boolean; compact?: boolean; maxDepth?: number }
    scope?: { frame?: string; landmark?: string; selector?: string }
    filter?: SnapshotFilterOptions
  } & PlaywrightInvocation): Promise<NativeSnapshotResult & { pageUrl: string }> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    const options = {
      selector: input.selector,
      frame: input.frameSelector,
      limit: input.limit,
      maxChars: input.maxChars,
      interactive: input.options?.interactive,
      compact: input.options?.compact,
      depth: input.options?.maxDepth,
      scope: input.scope,
      filter: input.filter as BrowserSnapshotAction["filter"],
    }
    const result = await this.session.withNativeTransport(input, async (transport, owner, actorKey) => {
      const snapshot = await owner.capture(actorKey, options, transport)
      if (!snapshot.degraded || snapshot.source !== 'fused' || snapshot.degradedReason !== 'document_changed' || snapshot.snapshot) return snapshot
      const frames = await transport.frames()
      const scope = await selectSnapshotScope(transport, frames, options)
      const raw = await captureRawRows(transport, frames, scope, options)
      transport.assertCurrent()
      return renderRawSnapshot(raw.rows, options, frames, raw.source, snapshot.degradedReason)
    })
    return { ...result, pageUrl: page.url() }
  }

  async screenshot(input: {
    cdpUrl: string
    targetId?: string
    mode?: 'relay' | 'direct-cdp'
    ref?: string
    element?: string
    fullPage?: boolean
    type?: 'png' | 'jpeg'
    quality?: number
    timeoutMs?: number
    animations?: 'disabled' | 'allow'
    caret?: 'hide' | 'initial'
    scale?: 'css' | 'device'
    omitBackground?: boolean
  } & PlaywrightInvocation): Promise<{ buffer: Buffer; pageUrl: string }> {
    if (input.ref && input.element) throw new Error('ref and element are mutually exclusive')
    input = this.session.withInvocationDeadline(input, 15_000)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)

    const options: Record<string, unknown> = {
      type: input.type ?? 'png',
      timeout: this.session.remainingTimeout(input),
      animations: input.animations ?? 'disabled',
      caret: input.caret ?? 'hide',
      ...(input.scale ? { scale: input.scale } : {}),
      ...(input.omitBackground ? { omitBackground: true } : {}),
      ...(input.type === 'jpeg' && typeof input.quality === 'number' ? { quality: input.quality } : {}),
    }

    if (input.ref) {
      if (input.fullPage) {
        throw new Error('fullPage is not supported for element screenshots')
      }
      return await this.session.withNativeTransport(input, async (transport, owner, actorKey) => {
        const target = await owner.resolve(actorKey, { ref: input.ref }, transport)
        const clip = await screenshotNativeElementClip(target, transport)
        return { buffer: await this.session.runInvocation(input, () => page.screenshot({ ...options, clip })), pageUrl: page.url() }
      })
    }

    if (input.element) {
      if (input.fullPage) {
        throw new Error('fullPage is not supported for element screenshots')
      }
      return { buffer: await this.session.runInvocation(input, () => page.locator(input.element).first().screenshot(options)), pageUrl: page.url() }
    }

    return {
      buffer: await this.session.runInvocation(input, () => page.screenshot({ ...options, fullPage: Boolean(input.fullPage) })),
      pageUrl: page.url(),
    }
  }

  async scroll(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; direction?: string; amount?: number; pace?: boolean } & PlaywrightInvocation): Promise<unknown> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)

    const direction = input.direction ?? 'down'
    if (!['up', 'down', 'left', 'right', 'top', 'bottom'].includes(direction)) throw new Error('Invalid scroll direction')
    const amount = typeof input.amount === 'number' && Number.isFinite(input.amount) ? input.amount : 0
    if (input.pace) await this.session.beforeInput(input)

    return await this.session.runInvocation(input, () => page.evaluate(({ direction, amount }: { direction: string; amount: number }) => {
      const delta = amount > 0 ? amount : Math.round(window.innerHeight * 0.9)
      if (direction === 'up') window.scrollBy(0, -delta)
      else if (direction === 'down') window.scrollBy(0, delta)
      else if (direction === 'left') window.scrollBy(-delta, 0)
      else if (direction === 'right') window.scrollBy(delta, 0)
      else if (direction === 'top') window.scrollTo(0, 0)
      else if (direction === 'bottom') window.scrollTo(0, document.documentElement.scrollHeight)

      return {
        scrollY: Math.round(window.scrollY),
        scrollHeight: document.documentElement.scrollHeight,
        viewportHeight: window.innerHeight,
        atTop: window.scrollY <= 0,
        atBottom: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 1,
        scrollPercentage: Math.round(
          (window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight)) * 100,
        ),
      }
    }, { direction, amount }))
  }

  async evaluate(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; fnBody: string; ref?: string; timeoutMs?: number } & PlaywrightInvocation): Promise<unknown> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)

    const timeoutMs = this.session.remainingTimeout(input)
    const fnBody = requiredString(input.fnBody, 'fn')

    if (input.ref) {
      return await this.session.withNativeTransport(input, async (transport, owner, actorKey) => await evaluateNativeElement(await owner.resolve(actorKey, { ref: input.ref }, transport), fnBody, transport))
    }

    return await this.session.runInvocation(input, () => evaluateFunctionOnPage(page, fnBody, timeoutMs))
  }

  async click(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref?: string; backendNodeId?: number; frameId?: string; selector?: string; x?: number; y?: number; timeoutMs?: number; doubleClick?: boolean; button?: 'left' | 'middle' | 'right'; modifiers?: string[]; delayMs?: number; humanize?: boolean } & PlaywrightInvocation): Promise<{ observedValue?: string; valueKind?: 'value' | 'text'; domChanged?: boolean } | void> {
    input = this.session.withInvocationDeadline(input, 8_000)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)
    const humanize = await this.session.beforeInput(input, input.humanize)

    const x = typeof input.x === 'number' && Number.isFinite(input.x) ? input.x : undefined
    const y = typeof input.y === 'number' && Number.isFinite(input.y) ? input.y : undefined
    if (x !== undefined && y !== undefined) {
      await this.session.runInvocation(input, async () => {
        const modifiers = (input.modifiers ?? []).map((modifier) => modifier === 'ControlOrMeta' ? process.platform === 'darwin' ? 'Meta' : 'Control' : modifier)
        const pressed: string[] = []
        try {
          for (const modifier of modifiers) {
            this.session.assertInvocationCurrent(input)
            await page.keyboard.down(modifier)
            pressed.push(modifier)
          }
          if (humanize) await this.session.withNativeTransport(input, async (transport) => await moveNativePointer({ x, y }, transport, input.modifiers))
          this.session.assertInvocationCurrent(input)
          const delay = input.delayMs ?? (humanize ? 30 + Math.random() * 60 : undefined)
          if (input.doubleClick) await page.mouse.dblclick(x, y, { button: input.button, delay })
          else await page.mouse.click(x, y, { button: input.button, delay })
        } finally {
          for (const modifier of pressed.reverse()) await page.keyboard.up(modifier)
        }
      })
      return
    }

    const selector = input.selector?.trim()
    const ref = input.ref?.trim()

    if (!selector && !ref && input.backendNodeId === undefined) {
      throw new Error('Either ref or selector is required for click')
    }

    if (!selector || input.backendNodeId !== undefined) return await this.actNative(input, { kind: 'click', ref, backendNodeId: input.backendNodeId, frameId: input.frameId, doubleClick: input.doubleClick, button: input.button, modifiers: input.modifiers }, humanize)
    const handle = await this.session.runInvocation(input, () => page.$(selector))
    if (!handle) throw new Error(`Selector "${selector}" did not match any elements on the page.`)
    await this.session.runInvocation(input, () => handle.dispose())
    const locator = page.locator(selector).first()
    const identifier = selector

    this.session.assertInvocationCurrent(input)
    try {
      if (humanize) {
        await this.session.runInvocation(input, () => locator.scrollIntoViewIfNeeded({ timeout: this.session.remainingTimeout(input) }))
        const box = await this.session.runInvocation(input, () => locator.boundingBox({ timeout: this.session.remainingTimeout(input) }))
        if (!box) throw new Error(`Element "${selector}" is not visible.`)
        await this.session.withNativeTransport(input, async (transport) => await moveNativePointer({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, transport, input.modifiers))
      }
      const delay = humanize ? 30 + Math.random() * 60 : undefined
      if (input.doubleClick) {
        await this.session.runInvocation(input, () => locator.dblclick({ timeout: this.session.remainingTimeout(input), button: input.button, modifiers: input.modifiers, delay }))
      } else {
        await this.session.runInvocation(input, () => locator.click({ timeout: this.session.remainingTimeout(input), button: input.button, modifiers: input.modifiers, delay }))
      }
    } catch (error) {
      throw mapLocatorError(error, identifier)
    }
  }

  async type(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref?: string; backendNodeId?: number; frameId?: string; text: string; submit?: boolean; slowly?: boolean; clearFirst?: boolean; timeoutMs?: number } & PlaywrightInvocation): Promise<{ observedValue?: string; valueKind?: 'value' | 'text'; domChanged?: boolean }> {
    input = this.session.withInvocationDeadline(input, 8_000)
    const humanize = await this.session.beforeInput(input)
    return await this.actNative(input, { kind: 'type', ref: input.ref, backendNodeId: input.backendNodeId, frameId: input.frameId, text: input.text, submit: input.submit, slowly: input.slowly, clearFirst: input.clearFirst }, humanize)
  }

  async press(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; key: string; delayMs?: number } & PlaywrightInvocation): Promise<void> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)
    const key = requiredString(input.key, 'key')
    await this.session.beforeInput(input)
    await this.session.runInvocation(input, () => page.keyboard.press(key, {
      delay: Math.max(0, Math.floor(typeof input.delayMs === 'number' ? input.delayMs : 0)),
    }))
  }

  async hover(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref?: string; backendNodeId?: number; frameId?: string; timeoutMs?: number } & PlaywrightInvocation): Promise<{ observedValue?: string; valueKind?: 'value' | 'text'; domChanged?: boolean }> {
    input = this.session.withInvocationDeadline(input, 8_000)
    const humanize = await this.session.beforeInput(input)
    return await this.actNative(input, { kind: "hover", ref: input.ref, backendNodeId: input.backendNodeId, frameId: input.frameId }, humanize)
  }

  async scrollIntoView(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref?: string; backendNodeId?: number; frameId?: string; timeoutMs?: number } & PlaywrightInvocation): Promise<{ observedValue?: string; valueKind?: 'value' | 'text'; domChanged?: boolean }> {
    input = this.session.withInvocationDeadline(input)
    const humanize = await this.session.beforeInput(input)
    return await this.actNative(input, { kind: "scrollIntoView", ref: input.ref, backendNodeId: input.backendNodeId, frameId: input.frameId }, humanize)
  }

  async drag(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; startRef: string; endRef: string; timeoutMs?: number } & PlaywrightInvocation): Promise<{ observedValue?: string; valueKind?: 'value' | 'text'; domChanged?: boolean }> {
    input = this.session.withInvocationDeadline(input, 8_000)
    const humanize = await this.session.beforeInput(input)
    return await this.actNative(input, { kind: "drag", startRef: requiredString(input.startRef, "startRef"), endRef: requiredString(input.endRef, "endRef") }, humanize)
  }

  async select(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref?: string; backendNodeId?: number; frameId?: string; values: string[]; timeoutMs?: number } & PlaywrightInvocation): Promise<{ observedValue?: string; valueKind?: 'value' | 'text'; domChanged?: boolean }> {
    input = this.session.withInvocationDeadline(input, 8_000)
    if (!input.values.length) throw new Error("values are required")
    const humanize = await this.session.beforeInput(input)
    return await this.actNative(input, { kind: "select", ref: input.ref, backendNodeId: input.backendNodeId, frameId: input.frameId, values: input.values }, humanize)
  }

  async fill(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; fields: Array<NativeElementInput & { type: string; value?: string | number | boolean }>; timeoutMs?: number } & PlaywrightInvocation): Promise<{ applied: Array<{ index: number; ref: string; type: string }>; failed: Array<{ index: number; ref: string; type: string; reason: string }> }> {
    input = this.session.withInvocationDeadline(input, 8_000)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)

    const humanize = await this.session.beforeInput(input)
    const applied: Array<{ index: number; ref: string; type: string }> = []
    const failed: Array<{ index: number; ref: string; type: string; reason: string }> = []
    for (const [index, field] of input.fields.entries()) {
      const { ref, type, backendNodeId, frameId } = field
      const receiptRef = backendNodeId !== undefined ? `dom=${backendNodeId}` : ref!
      try {
        this.session.assertInvocationCurrent(input)
        if (type === 'checkbox' || type === 'radio') {
          const checked = field.value === true || field.value === 1 || field.value === '1' || field.value === 'true'
          await this.actNative(input, { kind: 'setChecked', ref, backendNodeId, frameId, checked }, humanize)
        } else {
          const value = field.value === undefined ? '' : String(field.value)
          if (type === 'select') await this.session.beforeInput(input)
          await this.actNative(input, type === 'select' ? { kind: 'select', ref, backendNodeId, frameId, values: [value] } : { kind: 'type', ref, backendNodeId, frameId, text: value }, humanize)
        }
        applied.push({ index, ref: receiptRef, type })
      } catch (caughtError) {
        let error = caughtError
        const receipt = error && typeof error === 'object' ? error as { actionPerformed?: boolean; observationComplete?: boolean } : undefined
        try { this.session.assertInvocationCurrent(input) } catch (currentError) {
          error = Object.assign(currentError instanceof Error ? currentError : new Error(String(currentError)), {
            ...(receipt?.actionPerformed === true ? { actionPerformed: true } : {}),
            ...(receipt?.observationComplete === false ? { observationComplete: false } : {}),
          })
        }
        if (error instanceof NativePageUpdatedError) throw Object.assign(error, { partial: { applied, failed, notPerformed: { index, ref: receiptRef, type } } })
        const { errorDetail } = readRelayError(error)
        if (errorDetail?.outcome === 'unknown' || receipt?.actionPerformed === true) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { ...(applied.length ? { actionPerformed: true } : {}), partial: { applied, failed, unknown: { index, ref: receiptRef, type, ...(receipt?.actionPerformed === true ? { actionPerformed: true, observationComplete: false } : {}) } } })
        failed.push({ index, ref: receiptRef, type, reason: mapLocatorError(error, receiptRef).message })
      }
    }
    return { applied, failed }
  }

  async resize(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; width: number; height: number } & PlaywrightInvocation): Promise<void> {
    if (!Number.isFinite(input.width) || !Number.isFinite(input.height) || input.width <= 0 || input.height <= 0) throw new Error('width and height must be positive numbers')
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)
    await this.session.beforeInput(input)
    await this.session.runInvocation(input, () => page.setViewportSize({
      width: Math.max(1, Math.floor(input.width)),
      height: Math.max(1, Math.floor(input.height)),
    }))
  }

  async waitFor(input: {
    cdpUrl: string
    targetId?: string
    mode?: 'relay' | 'direct-cdp'
    timeoutMs?: number
    timeMs?: number
    text?: string
    textGone?: string
    selector?: string
    url?: string
    loadState?: 'load' | 'domcontentloaded' | 'networkidle'
    fnBody?: string
  } & PlaywrightInvocation): Promise<void> {
    input = this.session.withInvocationDeadline(input, 30_000)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)
    if (typeof input.timeMs === 'number' && Number.isFinite(input.timeMs) && input.timeMs > 0) {
      await this.session.runInvocation(input, () => page.waitForTimeout(input.timeMs))
      return
    }
    if (input.loadState === 'networkidle') {
      await this.session.waitForNetworkIdle(input)
      return
    }
    const predicate = input.loadState
      ? `${input.loadState === 'domcontentloaded' ? '["interactive","complete"]' : '["complete"]'}.includes(document.readyState)`
      : input.text ? `(document.body?.innerText ?? '').includes(${JSON.stringify(input.text)})`
      : input.textGone ? `!(document.body?.innerText ?? '').includes(${JSON.stringify(input.textGone)})`
      : input.selector ? `document.querySelector(${JSON.stringify(input.selector)}) !== null`
      : input.url ? `location.href.includes(${JSON.stringify(input.url)})`
      : input.fnBody ? `!!(${input.fnBody})`
      : undefined
    if (!predicate) throw new Error('wait requires at least one of: timeMs, text, textGone, selector, url, loadState, fn')
    await this.session.runInvocation(input, () => page.waitForFunction(predicate, undefined, { timeout: this.session.remainingTimeout(input), polling: 200 }))
  }

  async closePage(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp' } & PlaywrightInvocation): Promise<void> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    await this.session.runInvocation(input, () => page.close())
  }

  async consoleMessages(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; level?: string } & PlaywrightInvocation): Promise<{ targetId?: string; messages: unknown[] }> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    const state = this.session.ensurePageState(page)
    const level = input.level?.toLowerCase()
    const messages = level ? state.console.filter((entry) => entry.type === level) : [...state.console]
    return { targetId: input.targetId, messages }
  }

  async pageErrors(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; clear?: boolean } & PlaywrightInvocation): Promise<{ targetId?: string; errors: unknown[] }> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    const state = this.session.ensurePageState(page)
    const errors = [...state.errors]
    if (input.clear) {
      state.errors.length = 0
    }
    return { targetId: input.targetId, errors }
  }

  async networkRequests(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; filter?: string; clear?: boolean; last?: number } & PlaywrightInvocation): Promise<{ targetId?: string; requests: unknown[] }> {
    input = this.session.withInvocationDeadline(input)
    return await this.session.executeUtility(input, { kind: 'requests', filter: input.filter, last: input.last, clear: input.clear }) as { targetId?: string; requests: unknown[] }
  }

  async storage(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; storageType: 'local' | 'session'; operation: 'get' | 'set' | 'clear'; key?: string; value?: string } & PlaywrightInvocation): Promise<unknown> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    const storageName: BrowserStorageHandle = input.storageType === 'session' ? 'sessionStorage' : 'localStorage'
    if (input.operation === 'get') {
      if (input.key !== undefined) {
        return await this.session.runInvocation(input, () => page.evaluate(
          ([targetStorage, key]: [BrowserStorageHandle, string]) => window[targetStorage].getItem(key),
          [storageName, input.key],
        ))
      }
      return await this.session.runInvocation(input, () => page.evaluate((targetStorage: BrowserStorageHandle) => {
        const storage = window[targetStorage]
        const result: Record<string, string> = {}
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index)
          if (key !== null) {
            result[key] = storage.getItem(key) ?? ''
          }
        }
        return result
      }, storageName))
    }
    if (input.operation === 'set') {
      if (input.key === undefined) {
        throw new Error('key is required for storage set')
      }
      if (input.value === undefined) throw new Error('value is required for storage set')
      await this.session.runInvocation(input, () => page.evaluate(
        ([targetStorage, key, value]: [BrowserStorageHandle, string, string]) => window[targetStorage].setItem(key, value),
        [storageName, input.key, input.value ?? ''],
      ))
      return { ok: true }
    }
    await this.session.runInvocation(input, () => page.evaluate((targetStorage: BrowserStorageHandle) => window[targetStorage].clear(), storageName))
    return { ok: true }
  }

  async highlight(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref?: string; backendNodeId?: number; frameId?: string; durationMs?: number } & PlaywrightInvocation): Promise<void> {
    input = this.session.withInvocationDeadline(input)
    const durationMs = Math.max(500, Math.min(10_000, typeof input.durationMs === 'number' ? input.durationMs : 2_000))
    await this.session.withNativeTransport(input, async (transport, owner, actorKey) => await highlightNativeElement(await owner.resolve(actorKey, { ref: input.ref, backendNodeId: input.backendNodeId, frameId: input.frameId }, transport), durationMs, transport))
  }

  async setInputFiles(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; paths: string[]; inputRef?: string; element?: string; backendNodeId?: number; frameId?: string } & PlaywrightInvocation): Promise<void> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)
    if (input.inputRef || input.backendNodeId !== undefined) {
      await this.session.withNativeTransport(input, async (transport, owner, actorKey) => await setNativeInputFiles(await owner.resolve(actorKey, { ref: input.inputRef, backendNodeId: input.backendNodeId, frameId: input.frameId }, transport), input.paths, transport))
      return
    }
    if (input.element) {
      await this.session.runInvocation(input, () => page.locator(input.element).first().setInputFiles(input.paths, { timeout: this.session.remainingTimeout(input) }))
      return
    }
    await this.session.runInvocation(input, () => page.locator('input[type=file]').first().setInputFiles(input.paths, { timeout: this.session.remainingTimeout(input) }))
  }

  async armFileChooser(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; timeoutMs?: number; paths: string[] } & PlaywrightInvocation): Promise<{ waitAndSetFiles: () => Promise<void> }> {
    input = this.session.withInvocationDeadline(input, 10_000)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)
    const fileChooser = this.session.runInvocation(input, () => page.waitForEvent('filechooser', { timeout: this.session.remainingTimeout(input) }))
    void fileChooser.catch(() => {})
    return {
      waitAndSetFiles: async () => {
        const chooser = await fileChooser
        const state = this.session.ensurePageState(page)
        state.events.push({ seq: ++state.nextEventSeq, timestamp: new Date().toISOString(), kind: 'fileChooser', multiple: chooser.isMultiple() })
        if (state.events.length > 100) state.events.splice(0, state.events.length - 100)
        this.session.assertInvocationCurrent(input)
        await this.session.runInvocation(input, () => chooser.setFiles(input.paths, { timeout: this.session.remainingTimeout(input) }))
      },
    }
  }

  async armDialog(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; accept?: boolean; promptText?: string } & PlaywrightInvocation): Promise<void> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)
    this.session.ensurePageState(page).dialog = { accept: input.accept === true, ...(input.promptText !== undefined ? { promptText: input.promptText } : {}) }
  }

  async pdf(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp' } & BrowserPdfOptions & PlaywrightInvocation): Promise<{ buffer: Buffer }> {
    input = this.session.withInvocationDeadline(input)
    const page = await this.session.getPageForTargetId(input)
    this.session.assertInvocationCurrent(input)
    this.session.ensurePageState(page)
    const papers = { a3: [11.69, 16.54], a4: [8.27, 11.69], a5: [5.83, 8.27], letter: [8.5, 11], legal: [8.5, 14], tabloid: [11, 17], ledger: [17, 11] }
    const paper = input.paper === undefined ? undefined : papers[input.paper.trim().toLowerCase() as keyof typeof papers]
    if (input.paper !== undefined && !Array.isArray(paper)) throw new Error('Unknown PDF paper size')
    if (input.scale !== undefined && !Number.isFinite(input.scale)) throw new Error('PDF scale must be finite')
    return { buffer: await this.session.runInvocation(input, () => page.pdf({
      printBackground: input.printBackground ?? true,
      ...(input.landscape === true ? { landscape: true } : {}),
      ...(paper ? { width: `${paper[input.landscape ? 1 : 0]}in`, height: `${paper[input.landscape ? 0 : 1]}in` } : {}),
      ...(input.scale === undefined ? {} : { scale: Math.min(2, Math.max(0.1, input.scale)) }),
    })) }
  }
}
