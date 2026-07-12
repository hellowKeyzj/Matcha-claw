import type { RemoteFleetRuntimeClockPort } from '../remote-fleet-runtime';

export class SystemRemoteFleetRuntimeClock implements RemoteFleetRuntimeClockPort {
  nowIso(): string {
    return new Date().toISOString();
  }
}
