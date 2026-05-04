import type { SessionRenderRow } from '../../../runtime-host/shared/session-adapter-types';
import type { ChatSessionRecord, ToolStatus } from './types';

export interface AssistantTurnLaneIdentity {
  turnKey: string | null;
  laneKey: string | null;
  agentId: string | null;
}

export interface SessionAssistantTurnLaneState {
  laneKey: string;
  turnKey: string;
  agentId: string | null;
  row: SessionRenderRow;
  toolStatuses: ToolStatus[];
}

export interface SessionAssistantTurnSnapshot {
  turnKey: string;
  lanes: SessionAssistantTurnLaneState[];
  latestRow: SessionRenderRow;
  latestStreamingRow: SessionRenderRow | null;
}

export interface SessionAssistantTurnState {
  turns: SessionAssistantTurnSnapshot[];
  activeTurn: SessionAssistantTurnSnapshot | null;
  activeTurnKey: string | null;
  currentTurn: SessionRenderRow | null;
  currentStreamingTurn: SessionRenderRow | null;
  lanes: SessionAssistantTurnLaneState[];
}

function normalizeIdentifier(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isAssistantLaneRow(row: SessionRenderRow): boolean {
  return row.role === 'assistant'
    && Boolean(normalizeIdentifier(row.assistantTurnKey))
    && Boolean(normalizeIdentifier(row.assistantLaneKey));
}

export function resolveAssistantEntryLaneIdentity(row: SessionRenderRow): AssistantTurnLaneIdentity {
  return {
    turnKey: normalizeIdentifier(row.assistantTurnKey) || null,
    laneKey: normalizeIdentifier(row.assistantLaneKey) || null,
    agentId: normalizeIdentifier(row.assistantLaneAgentId ?? row.agentId) || null,
  };
}

function readRowToolStatuses(row: SessionRenderRow): ToolStatus[] {
  if (row.kind === 'message' || row.kind === 'tool-activity') {
    return row.toolStatuses.map((toolStatus) => ({
      id: toolStatus.id,
      toolCallId: toolStatus.toolCallId,
      name: toolStatus.name,
      status: toolStatus.status,
      durationMs: toolStatus.durationMs,
      summary: toolStatus.summary,
      updatedAt: toolStatus.updatedAt ?? 0,
    }));
  }
  return [];
}

function collectAssistantTurns(rows: SessionRenderRow[]): SessionAssistantTurnSnapshot[] {
  interface MutableTurnSnapshot {
    turnKey: string;
    latestRow: SessionRenderRow;
    latestStreamingRow: SessionRenderRow | null;
    lanesByKey: Map<string, SessionAssistantTurnLaneState>;
  }

  const turns: MutableTurnSnapshot[] = [];
  const turnIndexByKey = new Map<string, number>();

  for (const row of rows) {
    if (!isAssistantLaneRow(row)) {
      continue;
    }
    const laneIdentity = resolveAssistantEntryLaneIdentity(row);
    if (!laneIdentity.turnKey || !laneIdentity.laneKey) {
      continue;
    }

    let turn = (() => {
      const existingIndex = turnIndexByKey.get(laneIdentity.turnKey);
      return existingIndex != null ? turns[existingIndex] : undefined;
    })();
    if (!turn) {
      turn = {
        turnKey: laneIdentity.turnKey,
        latestRow: row,
        latestStreamingRow: row.kind === 'message' && row.isStreaming ? row : null,
        lanesByKey: new Map<string, SessionAssistantTurnLaneState>(),
      };
      turnIndexByKey.set(laneIdentity.turnKey, turns.length);
      turns.push(turn);
    }

    turn.latestRow = row;
    if (row.kind === 'message' && row.isStreaming) {
      turn.latestStreamingRow = row;
    }
    turn.lanesByKey.set(laneIdentity.laneKey, {
      laneKey: laneIdentity.laneKey,
      turnKey: laneIdentity.turnKey,
      agentId: laneIdentity.agentId,
      row,
      toolStatuses: readRowToolStatuses(row),
    });
  }

  return turns.map((turn) => ({
    turnKey: turn.turnKey,
    lanes: Array.from(turn.lanesByKey.values()),
    latestRow: turn.latestRow,
    latestStreamingRow: turn.latestStreamingRow,
  }));
}

function findCurrentStreamingTurn(
  rows: SessionRenderRow[],
  streamingMessageId: string | null | undefined,
): SessionRenderRow | null {
  const normalizedStreamingMessageId = normalizeIdentifier(streamingMessageId);
  if (normalizedStreamingMessageId) {
    const matched = rows.find((row) => row.rowId === normalizedStreamingMessageId);
    if (matched) {
      return matched;
    }
  }
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind === 'message' && row.role === 'assistant' && row.isStreaming) {
      return row;
    }
  }
  return null;
}

export function readSessionAssistantTurnState(
  session: Pick<ChatSessionRecord, 'rows' | 'runtime'>,
): SessionAssistantTurnState {
  const rows = Array.isArray(session.rows) ? session.rows : [];
  const currentStreamingTurn = findCurrentStreamingTurn(
    rows,
    session.runtime.streamingMessageId,
  );
  const turns = collectAssistantTurns(rows);
  const activeTurnKey = currentStreamingTurn
    ? resolveAssistantEntryLaneIdentity(currentStreamingTurn).turnKey
    : (turns[turns.length - 1]?.turnKey ?? null);
  const activeTurn = activeTurnKey
    ? turns.find((turn) => turn.turnKey === activeTurnKey) ?? null
    : null;
  const lanes = activeTurn?.lanes ?? [];
  return {
    turns,
    activeTurn,
    activeTurnKey,
    currentTurn: currentStreamingTurn ?? activeTurn?.latestRow ?? null,
    currentStreamingTurn,
    lanes,
  };
}
