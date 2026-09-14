import { beforeEach, describe, expect, it } from 'vitest';
import { clampComposerDraftSelection, useComposerDraftStore } from '@/stores/composer-drafts';

describe('composer draft store', () => {
  beforeEach(() => {
    useComposerDraftStore.setState({ drafts: {}, selections: {} });
  });

  it('keeps unsent text isolated by key', () => {
    const { setDraft } = useComposerDraftStore.getState();

    setDraft('runtime:agent:first:draft', 'first draft');
    setDraft('runtime:agent:second:draft', 'second draft');

    expect(useComposerDraftStore.getState().drafts).toEqual({
      'runtime:agent:first:draft': 'first draft',
      'runtime:agent:second:draft': 'second draft',
    });
  });

  it('applies functional updates and removes empty drafts', () => {
    const { setDraft, setSelection, clearDraft, readSelection } = useComposerDraftStore.getState();

    setDraft('session:first', 'draft');
    setDraft('session:first', (current) => `${current} text`);
    expect(useComposerDraftStore.getState().drafts['session:first']).toBe('draft text');

    setSelection('session:first', { start: 1, end: 1, direction: 'none' });
    setDraft('session:first', '');
    expect(useComposerDraftStore.getState().drafts).toEqual({});
    expect(readSelection('session:first')).toBeNull();

    setDraft('session:second', 'other');
    clearDraft('session:second');
    expect(useComposerDraftStore.getState().drafts).toEqual({});
  });

  it('stores selection, clamps it to value length, and clears it with the draft', () => {
    const { setDraft, setSelection, clearDraft, readSelection } = useComposerDraftStore.getState();

    setDraft('session:first', 'hello');
    setSelection('session:first', { start: 2, end: 20, direction: 'forward' });

    expect(clampComposerDraftSelection(readSelection('session:first'), 'hello')).toEqual({
      start: 2,
      end: 5,
      direction: 'forward',
    });

    clearDraft('session:first');
    expect(readSelection('session:first')).toBeNull();
  });

  it('clears transient draft conversations owned by a deleted agent', () => {
    const { setDraft, setSelection, clearAgentDrafts } = useComposerDraftStore.getState();

    setDraft('runtime:agent:worker:draft', 'worker draft');
    setSelection('runtime:agent:worker:draft', { start: 1, end: 1, direction: 'none' });
    setDraft('runtime:agent:worker2:draft', 'other draft');

    clearAgentDrafts('worker');

    expect(useComposerDraftStore.getState().drafts).toEqual({
      'runtime:agent:worker2:draft': 'other draft',
    });
    expect(useComposerDraftStore.getState().selections['runtime:agent:worker:draft']).toBeUndefined();
  });
});
