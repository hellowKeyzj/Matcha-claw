import { create } from 'zustand';
import type { SetStateAction } from 'react';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionPermissionSelection } from '@/types/session-permission';
import type { ThinkingRuntime } from '@/types/session-thinking';
import { invokeIpc } from '@/lib/api-client';
import type { ChatSendAttachment, ChatSendResult } from './store/types';

export type ComposerSkill = { id: string; name: string; icon: string; filePath?: string; baseDir?: string };
export type ComposerSubmission = {
  operationId: string;
  snapshot: ComposerDraftSnapshot;
  skills: ComposerSkill[];
  attachments: ChatSendAttachment[];
  ownedAttachmentIds: string[];
  status: 'prepared' | 'sending' | 'failed' | 'unknown';
  revision?: number;
  error?: string;
  attachmentReselectionRequired?: boolean;
};

export type ComposerDraftSelection = {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
};

export type ComposerMode = { kind: 'typedGoal'; id: string; goalId?: string };
export type ComposerThinkingSelection = { runtime: ThinkingRuntime; level: string | null };
export type ComposerConfiguration = {
  revision: number;
  modelSelectionId?: string;
  permissionSelection?: SessionPermissionSelection;
  thinkingSelection?: ComposerThinkingSelection;
};
export type ComposerInitialization =
  | { kind: 'creating'; operationId: string }
  | { kind: 'createUnknown'; operationId: string; error: string }
  | {
    kind: 'pending'; operationId: string; sessionRecordKey: string; sessionIdentity: SessionIdentity;
    outcome?: 'unsupported' | 'unavailable' | 'rejected' | 'unknown'; error?: string;
  };
export type ComposerDraftSnapshot = {
  revision: number | undefined;
  draft: string;
  selection?: ComposerDraftSelection;
  mode?: ComposerMode;
  configuration?: ComposerConfiguration;
};

type ComposerDraftState = {
  modes: Record<string, ComposerMode>;
  setMode: (key: string, mode: ComposerMode | null) => void;
  drafts: Record<string, string>;
  revisions: Record<string, number>;
  selections: Record<string, ComposerDraftSelection>;
  configurations: Record<string, ComposerConfiguration>;
  initializations: Record<string, ComposerInitialization>;
  submissions: Record<string, ComposerSubmission>;
  prepareSubmission: (key: string, submission: ComposerSubmission) => boolean;
  takeSubmission: (key: string, operationId: string) => boolean;
  settleSubmission: (key: string, operationId: string, result: ChatSendResult) => void;
  removeSubmission: (key: string, operationId: string) => void;
  discardSubmission: (key: string, operationId: string) => void;
  restoreSubmission: (key: string, operationId: string) => boolean;
  setModelSelection: (key: string, selectionId: string | null) => void;
  setPermissionSelection: (key: string, selection: SessionPermissionSelection | null) => void;
  setThinkingSelection: (key: string, selection: ComposerThinkingSelection | null) => void;
  confirmConfiguration: (key: string, revision: number, field: 'modelSelectionId' | 'permissionSelection' | 'thinkingSelection') => void;
  setInitialization: (key: string, initialization: ComposerInitialization | null) => void;
  promoteDraft: (from: string, to: string, snapshot: ComposerDraftSnapshot, initialization: Extract<ComposerInitialization, { kind: 'pending' }>) => void;
  setDraft: (key: string, update: SetStateAction<string>) => void;
  settleDraft: (key: string, revision: number | undefined, modeId?: string) => void;
  clearDraft: (key: string) => void;
  clearAgentDrafts: (agentId: string, runtimeScopeKey: string) => void;
  setSelection: (key: string, selection: ComposerDraftSelection) => void;
  readSelection: (key: string) => ComposerDraftSelection | null;
};

export function readComposerDraftSnapshot(key: string): ComposerDraftSnapshot {
  const state = useComposerDraftStore.getState();
  return {
    revision: state.revisions[key],
    draft: state.drafts[key] ?? '',
    selection: state.selections[key],
    mode: state.modes[key],
    configuration: state.configurations[key],
  };
}

export function clampComposerDraftSelection(
  selection: ComposerDraftSelection | null | undefined,
  value: string,
): ComposerDraftSelection | null {
  if (!selection) {
    return null;
  }
  const length = value.length;
  const start = Math.max(0, Math.min(selection.start, length));
  const end = Math.max(start, Math.min(selection.end, length));
  return {
    start,
    end,
    direction: selection.direction,
  };
}

function agentDraftKeyPrefix(agentId: string): string | null {
  const normalizedAgentId = agentId.trim().toLowerCase();
  return normalizedAgentId ? `:agent:${normalizedAgentId}:` : null;
}

function releaseSubmissionAttachments(ids: string[]): void {
  if (ids.length) void invokeIpc('dialog:releaseStagedAttachments', ids).catch(() => undefined);
}

let draftRevision = 0;

