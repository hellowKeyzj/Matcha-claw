import type { DeviceIdentity } from '../shared/device-identity';

export interface GatewayDeviceIdentityRepositoryPort {
  loadOrCreateDeviceIdentity(filePath: string): Promise<DeviceIdentity>;
}

export interface GatewayDeviceCryptoPort {
  signDevicePayload(privateKeyPem: string, payload: string): string;
  publicKeyRawBase64UrlFromPem(publicKeyPem: string): string;
}
