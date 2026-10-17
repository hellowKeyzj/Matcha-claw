import { create } from 'zustand';
import type { SetStateAction } from 'react';
import type { SessionIdentity } from '@/types/desktop/runtime-address';
import type { SessionPermissionSelection } from '@/types/session-permission';

export type ComposerDraftSelection = {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
};

export type ComposerMode = { kind: 'typedGoal'; id: string; goalId?: string };
export type ComposerConfiguration = {
  revision: number;
  modelSelectionId?: string;
  permissionSelection?: SessionPermissionSelection;
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
  setModelSelection: (key: string, selectionId: string | null) => void;
  setPermissionSelection: (key: string, selection: SessionPermissionSelection | null) => void;
  confirmConfiguration: (key: string, revision: number, field: 'modelSelectionId' | 'permissionSelection') => void;
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

let draftRevision = 0;

export const useComposerDraftStore = create<ComposerDraftState>((set, get) => ({
  drafts: {},
  revisions: {},
  selections: {},
  modes: {},
  configurations: {},
  initializations: {},
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
      if (snapshot.draft) drafts[to] = snapshot.draft;
      if (snapshot.revision !== undefined) revisions[to] = snapshot.revision;
      if (snapshot.selection) selections[to] = snapshot.selection;
      if (snapshot.mode) modes[to] = snapshot.mode;
      if (snapshot.configuration) configurations[to] = snapshot.configuration;
      if (state.revisions[from] === snapshot.revision) {
        delete drafts[from];
        delete revisions[from];
        delete selections[from];
        delete modes[from];
        delete configurations[from];
      }
      delete initializations[from];
      return { drafts, revisions, selections, modes, configurations, initializations };
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
      delete drafts[key];
      revisions[key] = ++draftRevision;
      delete selections[key];
      delete modes[key];
      delete configurations[key];
      delete initializations[key];
      return { drafts, revisions, selections, modes, configurations, initializations };
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
      ].filter((key) => key.startsWith(`${runtimeScopeKey}:agent:`) && key.toLowerCase().includes(prefix)));
      if (keys.size === 0) return state;
      const drafts = { ...state.drafts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      const configurations = { ...state.configurations };
      const initializations = { ...state.initializations };
      for (const key of keys) {
        delete drafts[key];
        delete revisions[key];
        delete selections[key];
        delete modes[key];
        delete configurations[key];
        delete initializations[key];
      }
      return { drafts, revisions, selections, modes, configurations, initializations };
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
