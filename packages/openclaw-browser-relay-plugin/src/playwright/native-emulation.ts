import type { BrowserUtilityRequest } from '../browser-action-contract.js'
import type { NativeTransport } from './native-snapshot.js'

export type EmulationState = { dirty: Set<string>; epoch: number }

type Request = Extract<BrowserUtilityRequest, { kind: 'emulate' }>
type Device = { name: string; width: number; height: number; deviceScaleFactor: number; mobile: boolean; hasTouch?: boolean; userAgent?: string }
const devices: Record<string, Device> = {
  'iPhone 14': { name: 'iPhone 14', width: 390, height: 844, deviceScaleFactor: 3, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iPhone 14 Pro Max': { name: 'iPhone 14 Pro Max', width: 430, height: 932, deviceScaleFactor: 3, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iPad Pro 11': { name: 'iPad Pro 11', width: 834, height: 1194, deviceScaleFactor: 2, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'Pixel 7': { name: 'Pixel 7', width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
  'Galaxy S23': { name: 'Galaxy S23', width: 360, height: 780, deviceScaleFactor: 3, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
}
const networks: Record<string, Record<string, unknown>> = {
  Offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'Slow 3G': { offline: false, latency: 2000, downloadThroughput: 50 * 1024 / 8, uploadThroughput: 50 * 1024 / 8 },
  'Fast 3G': { offline: false, latency: 562.5, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
  '4G': { offline: false, latency: 170, downloadThroughput: 9 * 1024 * 1024 / 8, uploadThroughput: 1.5 * 1024 * 1024 / 8 },
  WiFi: { offline: false, latency: 28, downloadThroughput: 30 * 1024 * 1024 / 8, uploadThroughput: 15 * 1024 * 1024 / 8 },
}

const resetCommands: Record<string, { method: string; params?: Record<string, unknown> }> = {
  locale: { method: 'Emulation.setLocaleOverride', params: { locale: '' } },
  userAgent: { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
  deviceMetrics: { method: 'Emulation.clearDeviceMetricsOverride' },
  touch: { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
  timezone: { method: 'Emulation.setTimezoneOverride', params: { timezoneId: '' } },
  geolocation: { method: 'Emulation.clearGeolocationOverride' },
  colorScheme: { method: 'Emulation.setEmulatedMedia', params: { features: [] } },
  network: { method: 'Network.emulateNetworkConditions', params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } },
  cpu: { method: 'Emulation.setCPUThrottlingRate', params: { rate: 1 } },
}

async function resetEmulation(transport: NativeTransport, state: EmulationState, keys: string[]): Promise<void> {
  const epoch = state.epoch
  const failures: unknown[] = []
  for (const key of keys) {
    if (!state.dirty.has(key)) continue
    const command = resetCommands[key]
    try {
      await transport.send(command.method, command.params)
      if (state.epoch === epoch) state.dirty.delete(key)
    } catch (error) { failures.push(error) }
  }
  if (failures.length > 1) throw new AggregateError(failures, 'Browser emulation cleanup failed', { cause: failures[0] })
  if (failures.length) throw failures[0]
}

export async function cleanupEmulation(transport: NativeTransport, state: EmulationState): Promise<void> {
  await resetEmulation(transport, state, Object.keys(resetCommands))
}

export async function emulate(request: Request, transport: NativeTransport, state: EmulationState): Promise<Record<string, unknown>> {
  const clear = request.clear === true && ['device', 'timezone', 'geolocation', 'network', 'cpu'].includes(request.action)
  if (clear) {
    await resetEmulation(transport, state, request.action === 'device' ? ['deviceMetrics', 'touch', 'userAgent'] : [request.action])
    return { action: request.action, cleared: true }
  }
  switch (request.action) {
    case 'device': {
      const device = typeof request.device === 'string' ? Object.hasOwn(devices, request.device) ? devices[request.device] : undefined : request.device
      if (!device || typeof device !== 'object' || Array.isArray(device)) throw new Error(`Unknown device "${request.device}". Available: ${Object.keys(devices).join(', ')}`)
      const descriptor = device as Device
      state.dirty.add('deviceMetrics')
      await transport.send('Emulation.setDeviceMetricsOverride', { width: descriptor.width, height: descriptor.height, deviceScaleFactor: descriptor.deviceScaleFactor, mobile: descriptor.mobile })
      if (descriptor.userAgent) {
        state.dirty.add('userAgent')
        await transport.send('Emulation.setUserAgentOverride', { userAgent: descriptor.userAgent })
      }
      if (descriptor.hasTouch) {
        state.dirty.add('touch')
        await transport.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      }
      break
    }
    case 'timezone':
      if (!request.timezoneId?.trim()) throw new Error('timezoneId is required')
      state.dirty.add('timezone')
      await transport.send('Emulation.setTimezoneOverride', { timezoneId: request.timezoneId })
      break
    case 'locale': {
      if (!request.locale?.trim()) throw new Error('locale is required')
      const response = await transport.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true })
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Locale setup failed')
      state.dirty.add('userAgent')
      await transport.send('Emulation.setUserAgentOverride', { userAgent: typeof response.result?.value === 'string' ? response.result.value : '', acceptLanguage: request.locale })
      state.dirty.add('locale')
      await transport.send('Emulation.setLocaleOverride', { locale: request.locale })
      break
    }
    case 'geolocation':
      if (!Number.isFinite(request.latitude) || !Number.isFinite(request.longitude)) throw new Error('Numeric latitude and longitude are required')
      state.dirty.add('geolocation')
      await transport.send('Emulation.setGeolocationOverride', { latitude: request.latitude, longitude: request.longitude, accuracy: Number.isFinite(request.accuracy) ? request.accuracy : 100 })
      break
    case 'colorScheme':
      if (!['light', 'dark'].includes(request.scheme ?? '')) throw new Error('Color scheme must be light or dark')
      state.dirty.add('colorScheme')
      await transport.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: request.scheme }] })
      break
    case 'userAgent':
      if (!request.userAgent?.trim()) throw new Error('userAgent is required')
      state.dirty.add('userAgent')
      await transport.send('Emulation.setUserAgentOverride', { userAgent: request.userAgent })
      break
    case 'network': {
      const preset = typeof request.preset === 'string' ? Object.hasOwn(networks, request.preset) ? networks[request.preset] : undefined : request.preset
      if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw new Error(`Unknown network preset "${request.preset}". Available: ${Object.keys(networks).join(', ')}`)
      state.dirty.add('network')
      await transport.send('Network.emulateNetworkConditions', { ...preset })
      break
    }
    case 'cpu':
      if (!Number.isFinite(request.rate)) throw new Error('Numeric CPU slowdown rate is required')
      state.dirty.add('cpu')
      await transport.send('Emulation.setCPUThrottlingRate', { rate: Math.max(1, Math.min(20, Math.round(request.rate!))) })
      break
  }
  return { action: request.action, applied: true }
}
