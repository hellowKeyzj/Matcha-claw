import type { PlaywrightSession } from './session.js'
import { parseRoleSnapshot, type RoleRef } from './role-refs.js'
import { filterSnapshot, type SnapshotFilterOptions } from './snapshot-filter.js'
import { PageBlankError, ScopeEmptyError, ScopeFrameMultiMatchError } from './snapshot-errors.js'
import { stabilizeRefs, computeRefDiff } from './snapshot-diff.js'

const LANDMARK_SELECTORS: Record<string, string> = {
  main: 'main, [role="main"]',
  nav: 'nav, [role="navigation"]',
  form: 'form, [role="form"]',
  search: '[role="search"]',
  aside: 'aside, [role="complementary"]',
  header: 'header, [role="banner"]',
  footer: 'footer, [role="contentinfo"]',
}

function landmarkToSelector(landmark: string): string {
  return LANDMARK_SELECTORS[landmark] ?? landmark
}

type BrowserStorageHandle = 'localStorage' | 'sessionStorage'

function requiredString(value: unknown, field: string): string {
  const normalized = typeof value === 'string' ? value.trim() : ''
  if (!normalized) {
    throw new Error(`${field} is required`)
  }
  return normalized
}

function withTimeout(timeoutMs: unknown, fallback: number): number {
  return Math.max(500, Math.min(120_000, typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : fallback))
}

function isDetachedFrameError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('Frame has been detached') || message.includes('frame was detached')
}

