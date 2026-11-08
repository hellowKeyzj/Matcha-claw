import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { NetworkConfiguration } from '../../../src/types/desktop/network-access';
import type { NetworkInvitation } from './provider';
import { ensurePrivateDirectory, readBoundedFile, replacePrivateFile } from '../../utils/private-file';
export interface NetworkState {
  revision: number;
  identity: string;
  config: NetworkConfiguration;
  encryptedSecret: string | null;
}

const DEFAULT_CONFIGURATION: NetworkConfiguration = {
  providerId: 'easytier', enabled: false, autoStart: false, networkName: '',
  listeners: ['tcp://0.0.0.0:11010'], peers: [], defaultProtocol: 'tcp',
  p2p: true, tcpHolePunching: true, udpHolePunching: true, upnp: true, latencyFirst: false,
  foreignNetworkRelay: false, relayNetworkWhitelist: '*', receiveLimitMbps: 0, foreignRelayLimitMbps: 0,
  stunServers: null, stunServersV6: null,
};
const CONFIGURATION_KEYS = Object.keys(DEFAULT_CONFIGURATION);
const PROTOCOLS = ['tcp', 'udp', 'ws', 'wss', 'quic', 'wg'];

export function initialState(): NetworkState {
  return { revision: 0, identity: randomUUID(), encryptedSecret: null, config: structuredClone(DEFAULT_CONFIGURATION) };
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}
const text = (value: unknown, maximum: number) => typeof value === 'string' && value.length <= maximum && [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const port = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0 && (value as number) <= 65535;

function address(value: string, literal = false): string | null {
  const match = /^(\[[^\]]+\]|[^:\s/\\@?#]+):([0-9]+)$/.exec(value);
  if (!match || !port(Number(match[2])) || literal && !isIP(match[1].replace(/^\[|\]$/g, ''))) return null;
  try {
    // Parse the authority once; URL.port omits explicit WS :80 and WSS :443.
    const uri = new URL(`http://${value}`);
    return `${uri.hostname}:${Number(match[2])}`;
  } catch { return null; }
}
function endpoint(value: unknown, listener = false): string | null {
  if (!text(value, 512)) return null;
  const match = /^([a-z]+):\/\/([^/]+)(\/[^?#\\\s]*)?$/i.exec(value as string);
  if (!match) return null;
  const protocol = match[1].toLowerCase();
  if (!PROTOCOLS.includes(protocol) || (listener || protocol !== 'ws' && protocol !== 'wss') && match[3] !== undefined && match[3] !== '/') return null;
  const host = address(match[2], listener);
  return host === null ? null : `${['tcp', 'ws', 'wss'].includes(protocol) ? 'tcp' : 'udp'}://${host}`;
}
function servers(value: unknown): boolean {
  return value === null || Array.isArray(value) && value.length <= 32 && value.every((server) => text(server, 255) && address(server) !== null);
}
export function isConfiguration(value: unknown): value is NetworkConfiguration {
  if (!record(value) || !keys(value, CONFIGURATION_KEYS)
    || !text(value.providerId, 64) || !(value.providerId as string).length
    || !['enabled', 'autoStart', 'p2p', 'tcpHolePunching', 'udpHolePunching', 'upnp', 'latencyFirst', 'foreignNetworkRelay'].every((field) => typeof value[field] === 'boolean')
    || !text(value.networkName, 128) || value.enabled && !(value.networkName as string).trim()
    || !text(value.relayNetworkWhitelist, 512)
    || !PROTOCOLS.includes(value.defaultProtocol as string)
    || !['receiveLimitMbps', 'foreignRelayLimitMbps'].every((field) => Number.isInteger(value[field]) && (value[field] as number) >= 0 && (value[field] as number) <= 1_000_000)
    || !Array.isArray(value.listeners) || value.listeners.length > 32
    || !Array.isArray(value.peers) || value.peers.length > 32
    || !servers(value.stunServers) || !servers(value.stunServersV6)) return false;
  const sockets = new Set<string>();
  return value.listeners.every((listener) => {
    const socket = endpoint(listener, true);
    if (socket === null || sockets.has(socket)) return false;
    sockets.add(socket);
    return true;
  }) && value.peers.every((peer) => endpoint(peer) !== null);
}

export function isNetworkInvitation(value: unknown): value is NetworkInvitation {
  return record(value) && keys(value, ['networkName', 'secret', 'peers'])
    && text(value.networkName, 128) && (value.networkName as string).trim().length > 0
    && validSecret(value.secret) && value.secret.length > 0
    && Array.isArray(value.peers) && value.peers.length <= 32 && value.peers.every((peer) => endpoint(peer) !== null);
}

function upgradeConfiguration(value: unknown): NetworkConfiguration | null {
  if (record(value) && keys(value, [...CONFIGURATION_KEYS, 'deviceName']) && text(value.deviceName, 128)) {
    const { deviceName: _deviceName, ...config } = value;
    return isConfiguration(config) ? config : null;
  }
  if (!record(value) || !keys(value, ['providerId', 'enabled', 'autoStart', 'networkName', 'listenPort', 'peers'])
    || !text(value.providerId, 64) || !(value.providerId as string).length
    || typeof value.enabled !== 'boolean' || typeof value.autoStart !== 'boolean'
    || !text(value.networkName, 128) || !port(value.listenPort)
    || value.enabled && !(value.networkName as string).trim()
    || !Array.isArray(value.peers) || value.peers.length > 32) return null;
  const peers: string[] = [];
  for (const peer of value.peers) {
    if (!text(peer, 512)) return null;
    try {
      const uri = new URL(peer);
      if (uri.protocol !== 'tcp:' || !uri.hostname || !port(Number(uri.port)) || uri.username || uri.password || uri.search || uri.hash || uri.pathname !== '' && uri.pathname !== '/') return null;
      peers.push(`tcp://${uri.host}${uri.pathname}`);
    } catch { return null; }
  }
  const config = {
    ...structuredClone(DEFAULT_CONFIGURATION), providerId: value.providerId as string,
    enabled: value.enabled, autoStart: value.autoStart, networkName: value.networkName as string,
    listeners: [`tcp://0.0.0.0:${value.listenPort}`], peers,
  };
  return isConfiguration(config) ? config : null;
}

export async function loadState(root: string): Promise<NetworkState> {
  let bytes: Buffer;
  try { bytes = await readBoundedFile(join(root, 'config.json'), 128 * 1024); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return initialState();
  }
  await ensurePrivateDirectory(root);
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!record(value) || !keys(value, ['revision', 'identity', 'config', 'encryptedSecret'])
    || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.identity !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.identity)
    || !(value.encryptedSecret === null || typeof value.encryptedSecret === 'string' && value.encryptedSecret.length > 0 && value.encryptedSecret.length < 32 * 1024)) throw new Error('storage-unavailable');
  if (isConfiguration(value.config)) return value as unknown as NetworkState;
  const config = upgradeConfiguration(value.config);
  if (config === null) throw new Error('storage-unavailable');
  const upgraded = { ...value, config } as unknown as NetworkState;
  await saveState(root, upgraded);
  return upgraded;
}
export function validSecret(value: unknown): value is string {
  return text(value, 4096) && Buffer.byteLength(value as string) <= 4096;
}
function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable() || process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') throw new Error('storage-unavailable');
}
export function encryptSecret(value: string): string | null {
  if (!value.length) return null;
  requireEncryption();
  return safeStorage.encryptString(value).toString('base64');
}
export function decryptSecret(value: string): string {
  requireEncryption();
  const result = safeStorage.decryptString(Buffer.from(value, 'base64'));
  if (!validSecret(result) || !result.length) throw new Error('storage-unavailable');
  return result;
}
export async function saveState(root: string, value: NetworkState): Promise<void> {
  await ensurePrivateDirectory(root);
  await replacePrivateFile(join(root, 'config.json'), JSON.stringify(value));
}
