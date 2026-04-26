import { useMemo } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { useChatInit } from './useChatInit';
import type { ChatHistoryLoadRequest } from '@/stores/chat/types';

interface UseChatActivationInput {
  isActive: boolean;
  isGatewayRunning: boolean;
  locationSearch: string;
  navigate: NavigateFunction;
  switchSession: (sessionKey: string) => void;
  openAgentConversation: (agentId: string) => void;
  loadAgents: () => Promise<void>;
  loadSessions: () => Promise<void>;
  loadHistory: (request: ChatHistoryLoadRequest) => Promise<void>;
  cleanupEmptySession: () => void;
}

interface ChatActivationState {
  workspaceActive: boolean;
  externalSyncActive: boolean;
  layoutEffectsActive: boolean;
  viewportEffectsActive: boolean;
  telemetryEffectsActive: boolean;
}

export function useChatActivation(input: UseChatActivationInput): ChatActivationState {
  const {
    isActive,
    isGatewayRunning,
    locationSearch,
    navigate,
    switchSession,
    openAgentConversation,
    loadAgents,
    loadSessions,
    loadHistory,
    cleanupEmptySession,
  } = input;

  const workspaceActive = isActive;
  const sideEffectsActive = workspaceActive && isGatewayRunning;

  useChatInit({
    isActive: sideEffectsActive,
    isGatewayRunning,
    locationSearch,
    navigate,
    switchSession,
    openAgentConversation,
    loadAgents,
    loadSessions,
    loadHistory,
    cleanupEmptySession,
  });

  return useMemo(() => ({
    workspaceActive,
    externalSyncActive: sideEffectsActive,
    layoutEffectsActive: sideEffectsActive,
    viewportEffectsActive: sideEffectsActive,
    telemetryEffectsActive: sideEffectsActive,
  }), [sideEffectsActive, workspaceActive]);
}
