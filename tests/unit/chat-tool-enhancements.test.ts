import { describe, expect, it } from 'vitest';

import { buildToolActivityViewModel } from '../../src/pages/Chat/tool-activity-view-model';
import type { SessionRenderToolCard } from '../../src/types/session/tool-card';

type ToolCardInput = Pick<SessionRenderToolCard, 'name' | 'input'> & Partial<SessionRenderToolCard> & { details?: unknown };

function textResult(bodyText: string): SessionRenderToolCard['result'] {
  return {
    kind: 'text',
    surface: 'tool-card',
    collapsedPreview: bodyText,
    bodyText,
  };
}

function toolCard(overrides: ToolCardInput): SessionRenderToolCard {
  return {
    id: `tool-${overrides.name}`,
    name: overrides.name,
    displayTitle: overrides.displayTitle ?? overrides.name,
    input: overrides.input,
    inputText: overrides.inputText ?? JSON.stringify(overrides.input, null, 2),
    status: overrides.status ?? 'completed',
    runtimeAdapterId: overrides.runtimeAdapterId ?? 'openclaw',
    result: overrides.result ?? { kind: 'none', surface: 'tool-card' },
    ...overrides,
  };
}

function visibleText(activity: ReturnType<typeof buildToolActivityViewModel>): string {
  return [
    activity.title,
    ...activity.trailingLabels.map((label) => label.text),
  ].join('\n');
}

function expandedText(activity: ReturnType<typeof buildToolActivityViewModel>): string {
  return activity.textBlocks
    .map((block) => [block.title, block.text].filter(Boolean).join('\n'))
    .join('\n');
}

function allText(activity: ReturnType<typeof buildToolActivityViewModel>): string {
  return [visibleText(activity), expandedText(activity)].join('\n');
}

describe('chat tool detail enhancements', () => {
  it('renders multi-file details patch with expanded diff and visible change summary', () => {
    const patch = [
      'diff --git a/src/one.ts b/src/one.ts',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1 +1 @@',
      '-export const one = 1;',
      '+export const one = 2;',
      'diff --git a/src/two.ts b/src/two.ts',
      '--- a/src/two.ts',
      '+++ b/src/two.ts',
      '@@ -1 +1 @@',
      '-export const two = false;',
      '+export const two = true;',
    ].join('\n');
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Edit',
      input: { file_path: 'E:/repo/src/one.ts' },
      result: textResult('Updated 2 files'),
      details: { patch },
    }));
    const expanded = expandedText(activity);
    const visible = visibleText(activity);

    expect(expanded).toContain('diff --git a/src/one.ts b/src/one.ts');
    expect(expanded).toContain('diff --git a/src/two.ts b/src/two.ts');
    expect(expanded).toContain('-export const one = 1;');
    expect(expanded).toContain('+export const two = true;');
    expect(visible).toMatch(/(\+2[\s\S]*-2)|(-2[\s\S]*\+2)|(2\s*文件)|(2 files)|多文件/i);
  });

  it.each([
    { name: 'Edit', details: { liveDiffStat: { added: 3, removed: 1 } }, added: 3, removed: 1 },
    { name: 'Write', details: { stat: { added: 5, removed: 2 } }, added: 5, removed: 2 },
    { name: 'Edit', details: { added: 2, removed: 4 }, added: 2, removed: 4 },
  ])('renders running $name live diff stats from public details', ({ name, details, added, removed }) => {
    const activity = buildToolActivityViewModel(toolCard({
      name,
      status: 'running',
      input: { file_path: `E:/repo/src/${name.toLowerCase()}-live.ts` },
      details,
    }));
    const visible = visibleText(activity);

    expect(visible).toContain(`+${added}`);
    expect(visible).toContain(`-${removed}`);
  });

  it('does not invent running file diff stats when live fields are absent', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Edit',
      status: 'running',
      input: { file_path: 'E:/repo/src/no-live-stat.ts' },
    }));

    expect(visibleText(activity)).not.toMatch(/[+-]\d+/);
  });

  it('renders OpenClaw unknown tool generic details without private or specialized detail noise', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'MysteryTool',
      displayTitle: '',
      runtimeAdapterId: 'openclaw',
      input: {},
      result: textResult('Unknown tool completed'),
      details: {
        changed: true,
        diff: '+safe public detail',
        private: 'private-secret',
        raw: 'raw-secret',
        sourceReply: 'source-secret',
        toolInput: { token: 'input-secret' },
        toolOutput: { token: 'output-secret' },
        mcpAppPreview: { title: 'app-preview-noise', url: 'https://preview.local/app' },
        browserTab: { title: 'browser-tab-noise', url: 'https://browser.local/tab' },
        approvalReviews: [{ id: 'approval-review-noise', decision: 'approved' }],
      },
    }));
    const expanded = expandedText(activity);
    const text = allText(activity);

    expect(expanded).toContain('详情');
    expect(expanded).toContain('"changed": true');
    expect(expanded).toContain('+safe public detail');
    expect(text).not.toContain('private-secret');
    expect(text).not.toContain('raw-secret');
    expect(text).not.toContain('source-secret');
    expect(text).not.toContain('input-secret');
    expect(text).not.toContain('output-secret');
    expect(text).not.toContain('"mcpAppPreview"');
    expect(text).not.toContain('"browserTab"');
    expect(text).not.toContain('"approvalReviews"');
    expect(text).not.toContain('app-preview-noise');
    expect(text).not.toContain('browser-tab-noise');
    expect(text).not.toContain('approval-review-noise');
  });

  it('keeps shell details for truncation, full output path, and exit code', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Bash',
      input: { command: 'pnpm test' },
      output: { stdout: 'partial stdout', exitCode: 0 },
      result: textResult(JSON.stringify({ stdout: 'partial stdout', exitCode: 0 })),
      details: { exitCode: 7, truncation: true, fullOutputPath: 'E:/repo/.matcha/shell/full-output.log' },
    }));
    const text = allText(activity);

    expect(activity.tone).toBe('danger');
    expect(activity.isError).toBe(true);
    expect(text).toContain('partial stdout');
    expect(text).toContain('exit 7');
    expect(text).toContain('输出已截断');
    expect(text).toContain('E:/repo/.matcha/shell/full-output.log');
    expect(text).not.toContain('exit 0');
    expect(text).not.toContain('"exitCode"');
    expect(text).not.toContain('"truncation"');
    expect(text).not.toContain('"fullOutputPath"');
  });
});
