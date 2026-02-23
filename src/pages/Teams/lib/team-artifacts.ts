import type { TeamReport } from '@/types/team';
import type { TeamFlowEvent } from '@/types/team';

interface IpcResult<T> {
  success: boolean;
  result?: T;
  error?: string;
}

interface TeamFsBaseInput {
  teamId: string;
  controllerId: string;
  workspaceByAgent: Record<string, string>;
}

interface TeamFsTaskInput extends TeamFsBaseInput {
  taskId: string;
  agentId: string;
}

export interface TeamArtifactsLayout {
  teamId: string;
  controllerId: string;
  canonicalRoot: string;
  mirrorRootByAgent: Record<string, string>;
  indexPath: string;
}

export interface TeamTaskArtifactPaths {
  taskId: string;
  agentId: string;
  canonicalTaskRoot: string;
  canonicalAgentDir: string;
  canonicalSharedDir: string;
  memberAgentDir: string;
  memberSharedDir: string;
  indexPath: string;
}

export interface DeleteTeamArtifactsLayoutResult {
  teamId: string;
  canonicalRoot: string;
  removedPaths: string[];
  missingPaths: string[];
}

export interface TeamFlowExportResult {
  teamId: string;
  canonicalRoot: string;
  auditPath: string;
  fileName: string;
}

export interface PublishTeamTaskArtifactsInput extends TeamFsTaskInput {
  runId?: string;
  status: string;
  rawText?: string;
  error?: string;
  report?: TeamReport | null;
}

async function invokeIpc<T>(channel: string, payload: unknown): Promise<T> {
  const response = await window.electron.ipcRenderer.invoke(channel, payload) as IpcResult<T> | T;
  if (response && typeof response === 'object' && 'success' in response) {
    const wrapped = response as IpcResult<T>;
    if (!wrapped.success) {
      throw new Error(wrapped.error || `IPC failed: ${channel}`);
    }
    return wrapped.result as T;
  }
  return response as T;
}

export async function initTeamArtifactsLayout(input: TeamFsBaseInput): Promise<TeamArtifactsLayout> {
  return invokeIpc<TeamArtifactsLayout>('teamfs:initLayout', input);
}

export async function prepareTeamTaskArtifacts(input: TeamFsTaskInput): Promise<TeamTaskArtifactPaths> {
  return invokeIpc<TeamTaskArtifactPaths>('teamfs:prepareTask', input);
}

export async function publishTeamTaskArtifacts(input: PublishTeamTaskArtifactsInput): Promise<void> {
  await invokeIpc('teamfs:publishTask', input);
}

export async function publishTeamSharedArtifact(input: TeamFsTaskInput & {
  fileName: string;
  content: string;
}): Promise<void> {
  await invokeIpc('teamfs:publishShared', input);
}

export async function syncTeamMemberProjection(input: TeamFsBaseInput & {
  memberId: string;
}): Promise<void> {
  await invokeIpc('teamfs:syncMemberProjection', input);
}

export async function deleteTeamArtifactsLayout(input: TeamFsBaseInput): Promise<DeleteTeamArtifactsLayoutResult> {
  return invokeIpc<DeleteTeamArtifactsLayoutResult>('teamfs:deleteLayout', input);
}

export async function exportTeamFlowEvents(input: TeamFsBaseInput & {
  flowEvents: TeamFlowEvent[];
  teamName?: string;
  phase?: string;
}): Promise<TeamFlowExportResult> {
  return invokeIpc<TeamFlowExportResult>('teamfs:exportFlowEvents', input);
}
