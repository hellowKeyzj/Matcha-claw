import { applyLaunchAtStartupSetting } from './launch-at-startup';
import type { RuntimeHostDeliveryIssuer } from '../runtime-host-delivery/issuer';
import {
  createSettingsDesiredClient,
  PROJECTION_UNAVAILABLE,
  type SettingsBrowserMode,
  type SettingsDesiredProjectionResponse,
  type SettingsDesiredReceipt,
  type SettingsDesiredTransport,
  type SettingsDesiredTransportResponse,
} from '../runtime-host-delivery/products/settings/desired';
import { createCallLogTransport } from '../runtime-host-delivery/transport/call-log';
import { hasExactKeys, isRecord, isSafeInteger } from '../runtime-host-delivery/transport/client';

export function createSettingsDesiredTransport(
  issuer: RuntimeHostDeliveryIssuer,
  port: number,
  fetcher: typeof fetch = fetch,
  onBrowserModeChanging?: (mode: SettingsBrowserMode) => (accepted: boolean) => void,
): SettingsDesiredTransport {
  const client = createSettingsDesiredClient(issuer, port, fetcher);
  const callLog = createCallLogTransport(issuer, port, fetcher);
  return {
    ...client,
    async submit(request) {
      const end = onBrowserModeChanging?.(request.input.browserMode);
      let response: SettingsDesiredTransportResponse | undefined;
      try {
        response = await client.submit(request);
        return response;
      } finally {
        end?.(response?.status === 202);
      }
    },
    async project(callId): Promise<SettingsDesiredProjectionResponse> {
      try {
        const result = await callLog.get({ callId });
        if (result.status !== 200 || !('module' in result.body)) {
          return { status: 503, body: PROJECTION_UNAVAILABLE };
        }
        const call = result.body;
        if (call.module !== 'settings' || call.command !== 'settings.replace'
          || call.status !== 'succeeded' || call.detail.operation !== 'replaceDesired'
          || call.detail.settlement?.outcome !== 'confirmed'
          || typeof call.detail.launchAtStartup !== 'boolean') {
          return { status: 503, body: PROJECTION_UNAVAILABLE };
        }
        const receipt = { desired: call.detail.settlement };
        if (!isReceipt(receipt) || !(await applyLaunchAtStartupSetting(call.detail.launchAtStartup))) {
          return { status: 503, body: PROJECTION_UNAVAILABLE };
        }
        return { status: 200, body: receipt };
      } catch {
        return { status: 503, body: PROJECTION_UNAVAILABLE };
      }
    },
  };
}

function isReceipt(value: unknown): value is SettingsDesiredReceipt {
  if (!isRecord(value) || !hasExactKeys(value, ['desired']) || !isRecord(value.desired)) return false;
  return hasExactKeys(value.desired, ['revision', 'outcome'])
    && isSafeInteger(value.desired.revision)
    && value.desired.revision > 0
    && (value.desired.outcome === 'confirmed' || value.desired.outcome === 'outcome_unknown');
}
