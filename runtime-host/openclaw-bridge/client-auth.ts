import { join } from 'node:path';
import {
  buildDeviceAuthPayloadV3,
  type DeviceIdentity,
} from '../shared/device-identity';
import type {
  GatewayDeviceCryptoPort,
  GatewayDeviceIdentityRepositoryPort,
} from './client-auth-ports';
import type { RuntimeClockPort, RuntimePlatform } from '../application/common/runtime-ports';

export const DEFAULT_GATEWAY_OPERATOR_SCOPES = [
  'operator.read',
  'operator.write',
  'operator.admin',
  'operator.approvals',
] as const;

const GATEWAY_PROTOCOL_VERSION = 4;
const GATEWAY_CLIENT_ID = 'gateway-client';
const GATEWAY_CLIENT_VERSION = '0.1.0';
const GATEWAY_CLIENT_MODE = 'backend';
const GATEWAY_CLIENT_DEVICE_FAMILY = 'desktop';
const GATEWAY_CLIENT_DISPLAY_NAME = 'MatchaClaw Runtime Host';
const GATEWAY_CLIENT_CAPS = ['tool-events'] as const;

export interface GatewayAuthContext {
  readonly runtimeHostDataDir: string;
  readonly readGatewayToken: () => Promise<string>;
  readonly platform: RuntimePlatform;
  readonly identityRepository: GatewayDeviceIdentityRepositoryPort;
  readonly crypto: GatewayDeviceCryptoPort;
  readonly clock: RuntimeClockPort;
}

export function parseGatewayPort(rawPort: string): number {
  const fromEnv = Number.parseInt(rawPort, 10);
  if (!Number.isFinite(fromEnv) || fromEnv <= 0) {
    throw new Error(`Invalid runtime-host gateway port: ${rawPort}`);
  }
  return fromEnv;
}

export class GatewayAuthService {
  private gatewayDeviceIdentityCache: DeviceIdentity | null = null;

  constructor(private readonly context: GatewayAuthContext) {}

  async buildGatewayConnectRequest(connectId: string, challengeNonce: string) {
    const gatewayToken = await this.context.readGatewayToken();
    const signedAtMs = this.context.clock.nowMs();
    const deviceIdentity = await this.loadGatewayDeviceIdentity();
    const devicePayload = buildDeviceAuthPayloadV3({
      deviceId: deviceIdentity.deviceId,
      clientId: GATEWAY_CLIENT_ID,
      clientMode: GATEWAY_CLIENT_MODE,
      role: 'operator',
      scopes: [...DEFAULT_GATEWAY_OPERATOR_SCOPES],
      signedAtMs,
      token: gatewayToken || null,
      nonce: challengeNonce,
      platform: this.context.platform,
      deviceFamily: GATEWAY_CLIENT_DEVICE_FAMILY,
    });
    const deviceSignature = this.context.crypto.signDevicePayload(deviceIdentity.privateKeyPem, devicePayload);

    return {
      type: 'req',
      id: connectId,
      method: 'connect',
      params: {
        minProtocol: GATEWAY_PROTOCOL_VERSION,
        maxProtocol: GATEWAY_PROTOCOL_VERSION,
        client: {
          id: GATEWAY_CLIENT_ID,
          displayName: GATEWAY_CLIENT_DISPLAY_NAME,
          version: GATEWAY_CLIENT_VERSION,
          platform: this.context.platform,
          mode: GATEWAY_CLIENT_MODE,
          deviceFamily: GATEWAY_CLIENT_DEVICE_FAMILY,
        },
        ...(gatewayToken ? { auth: { token: gatewayToken } } : {}),
        caps: [...GATEWAY_CLIENT_CAPS],
        role: 'operator',
        scopes: [...DEFAULT_GATEWAY_OPERATOR_SCOPES],
        device: {
          id: deviceIdentity.deviceId,
          publicKey: this.context.crypto.publicKeyRawBase64UrlFromPem(deviceIdentity.publicKeyPem),
          signature: deviceSignature,
          signedAt: signedAtMs,
          nonce: challengeNonce,
        },
      },
    };
  }

  private async loadGatewayDeviceIdentity(): Promise<DeviceIdentity> {
    if (this.gatewayDeviceIdentityCache) {
      return this.gatewayDeviceIdentityCache;
    }
    this.gatewayDeviceIdentityCache = await this.context.identityRepository.loadOrCreateDeviceIdentity(
      join(this.context.runtimeHostDataDir, 'identity', 'device.json'),
    );
    return this.gatewayDeviceIdentityCache;
  }
}
