import { create } from 'zustand';
import type { SetStateAction } from 'react';

export type ComposerDraftSelection = {
  start: number;
  end: number;
  direction: 'forward' | 'backward' | 'none';
};

export type ComposerMode = { kind: 'typedGoal'; id: string; goalId?: string };

type ComposerDraftState = {
  modes: Record<string, ComposerMode>;
  setMode: (key: string, mode: ComposerMode | null) => void;
  moveDraft: (from: string, to: string, modeId: string) => void;
  drafts: Record<string, string>;
  revisions: Record<string, number>;
  selections: Record<string, ComposerDraftSelection>;
  setDraft: (key: string, update: SetStateAction<string>) => void;
  settleDraft: (key: string, revision: number | undefined, modeId?: string) => void;
  clearDraft: (key: string) => void;
  clearAgentDrafts: (agentId: string) => void;
  setSelection: (key: string, selection: ComposerDraftSelection) => void;
  readSelection: (key: string) => ComposerDraftSelection | null;
};

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
  setMode: (key, mode) => {
    if (!key) return;
    set((state) => {
      const modes = { ...state.modes };
      if (mode) modes[key] = mode;
      else delete modes[key];
      return { modes, revisions: { ...state.revisions, [key]: ++draftRevision } };
    });
  },
  moveDraft: (from, to, modeId) => {
    if (!from || from === to) return;
    set((state) => {
      if (state.modes[from]?.id !== modeId) return state;
      const drafts = { ...state.drafts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      if (from in drafts) drafts[to] = drafts[from];
      if (from in revisions) revisions[to] = revisions[from];
      if (from in selections) selections[to] = selections[from];
      if (from in modes) modes[to] = modes[from];
      delete drafts[from];
      delete revisions[from];
      delete selections[from];
      delete modes[from];
      return { drafts, revisions, selections, modes };
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
        const revisions = { ...state.revisions };
        const selections = { ...state.selections };
        delete drafts[key];
        delete revisions[key];
        delete selections[key];
        return { drafts, revisions, selections };
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
    if (state.revisions[key] === revision) {
      if (modeId !== undefined) state.clearDraft(key);
      else state.setDraft(key, '');
    } else if (modeId !== undefined) state.setMode(key, null);
  },
  clearDraft: (key) => {
    if (!key) return;
    set((state) => {
      if (!(key in state.drafts) && !(key in state.selections) && !(key in state.modes) && !(key in state.revisions)) return state;
      const drafts = { ...state.drafts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      delete drafts[key];
      delete revisions[key];
      delete selections[key];
      delete modes[key];
      return { drafts, revisions, selections, modes };
    });
  },
  clearAgentDrafts: (agentId) => {
    const prefix = agentDraftKeyPrefix(agentId);
    if (!prefix) return;
    set((state) => {
      const keys = new Set([
        ...Object.keys(state.drafts),
        ...Object.keys(state.selections),
        ...Object.keys(state.modes),
        ...Object.keys(state.revisions),
      ].filter((key) => key.toLowerCase().includes(prefix)));
      if (keys.size === 0) return state;
      const drafts = { ...state.drafts };
      const revisions = { ...state.revisions };
      const selections = { ...state.selections };
      const modes = { ...state.modes };
      for (const key of keys) {
        delete drafts[key];
        delete revisions[key];
        delete selections[key];
        delete modes[key];
      }
      return { drafts, revisions, selections, modes };
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