function mapLocatorError(error: unknown, ref: string): Error {
  const message = error instanceof Error ? error.message : String(error)
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

  async navigate(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; url: string; timeoutMs?: number; waitUntil?: string }): Promise<{ url: string }> {
    const url = requiredString(input.url, 'url')
    let page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    await this.session.logPageSnapshot('navigate before goto', page, input.targetId)
    try {
      await page.goto(url, {
        timeout: withTimeout(input.timeoutMs, 20_000),
        waitUntil: input.waitUntil ?? 'domcontentloaded',
      })
      await this.session.logPageSnapshot('navigate after goto', page, input.targetId)
    } catch (error) {
      await this.session.logPageSnapshot('navigate failed', page, input.targetId, error)
      if (!isDetachedFrameError(error)) {
        throw error
      }

      await this.session.closeConnections(input.mode)
      page = await this.session.getPageForTargetId(input)
      this.session.ensurePageState(page)
      await this.session.logPageSnapshot('navigate retry before goto', page, input.targetId)
      try {
        await page.goto(url, {
          timeout: withTimeout(input.timeoutMs, 20_000),
          waitUntil: input.waitUntil ?? 'domcontentloaded',
        })
        await this.session.logPageSnapshot('navigate retry after goto', page, input.targetId)
      } catch (retryError) {
        await this.session.logPageSnapshot('navigate retry failed', page, input.targetId, retryError)
        throw retryError
      }
    }

    // Navigation invalidates previous snapshot diff baseline
    this.session.clearPrevSnapshotState(input.cdpUrl, input.targetId)

    return { url: page.url() }
  }

  async snapshot(input: {
    cdpUrl: string
    targetId?: string
    mode?: 'relay' | 'direct-cdp'
    selector?: string
    frameSelector?: string
    timeoutMs?: number
    options?: { interactive?: boolean; compact?: boolean; maxDepth?: number }
    scope?: { frame?: string; landmark?: string; selector?: string }
    filter?: SnapshotFilterOptions
  }): Promise<{
    snapshot: string
    refs: Record<string, RoleRef>
    stats: { lines: number; chars: number; refs: number; interactive: number }
    pageUrl: string
    totalCount?: number
    matchedCount?: number
    returnedCount?: number
    truncated?: boolean
    sparse?: boolean
    refRange?: { min: string; max: string }
    diff?: string
  }> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)

    // Resolve scope (frame → landmark/selector → locator root)
    const scope = input.scope
    const frameSelector = scope?.frame?.trim() || input.frameSelector?.trim() || ''
    const landmark = scope?.landmark?.trim() || ''
    const scopeSelector = scope?.selector?.trim() || input.selector?.trim() || ''

    let pageRoot: any = page
    if (frameSelector) {
      const frameLocator = page.locator(frameSelector)
      const frameCount = await frameLocator.count()
      if (frameCount === 0) {
        throw new ScopeEmptyError('frame_not_found', `scope.frame ${JSON.stringify(frameSelector)} matched 0 iframes.`)
      }
      if (frameCount > 1) {
        throw new ScopeFrameMultiMatchError(frameSelector, frameCount)
      }
      pageRoot = page.frameLocator(frameSelector)
    }

    const resolvedSelector = landmark ? landmarkToSelector(landmark) : scopeSelector
    let locator: any
    if (resolvedSelector) {
      locator = frameSelector
        ? pageRoot.locator(resolvedSelector)
        : page.locator(resolvedSelector)
      const count = await locator.count()
      if (count === 0) {
        throw new ScopeEmptyError(
          landmark ? 'landmark_not_found' : 'selector_no_match',
          `scope ${landmark ? `landmark=${landmark}` : `selector=${JSON.stringify(scopeSelector)}`} matched 0 elements.`,
        )
      }
    } else {
      locator = frameSelector ? pageRoot.locator(':root') : page.locator(':root')
    }

    const ariaSnapshot = await locator.ariaSnapshot({ timeout: withTimeout(input.timeoutMs, 20_000) })
    const ariaText = String(ariaSnapshot ?? '')

    // Detect blank page
    if (!ariaText.trim()) {
      throw new PageBlankError()
    }

    const parsed = parseRoleSnapshot(ariaText, input.options)

    // Apply ref stability: reuse previous ref IDs for unchanged elements
    const prevState = this.session.getPrevSnapshotState(input.cdpUrl, input.targetId)
    const stabilized = stabilizeRefs({
      currentRefs: parsed.refs,
      currentSnapshot: parsed.snapshot,
      currentLineMeta: parsed.lineMeta,
      prevRefs: prevState?.refs,
      prevMaxCounter: prevState?.maxRefCounter,
    })

    // Store current state for next diff
    this.session.updatePrevSnapshotState(input.cdpUrl, input.targetId, stabilized.refs, stabilized.nextMaxCounter)

    this.session.rememberRoleRefs({
      page,
      cdpUrl: input.cdpUrl,
      targetId: input.targetId,
      refs: stabilized.refs,
      frameSelector: frameSelector || undefined,
      mode: 'role',
    })

    // Compute diff if we have previous state
    let diffText: string | undefined
    if (prevState && stabilized.keptRefs.length > 0) {
      const diffResult = computeRefDiff({
        prevRefs: prevState.refs,
        currentRefs: stabilized.refs,
        currentLineMeta: stabilized.lineMeta,
        currentSnapshot: stabilized.snapshot,
      })
      if (diffResult.kind === 'DIFF') {
        diffText = diffResult.diffText
      }
    }

    // Apply filter if provided
    const filter = input.filter
    if (filter && (filter.keywords?.length || filter.roles?.length)) {
      const filterResult = filterSnapshot(stabilized.lineMeta, filter)
      if (filterResult === null) {
        return {
          snapshot: stabilized.snapshot,
          refs: stabilized.refs,
          stats: parsed.stats,
          pageUrl: page.url(),
          totalCount: Object.keys(stabilized.refs).length,
          matchedCount: 0,
          returnedCount: Object.keys(stabilized.refs).length,
          truncated: false,
          sparse: false,
          ...(diffText ? { diff: diffText } : {}),
        }
      }
      return {
        snapshot: filterResult.prunedSnapshot,
        refs: stabilized.refs,
        stats: parsed.stats,
        pageUrl: page.url(),
        totalCount: Object.keys(stabilized.refs).length,
        matchedCount: filterResult.matchedCount,
        returnedCount: filterResult.returnedCount,
        truncated: filterResult.truncated,
        sparse: filterResult.sparse,
        refRange: filterResult.refRange,
        ...(diffText ? { diff: diffText } : {}),
      }
    }

    // Use diff output if available and shorter than full snapshot
    const finalSnapshot = diffText ?? stabilized.snapshot

    return {
      snapshot: finalSnapshot,
      refs: stabilized.refs,
      stats: parsed.stats,
      pageUrl: page.url(),
      totalCount: Object.keys(stabilized.refs).length,
      matchedCount: Object.keys(stabilized.refs).length,
      returnedCount: Object.keys(stabilized.refs).length,
      truncated: false,
      sparse: false,
    }
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
  }): Promise<{ buffer: Buffer; pageUrl: string }> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })

    const options: Record<string, unknown> = {
      type: input.type ?? 'png',
      timeout: withTimeout(input.timeoutMs, 15_000),
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
      const locator = this.session.refLocator(page, input.ref)
      return { buffer: await locator.screenshot(options), pageUrl: page.url() }
    }

    if (input.element) {
      if (input.fullPage) {
        throw new Error('fullPage is not supported for element screenshots')
      }
      return { buffer: await page.locator(input.element).first().screenshot(options), pageUrl: page.url() }
    }

    return {
      buffer: await page.screenshot({ ...options, fullPage: Boolean(input.fullPage) }),
      pageUrl: page.url(),
    }
  }

  async scroll(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; direction?: string; amount?: number }): Promise<unknown> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)

    const direction = input.direction ?? 'down'
    const amount = typeof input.amount === 'number' && Number.isFinite(input.amount) ? input.amount : 0

    return await page.evaluate(({ direction, amount }: { direction: string; amount: number }) => {
      const delta = amount > 0 ? amount : window.innerHeight * 0.75
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
    }, { direction, amount })
  }

  async evaluate(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; fnBody: string; ref?: string; timeoutMs?: number }): Promise<unknown> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })

    const timeoutMs = withTimeout(input.timeoutMs, 20_000)
    const fnBody = requiredString(input.fnBody, 'fn')

    if (input.ref) {
      const locator = this.session.refLocator(page, input.ref)
      const evaluator = new Function(
        'element',
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
          const result = typeof candidate === "function" ? candidate(element) : candidate;
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
      return await locator.evaluate(evaluator, { fnBody, timeoutMs })
    }

    return await evaluateFunctionOnPage(page, fnBody, timeoutMs)
  }

  async click(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref?: string; selector?: string; timeoutMs?: number; doubleClick?: boolean; button?: 'left' | 'middle' | 'right'; modifiers?: string[] }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)

    const selector = input.selector?.trim()
    const ref = input.ref?.trim()

    if (!selector && !ref) {
      throw new Error('Either ref or selector is required for click')
    }

    let locator: any
    let identifier: string

    if (selector) {
      // Selector path: verify element exists, then build locator
      const handle = await page.$(selector)
      if (!handle) {
        throw new Error(`Selector "${selector}" did not match any elements on the page.`)
      }
      await handle.dispose()
      locator = page.locator(selector).first()
      identifier = selector
    } else {
      // Ref path: restore role refs and resolve locator
      this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })
      locator = this.session.refLocator(page, ref!)
      identifier = ref!
    }

    const timeout = withTimeout(input.timeoutMs, 8_000)
    try {
      if (input.doubleClick) {
        await locator.dblclick({ timeout, button: input.button, modifiers: input.modifiers })
      } else {
        await locator.click({ timeout, button: input.button, modifiers: input.modifiers })
      }
    } catch (error) {
      throw mapLocatorError(error, identifier)
    }
  }

  async type(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref: string; text: string; submit?: boolean; slowly?: boolean; clearFirst?: boolean; timeoutMs?: number }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })

    const ref = requiredString(input.ref, 'ref')
    const text = typeof input.text === 'string' ? input.text : ''
    const locator = this.session.refLocator(page, ref)
    const timeout = withTimeout(input.timeoutMs, 8_000)

    try {
      if (input.slowly) {
        await locator.click({ timeout })
        if (input.clearFirst !== false) {
          await locator.fill('', { timeout })
        }
        await locator.pressSequentially(text, { timeout, delay: 75 })
      } else if (input.clearFirst === false) {
        await locator.click({ timeout })
        await locator.pressSequentially(text, { timeout })
      } else {
        await locator.fill(text, { timeout })
      }

      if (input.submit) {
        await locator.press('Enter', { timeout })
      }
    } catch (error) {
      throw mapLocatorError(error, ref)
    }
  }

  async press(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; key: string; delayMs?: number }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    await page.keyboard.press(requiredString(input.key, 'key'), {
      delay: Math.max(0, Math.floor(typeof input.delayMs === 'number' ? input.delayMs : 0)),
    })
  }

  async hover(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref: string; timeoutMs?: number }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })
    const ref = requiredString(input.ref, 'ref')
    try {
      await this.session.refLocator(page, ref).hover({ timeout: withTimeout(input.timeoutMs, 8_000) })
    } catch (error) {
      throw mapLocatorError(error, ref)
    }
  }

  async scrollIntoView(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref: string; timeoutMs?: number }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })
    const ref = requiredString(input.ref, 'ref')
    try {
      await this.session.refLocator(page, ref).scrollIntoViewIfNeeded({ timeout: withTimeout(input.timeoutMs, 20_000) })
    } catch (error) {
      throw mapLocatorError(error, ref)
    }
  }

  async drag(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; startRef: string; endRef: string; timeoutMs?: number }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })
    const startRef = requiredString(input.startRef, 'startRef')
    const endRef = requiredString(input.endRef, 'endRef')
    try {
      await this.session.refLocator(page, startRef).dragTo(this.session.refLocator(page, endRef), {
        timeout: withTimeout(input.timeoutMs, 8_000),
      })
    } catch (error) {
      throw mapLocatorError(error, `${startRef} -> ${endRef}`)
    }
  }

  async select(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref: string; values: string[]; timeoutMs?: number }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })
    const ref = requiredString(input.ref, 'ref')
    if (!input.values.length) {
      throw new Error('values are required')
    }
    try {
      await this.session.refLocator(page, ref).selectOption(input.values, { timeout: withTimeout(input.timeoutMs, 8_000) })
    } catch (error) {
      throw mapLocatorError(error, ref)
    }
  }

  async fill(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; fields: Array<{ ref: string; type: string; value?: string | number | boolean }>; timeoutMs?: number }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })

    const timeout = withTimeout(input.timeoutMs, 8_000)
    for (const field of input.fields) {
      const ref = field.ref.trim()
      const type = field.type.trim()
      if (!ref || !type) continue

      const locator = this.session.refLocator(page, ref)
      if (type === 'checkbox' || type === 'radio') {
        const checked = field.value === true || field.value === 1 || field.value === '1' || field.value === 'true'
        try {
          await locator.setChecked(checked, { timeout })
        } catch (error) {
          throw mapLocatorError(error, ref)
        }
        continue
      }

      const value =
        typeof field.value === 'string'
          ? field.value
          : typeof field.value === 'number' || typeof field.value === 'boolean'
            ? String(field.value)
            : ''
      try {
        await locator.fill(value, { timeout })
      } catch (error) {
        throw mapLocatorError(error, ref)
      }
    }
  }

  async resize(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; width: number; height: number }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    await page.setViewportSize({
      width: Math.max(1, Math.floor(input.width)),
      height: Math.max(1, Math.floor(input.height)),
    })
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
  }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    const timeout = withTimeout(input.timeoutMs, 20_000)

    if (typeof input.timeMs === 'number' && Number.isFinite(input.timeMs)) {
      await page.waitForTimeout(Math.max(0, input.timeMs))
    }
    if (input.text) {
      await page.getByText(input.text).first().waitFor({ state: 'visible', timeout })
    }
    if (input.textGone) {
      await page.getByText(input.textGone).first().waitFor({ state: 'hidden', timeout })
    }
    if (input.selector?.trim()) {
      await page.locator(input.selector.trim()).first().waitFor({ state: 'visible', timeout })
    }
    if (input.url?.trim()) {
      await page.waitForURL(input.url.trim(), { timeout })
    }
    if (input.loadState) {
      await page.waitForLoadState(input.loadState, { timeout })
    }
    if (input.fnBody?.trim()) {
      await page.waitForFunction(input.fnBody.trim(), { timeout })
    }
  }

  async closePage(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp' }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    await page.close()
  }

  async consoleMessages(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; level?: string }): Promise<{ targetId?: string; messages: unknown[] }> {
    const page = await this.session.getPageForTargetId(input)
    const state = this.session.ensurePageState(page)
    const level = input.level?.toLowerCase()
    const messages = level ? state.console.filter((entry) => entry.type === level) : [...state.console]
    return { targetId: input.targetId, messages }
  }

  async pageErrors(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; clear?: boolean }): Promise<{ targetId?: string; errors: unknown[] }> {
    const page = await this.session.getPageForTargetId(input)
    const state = this.session.ensurePageState(page)
    const errors = [...state.errors]
    if (input.clear) {
      state.errors.length = 0
    }
    return { targetId: input.targetId, errors }
  }

  async networkRequests(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; filter?: string; clear?: boolean }): Promise<{ targetId?: string; requests: unknown[] }> {
    const page = await this.session.getPageForTargetId(input)
    const state = this.session.ensurePageState(page)
    const filter = input.filter?.toLowerCase()
    const requests = filter
      ? state.requests.filter((entry) => entry.url.toLowerCase().includes(filter))
      : [...state.requests]
    if (input.clear) {
      state.requests.length = 0
    }
    return { targetId: input.targetId, requests }
  }

  async storage(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; storageType: 'local' | 'session'; operation: 'get' | 'set' | 'clear'; key?: string; value?: string }): Promise<unknown> {
    const page = await this.session.getPageForTargetId(input)
    const storageName: BrowserStorageHandle = input.storageType === 'session' ? 'sessionStorage' : 'localStorage'
    if (input.operation === 'get') {
      if (input.key) {
        return await page.evaluate(
          ([targetStorage, key]: [BrowserStorageHandle, string]) => window[targetStorage].getItem(key),
          [storageName, input.key],
        )
      }
      return await page.evaluate((targetStorage: BrowserStorageHandle) => {
        const storage = window[targetStorage]
        const result: Record<string, string> = {}
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index)
          if (key !== null) {
            result[key] = storage.getItem(key) ?? ''
          }
        }
        return result
      }, storageName)
    }
    if (input.operation === 'set') {
      if (!input.key) {
        throw new Error('key is required for storage set')
      }
      await page.evaluate(
        ([targetStorage, key, value]: [BrowserStorageHandle, string, string]) => window[targetStorage].setItem(key, value),
        [storageName, input.key, input.value ?? ''],
      )
      return { ok: true }
    }
    await page.evaluate((targetStorage: BrowserStorageHandle) => window[targetStorage].clear(), storageName)
    return { ok: true }
  }

  async highlight(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; ref: string; durationMs?: number }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })
    const ref = requiredString(input.ref, 'ref')
    const locator = this.session.refLocator(page, ref)
    const durationMs = Math.max(500, Math.min(10_000, typeof input.durationMs === 'number' ? input.durationMs : 2_000))
    await locator.evaluate((element: HTMLElement, delay: number) => {
      const previous = element.style.cssText
      element.style.outline = '3px solid #FF4500'
      element.style.outlineOffset = '2px'
      setTimeout(() => {
        element.style.cssText = previous
      }, delay)
    }, durationMs)
  }

  async setInputFiles(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; paths: string[]; inputRef?: string; element?: string }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    this.session.restoreRoleRefs({ cdpUrl: input.cdpUrl, targetId: input.targetId, page })
    if (input.inputRef) {
      await this.session.refLocator(page, input.inputRef).setInputFiles(input.paths)
      return
    }
    if (input.element) {
      await page.locator(input.element).first().setInputFiles(input.paths)
      return
    }
    await page.locator('input[type=file]').first().setInputFiles(input.paths)
  }

  async armFileChooser(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; timeoutMs?: number; paths: string[] }): Promise<{ waitAndSetFiles: () => Promise<void> }> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    const fileChooser = page.waitForEvent('filechooser', { timeout: withTimeout(input.timeoutMs, 10_000) })
    return {
      async waitAndSetFiles() {
        const chooser = await fileChooser
        await chooser.setFiles(input.paths)
      },
    }
  }

  async armDialog(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp'; accept?: boolean; promptText?: string }): Promise<void> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    page.once('dialog', async (dialog: any) => {
      if (input.accept) {
        await dialog.accept(input.promptText)
      } else {
        await dialog.dismiss()
      }
    })
  }

  async pdf(input: { cdpUrl: string; targetId?: string; mode?: 'relay' | 'direct-cdp' }): Promise<{ buffer: Buffer }> {
    const page = await this.session.getPageForTargetId(input)
    this.session.ensurePageState(page)
    return { buffer: await page.pdf({ printBackground: true }) }
  }
}
