export type NetworkProtocol = 'tcp' | 'udp' | 'ws' | 'wss' | 'quic' | 'wg';

export interface NetworkConfiguration {
  providerId: string;
  enabled: boolean;
  autoStart: boolean;
  networkName: string;
  listeners: string[];
  peers: string[];
  defaultProtocol: NetworkProtocol;
  p2p: boolean;
  tcpHolePunching: boolean;
  udpHolePunching: boolean;
  upnp: boolean;
  latencyFirst: boolean;
  foreignNetworkRelay: boolean;
  relayNetworkWhitelist: string;
  receiveLimitMbps: number;
  foreignRelayLimitMbps: number;
  stunServers: string[] | null;
  stunServersV6: string[] | null;
}

export interface NetworkRuntime {
  nodeId: string;
  listeners: string[];
  peerCount: number;
  peers: { nodeId: string; name: string }[];
}

export interface NetworkSnapshot {
  revision: number;
  providers: { id: string; name: string; available: boolean }[];
  config: NetworkConfiguration;
  hasSecret: boolean;
  phase: 'stopped' | 'starting' | 'running' | 'failed';
  error: NetworkErrorCode | null;
  runtime: NetworkRuntime | null;
}

export type NetworkErrorCode = 'invalid-request' | 'conflict' | 'network-change-required' | 'component-missing' | 'start-failed' | 'stop-failed' | 'storage-unavailable' | 'security-blocked' | 'unavailable';
export type NetworkRequest =
  | { kind: 'configure'; expectedRevision: number; config: NetworkConfiguration; secret?: string }
  | { kind: 'start' }
  | { kind: 'stop' };
