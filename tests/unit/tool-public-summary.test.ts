import { describe, expect, it } from 'vitest';

import { buildToolActivityViewModel } from '../../src/pages/Chat/tool-activity-view-model';
import type { SessionRenderToolCard } from '../../src/types/session/tool-card';

type ToolCardInput = Pick<SessionRenderToolCard, 'name' | 'input'> & Partial<SessionRenderToolCard> & { details?: unknown };

function toolCard(overrides: ToolCardInput): SessionRenderToolCard {
  return {
    id: `tool-${overrides.name}`,
    name: overrides.name,
    displayTitle: overrides.displayTitle ?? overrides.name,
    input: overrides.input,
    inputText: overrides.inputText ?? JSON.stringify(overrides.input, null, 2),
    status: overrides.status ?? 'completed',
    runtimeAdapterId: overrides.runtimeAdapterId ?? 'matcha-agent',
    result: overrides.result ?? { kind: 'none', surface: 'tool-card' },
    ...overrides,
  };
}

function textResult(bodyText: string): SessionRenderToolCard['result'] {
  return {
    kind: 'text',
    surface: 'tool-card',
    collapsedPreview: bodyText,
    bodyText,
  };
}

function expandedText(activity: ReturnType<typeof buildToolActivityViewModel>): string {
  return activity.textBlocks
    .map((block) => [block.title, block.text].filter(Boolean).join('\n'))
    .join('\n');
}

describe('chat tool public summaries', () => {
  it('summarizes generic input and output shapes without expanding raw payloads', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'MysteryTool',
      displayTitle: '',
      input: {
        query: 'safe short query',
        command: 'curl https://private.local/token',
        payload: { token: 'private raw input secret', nested: true },
        items: [1, 2, 3],
      },
      output: {
        status: 'ok',
        bytes: 2048,
        path: 'E:/repo/out/result.txt',
        payload: { privateField: 'raw output secret', values: [1, 2] },
      },
      result: textResult(JSON.stringify({ rawToolOutput: 'must not show' })),
    }));
    const text = expandedText(activity);

    expect(text).toContain('输入');
    expect(text).toContain('对象：4 keys');
    expect(text).toContain('items: 数组：3 项');
    expect(text).toContain('输出');
    expect(text).toContain('status: ok');
    expect(text).toContain('bytes: 2048');
    expect(text).toContain('path: E:/repo/out/result.txt');
    expect(text).not.toContain('safe short query');
    expect(text).not.toContain('curl https://private.local/token');
    expect(text).not.toContain('private raw input secret');
    expect(text).not.toContain('raw output secret');
    expect(text).not.toContain('rawToolOutput');
  });

  it('uses short string length previews and suppresses private-looking strings', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'MysteryTool',
      displayTitle: '',
      input: 'plain public text',
      output: 'raw private token text',
      result: { kind: 'none', surface: 'tool-card' },
    }));
    const text = expandedText(activity);

    expect(text).toContain('字符串：17 字符；preview: plain public text');
    expect(text).toContain('字符串：22 字符');
    expect(text).not.toContain('raw private token text');
  });

  it('keeps OpenClaw detail allowlist scoped away from matcha-agent tools', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'MysteryTool',
      displayTitle: '',
      runtimeAdapterId: 'matcha-agent',
      input: {},
      details: {
        browserTab: { title: 'OpenClaw tab', targetId: 'private-target' },
        approvalReviews: [{ id: 'review-1', label: 'Reviewer', status: 'approved' }],
        diff: '+allowed only for generic detail text',
      },
    }));
    const text = expandedText(activity);

    expect(activity.browserTabPreview).toBeUndefined();
    expect(activity.approvalReviews).toBeUndefined();
    expect(text).toContain('详情');
    expect(text).toContain('diff: 字符串：37 字符');
    expect(text).not.toContain('OpenClaw tab');
    expect(text).not.toContain('Reviewer');
    expect(text).not.toContain('private-target');
  });
});
