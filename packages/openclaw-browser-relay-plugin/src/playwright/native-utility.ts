import { setTimeout as sleep } from 'node:timers/promises'
import type { BrowserRuntimeSettings, BrowserUtilityRequest } from '../browser-action-contract.js'
import { checkSnapshotFailure, type NativeTransport } from './native-snapshot.js'
import { readRawTree } from './native-snapshot-raw.js'
import { readScripts, readSourceMap } from './native-scripts.js'
import { readSom } from './native-som.js'
import { cleanupEmulation, emulate, type EmulationState } from './native-emulation.js'
import { NativeNetworkCapture } from './native-network.js'
import { NativeInterception } from './native-intercept.js'

type UtilityPage = {
  settings: BrowserRuntimeSettings
  lastActAt: number
  events: Array<Record<string, unknown> & { seq: number; kind: string }>
}

type UtilityHooks = {
  stealth: () => Promise<void>
  waitForLoad: () => Promise<void>
}

export const stealthSource = `(() => {
  try { Object.defineProperty(navigator,'webdriver',{get:()=>undefined}) } catch {}
  try { Object.defineProperty(navigator,'languages',{configurable:true,get:()=>['zh-CN','zh','en']}) } catch {}
  try { const make=name=>({name,filename:'internal-pdf-viewer',description:name,length:1});const arr=[make('Chrome PDF Viewer'),make('Chrome PDF Plugin'),make('Native Client')];arr.item=i=>arr[i];arr.namedItem=n=>arr.find(p=>p.name===n)||null;arr.refresh=()=>{};Object.defineProperty(navigator,'plugins',{get:()=>arr}) } catch {}
  try { const query=navigator.permissions.query.bind(navigator.permissions);navigator.permissions.query=params=>params&&params.name==='notifications'?Promise.resolve({state:Notification.permission}):query(params) } catch {}
  try { window.chrome=window.chrome||{runtime:{}} } catch {}
})()`

export class NativePageUtility {
  readonly network: NativeNetworkCapture
  readonly interception: NativeInterception
  private readonly emulation: EmulationState = { dirty: new Set(), epoch: 0 }
  private readonly configuredSessions = new Set<string>()

  constructor(private readonly transport: NativeTransport, private readonly page: UtilityPage, private readonly hooks: UtilityHooks) {
    this.network = new NativeNetworkCapture(transport)
    this.interception = new NativeInterception(transport)
  }

  initialize(): void {
    this.network.initialize()
  }

  async configureSessions(): Promise<void> {
    const frames = await this.transport.frames()
    for (const sessionId of new Set([undefined, ...frames.filter((frame) => frame.oopif).map((frame) => frame.sessionId)])) {
      const key = sessionId ?? ''
      if (this.configuredSessions.has(key)) continue
      await this.interception.configureSession(sessionId)
      this.configuredSessions.add(key)
    }
  }

