import type { NetworkConfiguration, NetworkErrorCode, NetworkRuntime } from '../../../src/types/desktop/network-access';
export type ReceiveNetworkRequest = (request: object, signal: AbortSignal) => Promise<object>;

// Private invitation material; never part of a public network snapshot.
export interface NetworkInvitation {
  networkName: string;
  secret: string;
  peers: string[];
}

export interface NetworkConnection {
  /** Resolves only when the provider has actually stopped. */
  readonly closed: Promise<void>;
  read(): Promise<NetworkRuntime>;
  exchange(nodeId: string, request: object, signal?: AbortSignal): Promise<object>;
  close(): Promise<void>;
}

export interface NetworkProvider {
  readonly id: string;
  readonly name: string;
  readonly unavailableReason?: NetworkErrorCode;
  available(): Promise<boolean>;
  close(): Promise<void>;
  start(input: {
    root: string;
    identity: string;
    config: NetworkConfiguration;
    secret: string;
    hostName: string;
    receive: ReceiveNetworkRequest;
  }): Promise<NetworkConnection>;
}
