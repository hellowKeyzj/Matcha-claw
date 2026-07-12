export type RemoteFleetConsoleSelectionKind =
  | 'connection'
  | 'environment'
  | 'managedResource'
  | 'node'
  | 'agent'
  | 'runtime'
  | 'endpoint';

export interface RemoteFleetConsoleSelection {
  readonly kind: RemoteFleetConsoleSelectionKind | null;
  readonly id: string | null;
}

export type RemoteFleetPageMode = 'resources' | 'operations';

export type RemoteFleetResourceType =
  | 'connections'
  | 'environments'
  | 'managedResources'
  | 'nodes'
  | 'agents'
  | 'runtimes'
  | 'endpoints';

export type RemoteFleetDetailTab =
  | 'overview'
  | 'terminal'
  | 'commands'
  | 'audit'
  | 'capabilities';

export type RemoteFleetWorkspaceLayout = 'wide' | 'compact' | 'single';