  async settle(): Promise<void> {
    const results = await Promise.allSettled([this.network.settle(), this.interception.settle()])
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) {
      const primary = failures[0]
      if (failures.length > 1 && primary && typeof primary === 'object') Object.assign(primary, { errors: failures })
      throw primary
    }
  }

  async beforeInput(humanize?: boolean): Promise<boolean> {
    this.transport.assertCurrent()
    const policy = this.page.settings.pace
    if (policy) {
      const wait = Math.max(0, this.page.lastActAt + policy.minIntervalMs + Math.random() * (policy.jitterMs ?? 0) - Date.now())
      if (wait) await this.pause(wait)
    }
    this.page.lastActAt = Date.now()
    return humanize ?? this.page.settings.humanize ?? false
  }

  async execute(request: BrowserUtilityRequest, captureScreenshot?: () => Promise<string>): Promise<Record<string, unknown>> {
    this.transport.assertCurrent()
    switch (request.kind) {
      case 'frames': {
        const frames = await this.transport.frames()
        return { frames: frames.map((frame) => ({ frameId: frame.id, url: frame.url, ...(frame.parentId ? { parentId: frame.parentId } : {}), ...(frame.name ? { name: frame.name } : {}), oopif: frame.oopif === true })), completeness: 'complete' }
      }
      case 'goBack': case 'goForward': case 'reload': return await this.navigate(request)
      case 'a11yTree': case 'domTree': return await readRawTree(request, this.transport)
      case 'scripts': {
        const scripts = await readScripts(request, this.transport)
        return { scripts, count: scripts.length }
      }
      case 'sourceMap': return await readSourceMap(request, this.transport)
      case 'events': {
        const events = this.page.events.filter((entry) => (!request.filter || entry.kind === request.filter) && (!Number.isFinite(request.since) || entry.seq > request.since!))
        if (request.clear === true) this.page.events.length = 0
        return { events }
      }
      case 'requests': {
        await this.network.settle()
        const requests = this.network.readRequests(request.filter, request.last)
        if (request.clear === true) this.network.clear()
        return { requests }
      }
      case 'har': {
        if (typeof request.savePath !== 'string' || !request.savePath) throw new Error('HAR savePath is required (a .har file inside the workspace)')
        await this.network.settle()
        return this.network.readHar(request.filter, request.last)
      }
      case 'settings': return await this.updateSettings(request.settings)
      case 'som': {
        if (request.screenshot !== false && !captureScreenshot) throw new Error('The browser utility screenshot callback is required')
        return await readSom(request, this.transport, captureScreenshot ?? (() => Promise.reject(new Error('Screenshot was not requested'))))
      }
      case 'intercept': return await this.interception.update(request)
      case 'metrics': {
        const failures: unknown[] = []
        let metrics: unknown[] = []
        try {
          await this.transport.send('Performance.enable')
          const result = await this.transport.send<any>('Performance.getMetrics')
          metrics = (Array.isArray(result?.metrics) ? result.metrics : []).flatMap((entry: any) => {
            if (!entry || typeof entry.name !== 'string') return []
            const value = Number(entry.value)
            return Number.isFinite(value) ? [{ name: entry.name, value }] : []
          })
        } catch (error) { failures.push(error) }
        try { await this.transport.send('Performance.disable') } catch (error) { failures.push(error) }
        if (failures.length > 1) throw new AggregateError(failures, 'Performance observation or cleanup failed', { cause: failures[0] })
        if (failures.length) throw failures[0]
        return { metrics }
      }
      case 'emulate': return await emulate(request, this.transport, this.emulation)
      default: throw new Error(`Utility belongs to its existing action owner: ${request.kind}`)
    }
  }

  private async updateSettings(input: BrowserRuntimeSettings | string | undefined): Promise<Record<string, unknown>> {
    const settings = typeof input === 'string' ? JSON.parse(input) as BrowserRuntimeSettings : input
    if (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings))) throw new Error('settings must be an object')
    if (settings?.stealth !== undefined && (!settings.stealth || typeof settings.stealth !== 'object' || settings.stealth.enabled !== true)) throw new Error('Stealth can only be enabled and remains active until the tab closes')
    if (settings?.pace !== undefined) {
      if (settings.pace === null) delete this.page.settings.pace
      else {
        const minIntervalMs = Math.max(0, Math.floor(settings.pace.minIntervalMs || 0))
        const jitterMs = settings.pace.jitterMs === undefined ? undefined : Math.max(0, Math.floor(settings.pace.jitterMs))
        if (minIntervalMs > 0) this.page.settings.pace = { minIntervalMs, ...(jitterMs === undefined ? {} : { jitterMs }) }
        else delete this.page.settings.pace
      }
    }
    if (settings?.humanize !== undefined) {
      if (settings.humanize === null || settings.humanize === false) delete this.page.settings.humanize
      else this.page.settings.humanize = true
    }
    if (settings?.stealth !== undefined && !this.page.settings.stealth) {
      await this.hooks.stealth()
      this.page.settings.stealth = { enabled: true }
    }
    return { settings: { ...this.page.settings } }
  }

  private async pause(milliseconds: number): Promise<void> {
    const until = Date.now() + milliseconds
    while (Date.now() < until) {
      this.transport.assertCurrent()
      await sleep(Math.min(50, until - Date.now()))
    }
    this.transport.assertCurrent()
  }

  private async navigate(request: Extract<BrowserUtilityRequest, { kind: 'goBack' | 'goForward' | 'reload' }>): Promise<Record<string, unknown>> {
    const started = Date.now()
    type NavigationState = { href: string; timeOrigin: number | null; entryId: string | null }
    const readState = async (): Promise<NavigationState | null> => {
      try {
        const frames = await this.transport.frames()
        const main = frames.find((frame) => !frame.parentId) ?? frames[0]
        if (!main) return null
        const state = await this.transport.evaluate<any>('({href:location.href,timeOrigin:performance.timeOrigin,entryId:window.navigation?.currentEntry?.id??null})', main)
        return state && typeof state === 'object' ? { href: typeof state.href === 'string' ? state.href : '', timeOrigin: typeof state.timeOrigin === 'number' ? state.timeOrigin : null, entryId: typeof state.entryId === 'string' ? state.entryId : null } : null
      } catch (error) {
        checkSnapshotFailure(this.transport, error)
        return null
      }
    }
    let entry: Record<string, any> | undefined
    let history: Record<string, number> | undefined
    if (request.kind === 'reload' && request.ignoreCache !== undefined && typeof request.ignoreCache !== 'boolean') throw new Error('ignoreCache must be a boolean')
    if (request.kind !== 'reload') {
      const current = await this.transport.send<any>('Page.getNavigationHistory')
      const entries = Array.isArray(current.entries) ? current.entries : []
      const currentIndex = typeof current.currentIndex === 'number' ? current.currentIndex : -1
      const index = currentIndex + (request.kind === 'goBack' ? -1 : 1)
      entry = currentIndex < 0 ? undefined : entries[index]
      if (!entry || typeof entry.id !== 'number') throw Object.assign(new Error(`No ${request.kind === 'goBack' ? 'back' : 'forward'} history entry for this tab`), { code: 'IAB_NO_HISTORY_ENTRY' })
      history = { index, size: entries.length }
    }
    const before = await readState()
    if (request.kind === 'reload') await this.transport.send('Page.reload', request.ignoreCache === true ? { ignoreCache: true } : undefined)
    else await this.transport.send('Page.navigateToHistoryEntry', { entryId: entry!.id })
    let after = before
    const expectedUrl = typeof entry?.url === 'string' ? entry.url : ''
    if (before && (request.kind === 'reload' ? before.timeOrigin !== null : expectedUrl !== '')) {
      for (;;) {
        after = await readState()
        if (after && (request.kind === 'reload'
          ? after.timeOrigin !== null && after.timeOrigin !== before.timeOrigin
          : after.href === expectedUrl && (before.entryId !== null && after.entryId !== null ? before.entryId !== after.entryId : before.href !== after.href || before.timeOrigin !== null && after.timeOrigin !== null && before.timeOrigin !== after.timeOrigin))) break
        await this.pause(100)
      }
    }
    await this.hooks.waitForLoad()
    const url = expectedUrl || after?.href || before?.href || ''
    return { source: request.kind === 'reload' ? 'reload' : 'history', url, fromUrl: before?.href ?? '', loadState: 'load', durationMs: Date.now() - started, targetState: { targetId: request.targetId!, url }, ...(request.kind === 'reload' ? request.ignoreCache === true ? { ignoreCache: true } : {} : { direction: request.kind === 'goBack' ? 'back' : 'forward', entry: entry!, history: history! }) }
  }

  async dispose(native = true): Promise<void> {
    const failures: unknown[] = []
    for (const operation of [() => this.interception.dispose(native), () => native ? cleanupEmulation(this.transport, this.emulation) : Promise.resolve(), () => this.network.dispose()]) {
      try { await operation() } catch (error) { failures.push(error) }
    }
    if (!failures.length) {
      delete this.page.settings.pace
      delete this.page.settings.humanize
    }
    if (failures.length > 1) throw new AggregateError(failures, 'Browser page utility cleanup failed', { cause: failures[0] })
    if (failures.length) throw failures[0]
  }
}
