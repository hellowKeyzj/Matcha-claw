import { create } from 'zustand';
import type { SetStateAction } from 'react';
import { sessionIdentitiesEqual, type SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionPermissionSelection } from '@/types/session-permission';
import type { ThinkingRuntime } from '@/types/session-thinking';
import type { AppComposeSource } from '@/types/desktop/app-plugin-sdk';
import { invokeIpc } from '@/lib/api-client';
import type { ChatSendAttachment, ChatSendResult } from './store/types';

export type ComposerSkill = { id: string; name: string; icon: string; filePath?: string; baseDir?: string };
export type ComposerContext = {
  id: string;
  name: string;
  text: string;
  prompt?: string;
  tag?: string;
  stagedAttachmentIds?: readonly string[];
  group?: { key: string; source: AppComposeSource; attachments: ChatSendAttachment[]; attachmentRemoval?: { tool: string } };
};
export type ComposerSubmission = {
  operationId: string;
  snapshot: ComposerDraftSnapshot;
  skills: ComposerSkill[];
  attachments: ChatSendAttachment[];
  ownedAttachmentIds: string[];
  message: string;
  createdAt: number;
  draftId?: string;
  status: 'prepared' | 'submitting' | 'sending' | 'failed' | 'unknown';
  revision?: number;
  error?: string;
  attachmentReselectionRequired?: boolean;
};

export type ComposerPromptSnapshot = {
  scope: object;
  identity: SessionIdentity | null;
  draftKey: string | undefined;
  revision: number | undefined;
  inputRevision: number;
  text: string;
};

export function composerPromptSnapshotsEqual(expected: ComposerPromptSnapshot, current: ComposerPromptSnapshot | null): boolean {
  return current !== null && current.scope === expected.scope && current.draftKey === expected.draftKey
    && current.revision === expected.revision && current.inputRevision === expected.inputRevision && current.text === expected.text
    && (expected.identity === null ? current.identity === null : current.identity !== null && sessionIdentitiesEqual(expected.identity, current.identity));
}

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
  | { kind: 'createRejected'; operationId: string; error: string }
  | { kind: 'createUnknown'; operationId: string; error: string }
  | {
    kind: 'pending'; operationId: string; sessionRecordKey: string; sessionIdentity: SessionIdentity;
    outcome?: 'unsupported' | 'unavailable' | 'rejected' | 'unknown'; error?: string;
  };
export type ComposerDraftSnapshot = {
  revision: number | undefined;
  draft: string;
  contexts?: ComposerContext[];
  selection?: ComposerDraftSelection;
  mode?: ComposerMode;
  configuration?: ComposerConfiguration;
};

