import { readTimelineEntryToolStatuses } from './event-helpers';
import { resolveSessionTimelineEntries } from './store-state-helpers';
import type { ChatSessionRecord, ToolStatus } from './types';
import type { SessionTimelineEntry } from '../../../runtime-host/shared/session-adapter-types';

export interface AssistantTurnLaneIdentity {
  turnKey: string | null;
  laneKey: string | null;
  agentId: string | null;
}

export interface SessionAssistantTurnLaneState {
  laneKey: string;
  turnKey: string;
  agentId: string | null;
  entry: SessionTimelineEntry;
  toolStatuses: ToolStatus[];
}

export interface SessionAssistantTurnSnapshot {
  turnKey: string;
  lanes: SessionAssistantTurnLaneState[];
  latestEntry: SessionTimelineEntry;
  latestStreamingEntry: SessionTimelineEntry | null;
}

export interface SessionAssistantTurnState {
  turns: SessionAssistantTurnSnapshot[];
  activeTurn: SessionAssistantTurnSnapshot | null;
  activeTurnKey: string | null;
  currentTurn: SessionTimelineEntry | null;
  currentStreamingTurn: SessionTimelineEntry | null;
  lanes: SessionAssistantTurnLaneState[];
}

function normalizeIdentifier(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : '';
}

function findCurrentStreamingTurn(
  entries: SessionTimelineEntry[],
  streamingMessageId: string | null | undefined,
): SessionTimelineEntry | null {
  const normalizedStreamingMessageId = normalizeIdentifier(streamingMessageId);
  if (normalizedStreamingMessageId) {
    const matched = entries.find((entry) => entry.entryId === normalizedStreamingMessageId);
    if (matched) {
      return matched;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role === 'assistant' && entry.status === 'streaming') {
      return entry;
    }
  }
  return null;
}

export function resolveAssistantEntryLaneIdentity(entry: SessionTimelineEntry): AssistantTurnLaneIdentity {
  const agentId = normalizeIdentifier(entry.agentId ?? entry.message.agentId) || null;
  return {
    turnKey: normalizeIdentifier(entry.turnKey) || null,
    laneKey: normalizeIdentifier(entry.laneKey) || null,
    agentId,
  };
}

function collectAssistantTurns(
  entries: SessionTimelineEntry[],
): SessionAssistantTurnSnapshot[] {
  interface MutableTurnSnapshot {
    turnKey: string;
    latestEntry: SessionTimelineEntry;
    latestStreamingEntry: SessionTimelineEntry | null;
    lanesByKey: Map<string, SessionAssistantTurnLaneState>;
  }

  const turns: MutableTurnSnapshot[] = [];
  const turnIndexByKey = new Map<string, number>();

  for (const entry of entries) {
    if (entry.role !== 'assistant') {
      continue;
    }
    const laneIdentity = resolveAssistantEntryLaneIdentity(entry);
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
        latestEntry: entry,
        latestStreamingEntry: entry.status === 'streaming' ? entry : null,
        lanesByKey: new Map<string, SessionAssistantTurnLaneState>(),
      };
      turnIndexByKey.set(laneIdentity.turnKey, turns.length);
      turns.push(turn);
    }

    turn.latestEntry = entry;
    if (entry.status === 'streaming') {
      turn.latestStreamingEntry = entry;
    }
    turn.lanesByKey.set(laneIdentity.laneKey, {
      laneKey: laneIdentity.laneKey,
      turnKey: laneIdentity.turnKey,
      agentId: laneIdentity.agentId,
      entry,
      toolStatuses: readTimelineEntryToolStatuses(entry),
    });
  }

  return turns.map((turn) => ({
    turnKey: turn.turnKey,
    lanes: Array.from(turn.lanesByKey.values()),
    latestEntry: turn.latestEntry,
    latestStreamingEntry: turn.latestStreamingEntry,
  }));
}

function findActiveAssistantTurn(
  turns: SessionAssistantTurnSnapshot[],
  currentStreamingTurn: SessionTimelineEntry | null,
): SessionAssistantTurnSnapshot | null {
  const currentStreamingTurnKey = currentStreamingTurn
    ? resolveAssistantEntryLaneIdentity(currentStreamingTurn).turnKey
    : null;
  if (currentStreamingTurnKey) {
    return turns.find((turn) => turn.turnKey === currentStreamingTurnKey) ?? null;
  }
  return turns[turns.length - 1] ?? null;
}

export function readSessionAssistantTurnState(
  session: Pick<ChatSessionRecord, 'timelineEntries' | 'runtime'>,
): SessionAssistantTurnState {
  const entries = resolveSessionTimelineEntries(session as ChatSessionRecord);
  const currentStreamingTurn = findCurrentStreamingTurn(
    entries,
    session.runtime.streamingMessageId,
  );
  const turns = collectAssistantTurns(entries);
  const activeTurn = findActiveAssistantTurn(turns, currentStreamingTurn);
  const activeTurnKey = activeTurn?.turnKey ?? null;
  const lanes = activeTurn?.lanes ?? [];
  return {
    turns,
    activeTurn,
    activeTurnKey,
    currentTurn: currentStreamingTurn ?? activeTurn?.latestEntry ?? null,
    currentStreamingTurn,
    lanes,
  };
}

export function consumeSessionAssistantTurn(
  session: Pick<ChatSessionRecord, 'timelineEntries' | 'runtime'>,
  incomingEntry: SessionTimelineEntry,
): SessionTimelineEntry | null {
  const entries = resolveSessionTimelineEntries(session as ChatSessionRecord);
  const turnState = readSessionAssistantTurnState(session);
  const incomingLaneIdentity = resolveAssistantEntryLaneIdentity(incomingEntry);
  if (
    incomingLaneIdentity.turnKey
    && incomingLaneIdentity.laneKey
  ) {
    const matchedTurn = turnState.turns.find((turn) => turn.turnKey === incomingLaneIdentity.turnKey);
    const matchedLane = matchedTurn?.lanes.find((lane) => lane.laneKey === incomingLaneIdentity.laneKey);
    if (matchedLane) {
      return matchedLane.entry;
    }
  }
  if (
    turnState.activeTurnKey
    && incomingLaneIdentity.turnKey
    && incomingLaneIdentity.laneKey
    && turnState.activeTurnKey === incomingLaneIdentity.turnKey
  ) {
    const matchedLane = turnState.lanes.find((lane) => lane.laneKey === incomingLaneIdentity.laneKey);
    if (matchedLane) {
      return matchedLane.entry;
    }
  }
  const incomingLane = resolveAssistantEntryLaneIdentity(incomingEntry);
  const currentStreamingTurn = findCurrentStreamingTurn(
    entries,
    session.runtime.streamingMessageId,
  );
  if (currentStreamingTurn) {
    const currentStreamingLane = resolveAssistantEntryLaneIdentity(currentStreamingTurn);
    if (
      !incomingLane.laneKey
      || !currentStreamingLane.laneKey
      || incomingLane.laneKey === currentStreamingLane.laneKey
    ) {
      return currentStreamingTurn;
    }
  }
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.role !== 'assistant') {
      continue;
    }
    const laneIdentity = resolveAssistantEntryLaneIdentity(entry);
    if (!incomingLane.laneKey || !laneIdentity.laneKey || incomingLane.laneKey === laneIdentity.laneKey) {
      return entry;
    }
  }
  return null;
}