export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  drafts: {},
  revisions: {},
  selections: {},
  modes: {},
  configurations: {},
  initializations: {},
  submissions: {},
  prepareSubmission: (key, submission) => {
    if (get().submissions[key] || get().revisions[key] !== submission.snapshot.revision) return false;
    set((state) => ({ submissions: { ...state.submissions, [key]: submission } }));
    return true;
  },
  takeSubmission: (key, operationId) => {
    const state = get();
    const submission = state.submissions[key];
    if (!submission || submission.operationId !== operationId || submission.status !== 'prepared'
      || state.revisions[key] !== submission.snapshot.revision) return false;
    set((current) => {
      const drafts = { ...current.drafts };
      const selections = { ...current.selections };
      delete drafts[key];
      delete selections[key];
      const revision = ++draftRevision;
      return {
        drafts, selections, revisions: { ...current.revisions, [key]: revision },
        submissions: { ...current.submissions, [key]: { ...submission, status: 'sending', revision } },
      };
    });
    return true;
  },
  settleSubmission: (key, operationId, result) => {
    const state = get();
    const submission = state.submissions[key];
    if (!submission || submission.operationId !== operationId) return;
    if (submission.status === 'prepared') return;
    if (result.accepted || result.outcome === 'unknown' && result.dispatch !== 'not-dispatched') {
      if (result.accepted) releaseSubmissionAttachments(submission.ownedAttachmentIds);
      state.removeSubmission(key, operationId);
      return;
    }
    const unknown = state.initializations[key]?.kind === 'createUnknown';
    if (result.dispatch !== 'not-dispatched') releaseSubmissionAttachments(submission.ownedAttachmentIds);
    const settled: ComposerSubmission = {
      ...submission,
      status: unknown ? 'unknown' : 'failed',
      error: result.error,
      ownedAttachmentIds: result.dispatch === 'not-dispatched' ? submission.ownedAttachmentIds : [],
      attachmentReselectionRequired: result.dispatch !== 'not-dispatched' && result.attachmentReselectionRequired,
    };
    set((current) => ({ submissions: { ...current.submissions, [key]: settled } }));
  },
  removeSubmission: (key, operationId) => {
    set((state) => {
      if (state.submissions[key]?.operationId !== operationId) return state;
      const submissions = { ...state.submissions };
      delete submissions[key];
      return { submissions };
    });
  },
  discardSubmission: (key, operationId) => {
    const state = get();
    const submission = state.submissions[key];
    if (!submission || submission.operationId !== operationId || submission.status === 'sending') return;
    releaseSubmissionAttachments(submission.ownedAttachmentIds);
    state.removeSubmission(key, operationId);
  },
  restoreSubmission: (key, operationId) => {
    const state = get();
    const submission = state.submissions[key];
    if (submission?.operationId !== operationId || submission.status !== 'failed' || state.drafts[key] || state.modes[key]) return false;
    set((current) => ({
      drafts: { ...current.drafts, [key]: submission.snapshot.draft },
      selections: { ...current.selections, ...(submission.snapshot.selection ? { [key]: submission.snapshot.selection } : {}) },
      revisions: { ...current.revisions, [key]: ++draftRevision },
    }));
    return true;
  },
  setModelSelection: (key, selectionId) => {
    if (!key) return;
    set((state) => {
      const configuration = { ...state.configurations[key], revision: ++draftRevision };
      if (selectionId?.trim()) configuration.modelSelectionId = selectionId.trim();
      else delete configuration.modelSelectionId;
      return {
        configurations: { ...state.configurations, [key]: configuration },
        revisions: { ...state.revisions, [key]: configuration.revision },
      };
    });
  },
  setPermissionSelection: (key, selection) => {
    if (!key) return;
    set((state) => {
      const configuration = { ...state.configurations[key], revision: ++draftRevision };
      if (selection) configuration.permissionSelection = selection;
      else delete configuration.permissionSelection;
      return {
        configurations: { ...state.configurations, [key]: configuration },
        revisions: { ...state.revisions, [key]: configuration.revision },
      };
    });
  },
  setThinkingSelection: (key, selection) => {
    if (!key) return;
    set((state) => {
      const configuration = { ...state.configurations[key], revision: ++draftRevision };
      if (selection) configuration.thinkingSelection = selection;
      else delete configuration.thinkingSelection;
      return {
        configurations: { ...state.configurations, [key]: configuration },
        revisions: { ...state.revisions, [key]: configuration.revision },
      };
    });
  },
  confirmConfiguration: (key, revision, field) => {
    set((state) => {
      const current = state.configurations[key];
      if (!current || current.revision !== revision) return state;
      const configuration = { ...current };
      delete configuration[field];
      return { configurations: { ...state.configurations, [key]: configuration } };
    });
  },
  setInitialization: (key, initialization) => {
    set((state) => {
      const initializations = { ...state.initializations };
      if (initialization) initializations[key] = initialization;
      else delete initializations[key];
      return { initializations };
    });
  },
  promoteDraft: (from, to, snapshot, initialization) => {
    set((state) => {
      if (state.initializations[from]?.operationId !== initialization.operationId) return state;
      const drafts = { ...state.drafts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      const configurations = { ...state.configurations };
      const initializations = { ...state.initializations, [to]: initialization };
      const submissions = { ...state.submissions };
      const submission = submissions[from];
      const submitted = submission?.operationId === initialization.operationId && submission.status === 'sending';
      const promoted = submitted ? {
        draft: state.drafts[from], revision: state.revisions[from], selection: state.selections[from],
        mode: state.modes[from], configuration: state.configurations[from],
      } : snapshot;
      if (promoted.draft) drafts[to] = promoted.draft;
      if (promoted.revision !== undefined) revisions[to] = promoted.revision;
      if (promoted.selection) selections[to] = promoted.selection;
      if (promoted.mode) modes[to] = promoted.mode;
      if (promoted.configuration) configurations[to] = promoted.configuration;
      if (submitted) {
        submissions[to] = submission;
        delete submissions[from];
      }
      if (submitted || state.revisions[from] === snapshot.revision) {
        delete drafts[from];
        delete revisions[from];
        delete selections[from];
        delete modes[from];
        delete configurations[from];
      }
      delete initializations[from];
      return { drafts, revisions, selections, modes, configurations, initializations, submissions };
    });
  },
  setMode: (key, mode) => {
    if (!key) return;
    set((state) => {
      const modes = { ...state.modes };
      if (mode) modes[key] = mode;
      else delete modes[key];
      return { modes, revisions: { ...state.revisions, [key]: ++draftRevision } };
    });
  },
  setDraft: (key, update) => {
    if (!key) return;
    set((state) => {
      const currentDraft = state.drafts[key] ?? '';
      const nextDraft = typeof update === 'function' ? update(currentDraft) : update;
      if (!nextDraft) {
        if (!(key in state.drafts) && !(key in state.selections)) return state;
        const drafts = { ...state.drafts };
        const selections = { ...state.selections };
        delete drafts[key];
        delete selections[key];
        return { drafts, revisions: { ...state.revisions, [key]: ++draftRevision }, selections };
      }
      if (nextDraft === currentDraft) return state;
      return {
        drafts: {
          ...state.drafts,
          [key]: nextDraft,
        },
        revisions: { ...state.revisions, [key]: ++draftRevision },
      };
    });
  },
  settleDraft: (key, revision, modeId) => {
    const state = get();
    if (modeId !== undefined && state.modes[key]?.id !== modeId) return;
    if (state.revisions[key] !== revision) return;
    if (modeId !== undefined) state.clearDraft(key);
    else state.setDraft(key, '');
  },
  clearDraft: (key) => {
    if (!key) return;
    set((state) => {
      const drafts = { ...state.drafts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      const configurations = { ...state.configurations };
      const initializations = { ...state.initializations };
      const submissions = { ...state.submissions };
      if (submissions[key]?.status !== 'sending') {
        releaseSubmissionAttachments(submissions[key]?.ownedAttachmentIds ?? []);
        delete submissions[key];
      }
      delete drafts[key];
      revisions[key] = ++draftRevision;
      delete selections[key];
      delete modes[key];
      delete configurations[key];
      delete initializations[key];
      return { drafts, revisions, selections, modes, configurations, initializations, submissions };
    });
  },
  clearAgentDrafts: (agentId, runtimeScopeKey) => {
    const prefix = agentDraftKeyPrefix(agentId);
    if (!prefix) return;
    set((state) => {
      const keys = new Set([
        ...Object.keys(state.drafts),
        ...Object.keys(state.selections),
        ...Object.keys(state.modes),
        ...Object.keys(state.revisions),
        ...Object.keys(state.configurations),
        ...Object.keys(state.initializations),
        ...Object.keys(state.submissions),
      ].filter((key) => key.startsWith(`${runtimeScopeKey}:agent:`) && key.toLowerCase().includes(prefix)));
      if (keys.size === 0) return state;
      const drafts = { ...state.drafts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      const configurations = { ...state.configurations };
      const initializations = { ...state.initializations };
      const submissions = { ...state.submissions };
      for (const key of keys) {
        if (submissions[key]?.status !== 'sending') {
          releaseSubmissionAttachments(submissions[key]?.ownedAttachmentIds ?? []);
          delete submissions[key];
        }
        delete drafts[key];
        delete revisions[key];
        delete selections[key];
        delete modes[key];
        delete configurations[key];
        delete initializations[key];
      }
      return { drafts, revisions, selections, modes, configurations, initializations, submissions };
    });
  },
  setSelection: (key, selection) => {
    if (!key) return;
    set((state) => {
      const current = state.selections[key];
      if (
        current
        && current.start === selection.start
        && current.end === selection.end
        && current.direction === selection.direction
      ) {
        return state;
      }
      return {
        selections: {
          ...state.selections,
          [key]: selection,
        },
      };
    });
  },
  readSelection: (key) => {
    if (!key) return null;
    return get().selections[key] ?? null;
  },
}));