type ComposerDraftState = {
  modes: Record<string, ComposerMode>;
  setMode: (key: string, mode: ComposerMode | null) => void;
  drafts: Record<string, string>;
  contexts: Record<string, ComposerContext[]>;
  revisions: Record<string, number>;
  selections: Record<string, ComposerDraftSelection>;
  configurations: Record<string, ComposerConfiguration>;
  initializations: Record<string, ComposerInitialization>;
  submissions: Record<string, ComposerSubmission>;
  prepareSubmission: (key: string, submission: ComposerSubmission) => boolean;
  takeSubmission: (key: string, operationId: string) => boolean;
  markSubmissionSending: (key: string, operationId: string) => void;
  settleSubmission: (key: string, operationId: string, result: ChatSendResult) => void;
  removeSubmission: (key: string, operationId: string) => void;
  discardSubmission: (key: string, operationId: string) => void;
  restoreSubmission: (key: string, operationId: string) => boolean;
  setModelSelection: (key: string, selectionId: string | null) => void;
  setPermissionSelection: (key: string, selection: SessionPermissionSelection | null) => void;
  setThinkingSelection: (key: string, selection: ComposerThinkingSelection | null) => void;
  confirmConfiguration: (key: string, revision: number, field: 'modelSelectionId' | 'permissionSelection' | 'thinkingSelection') => void;
  setInitialization: (key: string, initialization: ComposerInitialization | null) => void;
  promoteDraft: (from: string, to: string, snapshot: ComposerDraftSnapshot, initialization: Extract<ComposerInitialization, { kind: 'pending' }>, promoteEdits: boolean) => void;
  setDraft: (key: string, update: SetStateAction<string>) => void;
  setContexts: (key: string, update: SetStateAction<ComposerContext[]>) => void;
  invalidateAttachmentContexts: (ids: readonly string[]) => void;
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
    contexts: state.contexts[key],
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

function groupAttachmentIds(contexts: readonly ComposerContext[] | undefined): string[] {
  return contexts?.flatMap((context) => context.group ? context.stagedAttachmentIds ?? [] : []) ?? [];
}

let draftRevision = 0;

export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  drafts: {},
  contexts: {},
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
    let taken = false;
    set((current) => {
      const submission = current.submissions[key];
      if (!submission || submission.operationId !== operationId || submission.status !== 'prepared'
        || current.revisions[key] !== submission.snapshot.revision) return current;
      taken = true;
      const drafts = { ...current.drafts };
      const contexts = { ...current.contexts };
      const selections = { ...current.selections };
      delete drafts[key];
      delete contexts[key];
      delete selections[key];
      const revision = ++draftRevision;
      return {
        drafts, contexts, selections, revisions: { ...current.revisions, [key]: revision },
        submissions: { ...current.submissions, [key]: { ...submission, status: 'submitting', revision } },
      };
    });
    return taken;
  },
  markSubmissionSending: (key, operationId) => {
    set((state) => {
      const submission = state.submissions[key];
      if (submission?.operationId !== operationId || submission.status !== 'submitting') return state;
      return { submissions: { ...state.submissions, [key]: { ...submission, status: 'sending' } } };
    });
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
    if (!submission || submission.operationId !== operationId || submission.status === 'submitting' || submission.status === 'sending') return;
    const draftIds = new Set(groupAttachmentIds(state.contexts[key]));
    releaseSubmissionAttachments(submission.ownedAttachmentIds.filter((id) => !draftIds.has(id)));
    state.removeSubmission(key, operationId);
  },
  restoreSubmission: (key, operationId) => {
    const state = get();
    const submission = state.submissions[key];
    if (submission?.operationId !== operationId || submission.status !== 'failed' || state.drafts[key] || state.contexts[key]?.length
      || state.modes[key] && state.modes[key].id !== submission.snapshot.mode?.id) return false;
    const contexts = submission.snapshot.contexts?.filter((context) => !context.stagedAttachmentIds?.some((id) => !submission.ownedAttachmentIds.includes(id)));
    set((current) => ({
      drafts: { ...current.drafts, [key]: submission.snapshot.draft },
      contexts: { ...current.contexts, ...(contexts?.length ? { [key]: contexts } : {}) },
      modes: { ...current.modes, ...(submission.snapshot.mode ? { [key]: submission.snapshot.mode } : {}) },
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
  promoteDraft: (from, to, snapshot, initialization, promoteEdits) => {
    set((state) => {
      if (state.initializations[from]?.operationId !== initialization.operationId) return state;
      const drafts = { ...state.drafts };
      const contexts = { ...state.contexts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      const configurations = { ...state.configurations };
      const initializations = { ...state.initializations, [to]: initialization };
      const submissions = { ...state.submissions };
      const submission = submissions[from];
      const submitted = submission?.operationId === initialization.operationId && (submission.status === 'submitting' || submission.status === 'sending');
      const promoted = submitted && promoteEdits ? {
        draft: state.drafts[from], contexts: state.contexts[from], revision: state.revisions[from], selection: state.selections[from],
        mode: state.modes[from], configuration: state.configurations[from],
      } : snapshot;
      if (promoteEdits || !submitted) {
        if (promoted.draft) drafts[to] = promoted.draft;
        if (promoted.contexts?.length) contexts[to] = promoted.contexts;
        if (promoted.revision !== undefined) revisions[to] = promoted.revision;
        if (promoted.selection) selections[to] = promoted.selection;
      }
      if (promoted.mode) modes[to] = promoted.mode;
      if (promoted.configuration) configurations[to] = promoted.configuration;
      if (submitted) {
        submissions[to] = submission;
        delete submissions[from];
      }
      if (promoteEdits && (submitted || state.revisions[from] === snapshot.revision)) {
        delete drafts[from];
        delete contexts[from];
        delete revisions[from];
        delete selections[from];
        delete modes[from];
        delete configurations[from];
      }
      delete initializations[from];
      return { drafts, contexts, revisions, selections, modes, configurations, initializations, submissions };
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
  setContexts: (key, update) => {
    if (!key) return;
    set((state) => {
      const current = state.contexts[key] ?? [];
      const next = typeof update === 'function' ? update(current) : update;
      if (next === current || !next.length && !current.length) return state;
      const contexts = { ...state.contexts };
      if (next.length) contexts[key] = next;
      else delete contexts[key];
      const retained = new Set(groupAttachmentIds(next));
      releaseSubmissionAttachments(groupAttachmentIds(current).filter((id) => !retained.has(id)));
      return { contexts, revisions: { ...state.revisions, [key]: ++draftRevision } };
    });
  },
  invalidateAttachmentContexts: (ids) => {
    if (!ids.length) return;
    const removed = new Set(ids);
    set((state) => {
      const contexts = { ...state.contexts };
      const revisions = { ...state.revisions };
      let changed = false;
      for (const [key, current] of Object.entries(contexts)) {
        const next = current.filter((context) => context.group || !context.stagedAttachmentIds?.some((id) => removed.has(id)));
        if (next.length === current.length) continue;
        if (next.length) contexts[key] = next;
        else delete contexts[key];
        revisions[key] = ++draftRevision;
        changed = true;
      }
      return changed ? { contexts, revisions } : state;
    });
  },
  settleDraft: (key, revision, modeId) => {
    const state = get();
    if (modeId !== undefined && state.modes[key]?.id !== modeId) return;
    if (state.revisions[key] !== revision) return;
    if (modeId !== undefined) state.clearDraft(key);
    else set((current) => {
      const drafts = { ...current.drafts };
      const contexts = { ...current.contexts };
      const selections = { ...current.selections };
      releaseSubmissionAttachments(groupAttachmentIds(current.contexts[key]));
      delete drafts[key];
      delete contexts[key];
      delete selections[key];
      return { drafts, contexts, selections, revisions: { ...current.revisions, [key]: ++draftRevision } };
    });
  },
  clearDraft: (key) => {
    if (!key) return;
    set((state) => {
      const drafts = { ...state.drafts };
      const contexts = { ...state.contexts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      const configurations = { ...state.configurations };
      const initializations = { ...state.initializations };
      const submissions = { ...state.submissions };
      if (submissions[key]?.status !== 'submitting' && submissions[key]?.status !== 'sending') {
        const ids = new Set([...(submissions[key]?.ownedAttachmentIds ?? []), ...groupAttachmentIds(state.contexts[key])]);
        releaseSubmissionAttachments([...ids]);
        delete submissions[key];
      } else releaseSubmissionAttachments(groupAttachmentIds(state.contexts[key]));
      delete drafts[key];
      delete contexts[key];
      revisions[key] = ++draftRevision;
      delete selections[key];
      delete modes[key];
      delete configurations[key];
      delete initializations[key];
      return { drafts, contexts, revisions, selections, modes, configurations, initializations, submissions };
    });
  },
  clearAgentDrafts: (agentId, runtimeScopeKey) => {
    const prefix = agentDraftKeyPrefix(agentId);
    if (!prefix) return;
    set((state) => {
      const keys = new Set([
        ...Object.keys(state.drafts),
        ...Object.keys(state.contexts),
        ...Object.keys(state.selections),
        ...Object.keys(state.modes),
        ...Object.keys(state.revisions),
        ...Object.keys(state.configurations),
        ...Object.keys(state.initializations),
        ...Object.keys(state.submissions),
      ].filter((key) => key.startsWith(`${runtimeScopeKey}:agent:`) && key.toLowerCase().includes(prefix)));
      if (keys.size === 0) return state;
      const drafts = { ...state.drafts };
      const contexts = { ...state.contexts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      const configurations = { ...state.configurations };
      const initializations = { ...state.initializations };
      const submissions = { ...state.submissions };
      for (const key of keys) {
        if (submissions[key]?.status !== 'submitting' && submissions[key]?.status !== 'sending') {
          const ids = new Set([...(submissions[key]?.ownedAttachmentIds ?? []), ...groupAttachmentIds(state.contexts[key])]);
          releaseSubmissionAttachments([...ids]);
          delete submissions[key];
        } else releaseSubmissionAttachments(groupAttachmentIds(state.contexts[key]));
        delete drafts[key];
        delete contexts[key];
        delete revisions[key];
        delete selections[key];
        delete modes[key];
        delete configurations[key];
        delete initializations[key];
      }
      return { drafts, contexts, revisions, selections, modes, configurations, initializations, submissions };
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
