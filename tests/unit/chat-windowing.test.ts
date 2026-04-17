import { describe, expect, it } from 'vitest';
import {
  advanceSessionRenderWindowBudgetState,
  resolveRenderableWindowExpandStep,
  sliceMessagesForFirstPaint,
} from '@/pages/Chat/useWindowing';
import type { RawMessage } from '@/stores/chat';

describe('chat render windowing', () => {
  const byCountOnly = (renderableLimit: number) => ({
    renderableLimit,
    contentBudget: Number.MAX_SAFE_INTEGER,
  });

  it('returns empty slice for empty message list', () => {
    const result = sliceMessagesForFirstPaint([], byCountOnly(8));
    expect(result.messages).toEqual([]);
    expect(result.hasOlderRenderableMessages).toBe(false);
  });

  it('slices tail by renderable limit and reports older renderable rows', () => {
    const messages: RawMessage[] = [
      { role: 'user', content: 'u1', timestamp: 1 },
      { role: 'assistant', content: 'a1', timestamp: 2 },
      { role: 'tool_result', content: 'tool', timestamp: 3 },
      { role: 'assistant', content: 'a2', timestamp: 4 },
      { role: 'assistant', content: 'a3', timestamp: 5 },
    ];

    const result = sliceMessagesForFirstPaint(messages, byCountOnly(2));
    expect(result.messages).toEqual(messages.slice(3));
    expect(result.hasOlderRenderableMessages).toBe(true);
  });

  it('keeps full list when renderable messages are below limit', () => {
    const messages: RawMessage[] = [
      { role: 'assistant', content: 'a1', timestamp: 1 },
      { role: 'tool_result', content: 'tool', timestamp: 2 },
      { role: 'assistant', content: 'a2', timestamp: 3 },
    ];

    const result = sliceMessagesForFirstPaint(messages, byCountOnly(8));
    expect(result.messages).toBe(messages);
    expect(result.hasOlderRenderableMessages).toBe(false);
  });

  it('ignores non-renderable older rows when reporting older availability', () => {
    const messages: RawMessage[] = [
      { role: 'tool_result', content: 'tool', timestamp: 1 },
      { role: 'assistant', content: 'a1', timestamp: 2 },
      { role: 'assistant', content: 'a2', timestamp: 3 },
    ];

    const result = sliceMessagesForFirstPaint(messages, byCountOnly(2));
    expect(result.messages).toEqual(messages.slice(1));
    expect(result.hasOlderRenderableMessages).toBe(false);
  });

  it('slices by renderable count and content budget together', () => {
    const messages: RawMessage[] = [
      { role: 'assistant', content: 'older compact', timestamp: 1 },
      { role: 'assistant', content: 'middle compact', timestamp: 2 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'large block '.repeat(160) },
          { type: 'image', data: 'x', mimeType: 'image/png' },
        ],
        timestamp: 3,
      },
    ];

    const result = sliceMessagesForFirstPaint(messages, {
      renderableLimit: 2,
      contentBudget: 2000,
    });

    expect(result.messages).toEqual(messages.slice(2));
    expect(result.hasOlderRenderableMessages).toBe(true);
  });

  it('keeps content budget density aligned with renderable limit when window grows', () => {
    const heavyText = 'x'.repeat(1400);
    const messages: RawMessage[] = Array.from({ length: 18 }, (_, index) => ({
      role: 'assistant',
      content: heavyText,
      timestamp: index + 1,
    }));

    const tightWindow = sliceMessagesForFirstPaint(messages, {
      renderableLimit: 8,
      contentBudget: 8200,
    });
    const expandedWindow = sliceMessagesForFirstPaint(messages, {
      renderableLimit: 12,
      contentBudget: 8200,
    });

    expect(expandedWindow.messages.length).toBeGreaterThan(tightWindow.messages.length);
    expect(expandedWindow.messages.length).toBeGreaterThanOrEqual(9);
    expect(expandedWindow.messages.length).toBeLessThanOrEqual(12);
  });

  it('advances first-paint budget state with count and content increments', () => {
    const first = advanceSessionRenderWindowBudgetState({
      phase: 'cold',
      budget: {
        renderableLimit: 8,
        contentBudget: 7600,
      },
      frameBudgetMs: 6,
      emaRenderCostMs: 0,
    }, {
      requestedStep: 20,
      reason: 'top-headroom',
      observedRenderCostMs: 3.2,
    });
    const second = advanceSessionRenderWindowBudgetState(first, {
      requestedStep: 24,
      reason: 'top-headroom',
      observedRenderCostMs: 6.8,
    });

    expect(first.phase).toBe('primed');
    expect(first.budget.renderableLimit).toBeGreaterThan(8);
    expect(first.budget.contentBudget).toBeGreaterThan(7600);
    expect(second.phase).toBe('expanded');
    expect(second.budget.renderableLimit).toBeGreaterThan(first.budget.renderableLimit);
    expect(second.budget.contentBudget).toBeGreaterThan(first.budget.contentBudget);
  });

  it('enters steady phase after expanded budget keeps advancing', () => {
    const primed = advanceSessionRenderWindowBudgetState({
      phase: 'primed',
      budget: {
        renderableLimit: 16,
        contentBudget: 9000,
      },
      frameBudgetMs: 6.4,
      emaRenderCostMs: 3.2,
    }, {
      requestedStep: 18,
      reason: 'top-headroom',
      observedRenderCostMs: 4.6,
    });
    const steady = advanceSessionRenderWindowBudgetState(primed, {
      requestedStep: 18,
      reason: 'top-headroom',
      observedRenderCostMs: 4.2,
    });

    expect(primed.phase).toBe('expanded');
    expect(steady.phase).toBe('steady');
    expect(steady.budget.renderableLimit).toBeGreaterThan(primed.budget.renderableLimit);
    expect(steady.budget.contentBudget).toBeGreaterThan(primed.budget.contentBudget);
  });

  it('adjusts budget growth and frame budget by render-cost pressure', () => {
    const baseline = {
      phase: 'expanded' as const,
      budget: {
        renderableLimit: 20,
        contentBudget: 9800,
      },
      frameBudgetMs: 6,
      emaRenderCostMs: 3,
    };
    const lowPressure = advanceSessionRenderWindowBudgetState(baseline, {
      requestedStep: 20,
      reason: 'underfill',
      observedRenderCostMs: 1.8,
    });
    const highPressure = advanceSessionRenderWindowBudgetState(baseline, {
      requestedStep: 20,
      reason: 'underfill',
      observedRenderCostMs: 10.5,
    });

    const lowPressureDelta = lowPressure.budget.renderableLimit - baseline.budget.renderableLimit;
    const highPressureDelta = highPressure.budget.renderableLimit - baseline.budget.renderableLimit;

    expect(lowPressureDelta).toBeGreaterThan(highPressureDelta);
    expect(lowPressure.frameBudgetMs).toBeGreaterThanOrEqual(baseline.frameBudgetMs);
    expect(highPressure.frameBudgetMs).toBeLessThanOrEqual(baseline.frameBudgetMs);
  });

  it('resolves larger top expand step when preheadroom budget grows', () => {
    const baseStep = resolveRenderableWindowExpandStep({
      reason: 'top-headroom',
      averageRowPx: 120,
      topBudgetPx: 320,
      viewportClientHeight: 320,
      viewportScrollHeight: 2800,
    });
    const highVelocityStep = resolveRenderableWindowExpandStep({
      reason: 'top-headroom',
      averageRowPx: 120,
      topBudgetPx: 1280,
      viewportClientHeight: 320,
      viewportScrollHeight: 2800,
    });

    expect(baseStep).toBeGreaterThanOrEqual(6);
    expect(highVelocityStep).toBeGreaterThan(baseStep);
  });

  it('reduces top expand step when viewport already has enough preheadroom rows', () => {
    const lackingHeadroomStep = resolveRenderableWindowExpandStep({
      reason: 'top-headroom',
      averageRowPx: 120,
      topBudgetPx: 640,
      rowsAboveViewport: 0,
      viewportClientHeight: 320,
      viewportScrollHeight: 2800,
    });
    const warmedHeadroomStep = resolveRenderableWindowExpandStep({
      reason: 'top-headroom',
      averageRowPx: 120,
      topBudgetPx: 640,
      rowsAboveViewport: 12,
      viewportClientHeight: 320,
      viewportScrollHeight: 2800,
    });

    expect(warmedHeadroomStep).toBeLessThan(lackingHeadroomStep);
    expect(warmedHeadroomStep).toBeGreaterThanOrEqual(6);
  });

  it('resolves underfill expand step from gap and clamps to max', () => {
    const moderateGapStep = resolveRenderableWindowExpandStep({
      reason: 'underfill',
      averageRowPx: 110,
      topBudgetPx: 0,
      viewportClientHeight: 900,
      viewportScrollHeight: 640,
    });
    const hugeGapStep = resolveRenderableWindowExpandStep({
      reason: 'underfill',
      averageRowPx: 72,
      topBudgetPx: 0,
      viewportClientHeight: 4200,
      viewportScrollHeight: 0,
    });

    expect(moderateGapStep).toBeGreaterThanOrEqual(4);
    expect(moderateGapStep).toBeLessThanOrEqual(28);
    expect(hugeGapStep).toBe(28);
  });
});
