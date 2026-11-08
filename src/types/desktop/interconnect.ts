export type SharedFolderOperation = 'list' | 'read' | 'write';

export interface SharedCapability {
  sourceId: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  presentation?: {
    kind: 'runtime' | 'plugin' | 'agent' | 'wiki' | 'folder';
    targetId: string;
    targetName: string;
    operation: string;
  };
}

export interface RemoteCapability extends SharedCapability {
  resourceId: string;
}

export interface PairedClient {
  id: string;
  name: string;
  hostId: string;
  memberId: string;
  phase: 'invited' | 'paired';
}

export interface ClientInvitation {
  id: string;
  name: string;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

export interface InterconnectSnapshot {
  clients: PairedClient[];
  invitations: ClientInvitation[];
  capabilities: SharedCapability[];
}

export interface ConnectionPreview {
  alreadyPaired: boolean;
  hostName: string;
  networkName: string;
  currentNetworkName: string | null;
  networkRevision: number;
  replaceNetwork: boolean;
}

export type InterconnectCommand =
  | { kind: 'clients.refresh' }
  | { kind: 'invite'; name: string; maxUses: number; hostName: string; expectedRevision: number }
  | { kind: 'invitation.revoke'; invitationId: string }
  | { kind: 'connect.preview'; invitation: string }
  | { kind: 'connect'; invitation: string; hostName: string; expectedRevision: number; expectedNetworkRevision: number; replaceNetwork: boolean }
  | { kind: 'disconnect'; clientId: string }
  | { kind: 'share'; sourceId: string; expectedRevision: number }
  | { kind: 'share.folder'; name: string; path: string; operations: SharedFolderOperation[]; expectedRevision: number };

export interface InterconnectEnvelope {
  kind: 'interconnect';
  pairId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface InterconnectJoinEnvelope extends InterconnectEnvelope {
  invitationId: string;
  publicKey: string;
}

export interface CapabilityCall {
  clientId: string;
  resourceId: string;
  sourceId: string;
  arguments: Record<string, unknown>;
}

export type CapabilityCallReceipt =
  | { phase: 'accepted'; callId: string }
  | { phase: 'running'; callId: string }
  | { phase: 'completed'; callId: string; result: unknown }
  | { phase: 'failed'; callId: string; error: string }
  | { phase: 'unknown'; callId: string };

export interface InterconnectFailure {
  success: false;
  error: string;
}

export type InterconnectReply<T> = T | InterconnectFailure;

export type InterconnectRemoteRequest =
  | { kind: 'hello'; hostId: string; name: string }
  | { kind: 'discover'; hostId: string; epoch: string }
  | { kind: 'invoke'; hostId: string; epoch: string; callId: string; resourceId: string; sourceId: string; arguments: Record<string, unknown> }
  | { kind: 'result'; hostId: string; epoch: string; callId: string };
