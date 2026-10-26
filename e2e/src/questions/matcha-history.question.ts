import { notes } from '@serenity-js/core';
import { Text } from '@serenity-js/web';
import { MatchaHistoryPage } from '../pages/matcha-history.page.js';

type MatchaHistoryNotes = {
  matchaHistoryPreparation: { ready: boolean; agentSelector: string; prompt: string; marker: string };
  matchaHistorySession: { created: boolean; sessionKey: string; selector: string };
  matchaHistoryTurnCompleted: boolean;
  matchaHistorySnapshot: {
    verified: boolean; digest: string; endpointSessionId: string; marker: string;
    identity: { agentId: string; sessionKey: string; endpoint: { kind: string; runtimeAdapterId: string; runtimeInstanceId: string } };
  };
  matchaHistoryMarkdownVerified: boolean;
  matchaHistoryCleanup: { state: string };
  matchaHistoryRecovered: boolean;
};

export const MatchaHistoryRuntimeIsReady = () => notes<MatchaHistoryNotes>().get('matchaHistoryPreparation').ready;
export const MatchaHistoryNewDraftSelector = () => notes<MatchaHistoryNotes>().get('matchaHistoryPreparation').agentSelector;
export const MatchaHistorySessionWasCreated = () => notes<MatchaHistoryNotes>().get('matchaHistorySession').created;
export const MatchaHistorySessionKey = () => notes<MatchaHistoryNotes>().get('matchaHistorySession').sessionKey;
export const MatchaHistorySessionSelector = () => notes<MatchaHistoryNotes>().get('matchaHistorySession').selector;
export const MatchaHistoryPrompt = () => notes<MatchaHistoryNotes>().get('matchaHistoryPreparation').prompt;
export const MatchaHistoryMarker = () => notes<MatchaHistoryNotes>().get('matchaHistoryPreparation').marker;
export const MatchaHistoryTurnCompleted = () => notes<MatchaHistoryNotes>().get('matchaHistoryTurnCompleted');
export const MatchaPublicHistoryWasVerified = () => notes<MatchaHistoryNotes>().get('matchaHistorySnapshot').verified;
export const MatchaHistoryRecoveryEvidence = () => notes<MatchaHistoryNotes>().get('matchaHistorySnapshot');
export const MatchaHistoryMarkdownWasVerified = () => notes<MatchaHistoryNotes>().get('matchaHistoryMarkdownVerified');
export const MatchaHistoryCleanup = () => notes<MatchaHistoryNotes>().get('matchaHistoryCleanup');
export const MatchaHistoryCleanupState = () => notes<MatchaHistoryNotes>().get('matchaHistoryCleanup').state;
export const MatchaHistoryRecoveredAfterNativeRestart = () => notes<MatchaHistoryNotes>().get('matchaHistoryRecovered');
export const MatchaHistoryUserText = () => Text.of(MatchaHistoryPage.userMessage);
export const MatchaHistoryAssistantText = () => Text.of(MatchaHistoryPage.assistantTurn);
