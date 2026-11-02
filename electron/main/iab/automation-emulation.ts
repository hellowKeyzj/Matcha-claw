import type { BrowserUtilityRequest } from '../../../packages/openclaw-browser-relay-plugin/src/browser-action-contract';
import type { IabJsonObject } from '../../../src/types/desktop/iab';
import type { IabAutomationPage, Operation } from './automation-page';
import { iabError } from './error';

type Request = Extract<BrowserUtilityRequest, { kind: 'emulate' }>;
type Device = { name: string; width: number; height: number; deviceScaleFactor: number; mobile: boolean; hasTouch?: boolean; userAgent?: string };
const devices: Record<string, Device> = {
  'iPhone 14': { name: 'iPhone 14', width: 390, height: 844, deviceScaleFactor: 3, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iPhone 14 Pro Max': { name: 'iPhone 14 Pro Max', width: 430, height: 932, deviceScaleFactor: 3, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'iPad Pro 11': { name: 'iPad Pro 11', width: 834, height: 1194, deviceScaleFactor: 2, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1' },
  'Pixel 7': { name: 'Pixel 7', width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
  'Galaxy S23': { name: 'Galaxy S23', width: 360, height: 780, deviceScaleFactor: 3, mobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36' },
};
const networks: Record<string, IabJsonObject> = {
  Offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'Slow 3G': { offline: false, latency: 2000, downloadThroughput: 50 * 1024 / 8, uploadThroughput: 50 * 1024 / 8 },
  'Fast 3G': { offline: false, latency: 562.5, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 },
  '4G': { offline: false, latency: 170, downloadThroughput: 9 * 1024 * 1024 / 8, uploadThroughput: 1.5 * 1024 * 1024 / 8 },
  WiFi: { offline: false, latency: 28, downloadThroughput: 30 * 1024 * 1024 / 8, uploadThroughput: 15 * 1024 * 1024 / 8 },
};

export const emulationResetCommands: Record<string, { method: string; params?: IabJsonObject }> = {
  locale: { method: 'Emulation.setLocaleOverride', params: { locale: '' } },
  userAgent: { method: 'Emulation.setUserAgentOverride', params: { userAgent: '' } },
  deviceMetrics: { method: 'Emulation.clearDeviceMetricsOverride' },
  touch: { method: 'Emulation.setTouchEmulationEnabled', params: { enabled: false } },
  timezone: { method: 'Emulation.setTimezoneOverride', params: { timezoneId: '' } },
  geolocation: { method: 'Emulation.clearGeolocationOverride' },
  colorScheme: { method: 'Emulation.setEmulatedMedia', params: { features: [] } },
  network: { method: 'Network.emulateNetworkConditions', params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } },
  cpu: { method: 'Emulation.setCPUThrottlingRate', params: { rate: 1 } },
};
const states = new WeakMap<IabAutomationPage, { dirty: Set<string>; epoch: number }>();

export function resetEmulation(page: IabAutomationPage): void {
  const state = states.get(page);
  if (state) { state.dirty.clear(); state.epoch++; }
}

export async function cleanupEmulation(page: IabAutomationPage, operation: Operation): Promise<void> {
  const state = states.get(page);
  if (!state) return;
  let failure: unknown;
  for (const [key, command] of Object.entries(emulationResetCommands)) {
    if (!state.dirty.has(key)) continue;
    try { await page.send(command.method, command.params, operation); state.dirty.delete(key); }
    catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
}

export async function emulate(page: IabAutomationPage, request: Request, operation: Operation): Promise<IabJsonObject> {
  let state = states.get(page);
  if (!state) { state = { dirty: new Set(), epoch: 0 }; states.set(page, state); }
  const epoch = state.epoch;
  const clear = request.clear === true && ['device', 'timezone', 'geolocation', 'network', 'cpu'].includes(request.action);
  switch (request.action) {
    case 'device': {
      if (clear) {
        await page.send('Emulation.clearDeviceMetricsOverride', undefined, operation);
        await page.send('Emulation.setTouchEmulationEnabled', { enabled: false }, operation);
        await page.send('Emulation.setUserAgentOverride', { userAgent: '' }, operation);
        break;
      }
      const device = typeof request.device === 'string' ? Object.hasOwn(devices, request.device) ? devices[request.device] : undefined : request.device;
      if (!device || typeof device !== 'object' || Array.isArray(device)) throw iabError('IAB_DEVICE_INVALID', `Unknown device "${request.device}". Available: ${Object.keys(devices).join(', ')}`);
      const descriptor = device as Device;
      state.dirty.add('deviceMetrics');
      if (descriptor.userAgent) state.dirty.add('userAgent');
      if (descriptor.hasTouch) state.dirty.add('touch');
      await page.send('Emulation.setDeviceMetricsOverride', { width: descriptor.width, height: descriptor.height, deviceScaleFactor: descriptor.deviceScaleFactor, mobile: descriptor.mobile }, operation);
      if (descriptor.userAgent) await page.send('Emulation.setUserAgentOverride', { userAgent: descriptor.userAgent }, operation);
      if (descriptor.hasTouch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true }, operation);
      break;
    }
    case 'timezone':
      if (!clear && !request.timezoneId?.trim()) throw iabError('IAB_TIMEZONE_REQUIRED', 'timezoneId is required');
      if (!clear) state.dirty.add('timezone');
      await page.send('Emulation.setTimezoneOverride', { timezoneId: clear ? '' : request.timezoneId! }, operation);
      break;
    case 'locale': {
      if (!request.locale?.trim()) throw iabError('IAB_LOCALE_REQUIRED', 'locale is required');
      state.dirty.add('locale'); state.dirty.add('userAgent');
      const response = await page.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }, operation);
      if (response.exceptionDetails) throw iabError('IAB_EVALUATION_FAILED', response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? 'Locale setup failed');
      await page.send('Emulation.setUserAgentOverride', { userAgent: typeof response.result?.value === 'string' ? response.result.value : '', acceptLanguage: request.locale }, operation);
      await page.send('Emulation.setLocaleOverride', { locale: request.locale }, operation);
      break;
    }
    case 'geolocation':
      if (clear) await page.send('Emulation.clearGeolocationOverride', undefined, operation);
      else {
        if (!Number.isFinite(request.latitude) || !Number.isFinite(request.longitude)) throw iabError('IAB_GEOLOCATION_INVALID', 'Numeric latitude and longitude are required');
        state.dirty.add('geolocation');
        await page.send('Emulation.setGeolocationOverride', { latitude: request.latitude!, longitude: request.longitude!, accuracy: Number.isFinite(request.accuracy) ? request.accuracy! : 100 }, operation);
      }
      break;
    case 'colorScheme':
      if (!['light', 'dark'].includes(request.scheme ?? '')) throw iabError('IAB_COLOR_SCHEME_REQUIRED', 'Color scheme must be light or dark');
      state.dirty.add('colorScheme');
      await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: request.scheme! }] }, operation);
      break;
    case 'userAgent':
      if (!request.userAgent?.trim()) throw iabError('IAB_USER_AGENT_REQUIRED', 'userAgent is required');
      state.dirty.add('userAgent');
      await page.send('Emulation.setUserAgentOverride', { userAgent: request.userAgent }, operation);
      break;
    case 'network': {
      const preset = clear ? { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 } : typeof request.preset === 'string' ? Object.hasOwn(networks, request.preset) ? networks[request.preset] : undefined : request.preset;
      if (!preset || typeof preset !== 'object' || Array.isArray(preset)) throw iabError('IAB_NETWORK_PRESET_INVALID', `Unknown network preset "${request.preset}". Available: ${Object.keys(networks).join(', ')}`);
      if (!clear) state.dirty.add('network');
      await page.send('Network.emulateNetworkConditions', { ...preset } as IabJsonObject, operation);
      break;
    }
    case 'cpu':
      if (!clear && !Number.isFinite(request.rate)) throw iabError('IAB_CPU_RATE_INVALID', 'Numeric CPU slowdown rate is required');
      if (!clear) state.dirty.add('cpu');
      await page.send('Emulation.setCPUThrottlingRate', { rate: clear ? 1 : Math.max(1, Math.min(20, Math.round(request.rate!))) }, operation);
      break;
  }
  if (clear && state.epoch === epoch) {
    for (const key of request.action === 'device' ? ['deviceMetrics', 'touch', 'userAgent'] : [request.action]) state.dirty.delete(key);
  }
  return { action: request.action, ...(clear ? { cleared: true } : { applied: true }) };
}
