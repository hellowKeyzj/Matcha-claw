import { describe, it, expect } from 'vitest';
import { resolveToolCardRenderState } from '../../runtime-host/application/sessions/tool/tool-card-render-state';

describe('repro: tool card with empty/structural-only inputText', () => {
  it('Tasklist with {} input should not produce a "{}" displayDetail', () => {
    const state = resolveToolCardRenderState({
      name: 'Tasklist',
      input: {},
    });
    expect(state.displayDetail).toBeUndefined();
  });

  it('TodoWrite with {} input should not produce a "{}" displayDetail', () => {
    const state = resolveToolCardRenderState({
      name: 'TodoWrite',
      input: {},
    });
    expect(state.displayDetail).toBeUndefined();
  });

  it('Tool with single "{" partial input should not produce a "{" displayDetail', () => {
    const state = resolveToolCardRenderState({
      name: 'Tasklist',
      input: '{',
    });
    expect(state.displayDetail).toBeUndefined();
  });
});


describe('repro: tool card with structural-only outputText', () => {
  it('output "{" should not produce a "{" collapsedPreview', () => {
    const state = resolveToolCardRenderState({
      name: 'Tasklist',
      input: {},
      outputText: '{',
    });
    if (state.result.kind === 'text' || state.result.kind === 'json') {
      expect(state.result.collapsedPreview).toBe('');
    }
    // dump for diagnosis
    console.log('result with output "{":', JSON.stringify(state.result));
  });

  it('output "()" should not produce a "()" collapsedPreview', () => {
    const state = resolveToolCardRenderState({
      name: 'Tasklist',
      input: {},
      outputText: '()',
    });
    if (state.result.kind === 'text' || state.result.kind === 'json') {
      expect(state.result.collapsedPreview).toBe('');
    }
    console.log('result with output "()":', JSON.stringify(state.result));
  });

  it('output "{}" should not produce a "{}" collapsedPreview', () => {
    const state = resolveToolCardRenderState({
      name: 'Tasklist',
      input: {},
      outputText: '{}',
    });
    console.log('result with output "{}":', JSON.stringify(state.result));
  });
});
