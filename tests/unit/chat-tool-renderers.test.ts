import { describe, expect, it } from 'vitest';

import { buildToolActivityViewModel } from '../../src/pages/Chat/tool-activity-view-model';
import { projectSessionViewItems } from '../../src/stores/chat/store-state-helpers';
import type { SessionView } from '../../src/types/session/snapshot';
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

type OpenClawToolActivityPreview = ReturnType<typeof buildToolActivityViewModel> & {
  mcpAppPreview?: {
    title: string;
    url: string;
    preferredHeight?: number;
    rawText?: string;
  };
  browserTabPreview?: {
    title: string;
    url: string;
    profile?: string;
    targetId?: string;
  };
  approvalReviews?: Array<{
    label: string;
    status: string;
    rationale?: string;
  }>;
  approvalReviewOutcome?: {
    label: string;
    status: string;
    rationale?: string;
  };
  progressReceipt?: {
    completedCount: number;
    totalCount: number;
    currentItem?: string;
  };
};

function mcpPreview(activity: ReturnType<typeof buildToolActivityViewModel>): OpenClawToolActivityPreview['mcpAppPreview'] {
  const previewActivity = activity as OpenClawToolActivityPreview;
  return previewActivity.canvasPreview ?? previewActivity.mcpAppPreview;
}

function sessionView(runtimeAdapterId: 'openclaw' | 'matcha-agent'): SessionView {
  return {
    sessionKey: `session:${runtimeAdapterId}`,
    endpointSessionId: null,
    identity: {
      sessionKey: `session:${runtimeAdapterId}`,
      endpoint: { kind: 'native-runtime', runtimeAdapterId, runtimeInstanceId: 'local' },
      agentId: 'main',
    },
    epoch: 1,
    seq: 1,
    cursor: 1,
    items: {
      complete: [{
        kind: 'assistantTurn',
        itemId: `assistant:${runtimeAdapterId}`,
        runId: 'run-1',
        messageId: 'message-1',
        status: 'final',
        segments: [{ kind: 'toolUse', name: 'Read', toolCallId: 'tool-1' }],
        text: '',
      }],
    },
    tools: {
      complete: [{
        toolCallId: 'tool-1',
        runId: 'run-1',
        name: 'Read',
        phase: 'completed',
        input: { file_path: `src/${runtimeAdapterId}.ts` },
        inputText: null,
        summary: null,
        output: 'done',
        details: null,
        isError: null,
      }],
    },
    approvals: { complete: [] },
    runtime: { complete: { phase: 'completed', activeRunId: null, issue: null } },
    window: { complete: { totalItemCount: 1, windowStartOffset: 0, windowEndOffset: 1, hasMore: false, hasNewer: false, isAtLatest: true } },
    completeness: 'complete',
  };
}

describe('chat tool activity renderers', () => {
  it.each([
    {
      name: 'Write',
      input: {
        file_path: 'E:/repo/src/generated.ts',
        content: 'export const rawJsonLeak = true;\n',
      },
      forbidden: ['"file_path"', '"content"'],
    },
    {
      name: 'Edit',
      input: {
        file_path: 'E:/repo/src/generated.ts',
        old_string: 'const value = 1;',
        new_string: 'const value = 2;',
      },
      forbidden: ['"file_path"', '"old_string"', '"new_string"'],
    },
  ])('renders $name file operations without raw JSON', ({ name, input, forbidden }) => {
    const activity = buildToolActivityViewModel(toolCard({
      name,
      input,
      result: textResult('Updated E:/repo/src/generated.ts'),
    }));
    const text = allText(activity);

    expect(text).toContain('E:/repo/src/generated.ts');
    for (const rawKey of forbidden) {
      expect(text).not.toContain(rawKey);
    }
  });

  it('renders OpenClaw file write content blocks without raw result JSON', () => {
    const output = [{
      type: 'text',
      text: 'Successfully wrote 3559 bytes to C:\\Users\\Mr.Key\\.openclaw\\workspace-subagents\\agent\\虚构示例.md',
    }];
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Write',
      input: {},
      output,
      result: {
        kind: 'json',
        surface: 'tool-card',
        collapsedPreview: JSON.stringify(output),
        bodyText: JSON.stringify(output, null, 2),
      },
    }));
    const text = allText(activity);

    expect(text).toContain('写入 虚构示例.md');
    expect(text).toContain('Successfully wrote 3559 bytes');
    expect(text).not.toContain('"type"');
    expect(text).not.toContain('"text"');
  });

  it('renders created file content as a generated diff preview', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Write',
      input: {
        file_path: 'E:/repo/src/generated.md',
        content: '# Title\n\nBody\n',
      },
      result: textResult('Successfully wrote 14 bytes to E:/repo/src/generated.md'),
    }));
    const text = expandedText(activity);

    expect(text).toContain('差异');
    expect(text).not.toContain('内容');
    expect(text).not.toContain('--- /dev/null');
    expect(text).not.toContain('+++ b/E:/repo/src/generated.md');
    expect(text).toContain('+# Title');
    expect(text).toContain('+Body');
    expect(activity.diffStatPlacement).toBe('header');
    expect(visibleText(activity)).toContain('+3');
    expect(visibleText(activity)).not.toContain('3 行');
    expect(text).not.toContain('"file_path"');
    expect(text).not.toContain('"content"');
  });

  it('renders file diff from structured result without duplicate content blocks', () => {
    const output = {
      type: 'update',
      filePath: 'E:/repo/src/generated.ts',
      content: 'const value = 2;\nconst next = 3;\n',
      originalFile: 'const value = 1;\n',
      structuredPatch: [{
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: ['-const value = 1;', '+const value = 2;', '+const next = 3;'],
      }],
    };
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Edit',
      input: { file_path: 'E:/repo/src/generated.ts' },
      output,
      result: {
        kind: 'json',
        surface: 'tool-card',
        collapsedPreview: JSON.stringify(output),
        bodyText: JSON.stringify(output, null, 2),
      },
    }));
    const text = allText(activity);

    expect(text).toContain('差异');
    expect(text).not.toContain('原始内容');
    expect(text).toContain('-const value = 1;');
    expect(text).toContain('+const next = 3;');
    expect(activity.diffStatPlacement).toBe('header');
    expect(visibleText(activity)).toContain('+2');
    expect(visibleText(activity)).toContain('-1');
    expect(text).not.toContain('"structuredPatch"');
    expect(text).not.toContain('"originalFile"');
  });

  it('prefers OpenClaw details diff over output and input fallbacks', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Edit',
      input: {
        file_path: 'E:/repo/src/generated.ts',
        old_string: 'input old',
        new_string: 'input new',
      },
      details: { diff: '-details old\n+details new' },
      output: { diff: '-output old\n+output new' },
      result: { kind: 'json', surface: 'tool-card', collapsedPreview: '{}', bodyText: '{}' },
    }));
    const text = allText(activity);

    expect(text).toContain('-details old');
    expect(text).toContain('+details new');
    expect(text).not.toContain('-output old');
    expect(text).not.toContain('input old');
    expect(activity.diffStatPlacement).toBe('header');
    expect(visibleText(activity)).toContain('+1');
    expect(visibleText(activity)).toContain('-1');
  });

  it('builds a readable diff from old and new string fallback', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Edit',
      input: {
        file_path: 'E:/repo/src/generated.ts',
        old_string: 'const value = 1;\nconst oldOnly = true;',
        new_string: 'const value = 2;\nconst next = 3;',
      },
      result: textResult('Updated E:/repo/src/generated.ts'),
    }));
    const text = allText(activity);

    expect(text).toContain('差异');
    expect(text).toContain('-const value = 1;');
    expect(text).toContain('-const oldOnly = true;');
    expect(text).toContain('+const value = 2;');
    expect(text).toContain('+const next = 3;');
    expect(visibleText(activity)).toContain('+2');
    expect(visibleText(activity)).toContain('-2');
    expect(text).not.toContain('"old_string"');
    expect(text).not.toContain('"new_string"');
  });

  it('shows update content when original content is absent', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Edit',
      input: { file_path: 'E:/repo/src/generated.ts' },
      output: {
        type: 'update',
        content: 'const value = 2;',
      },
      result: { kind: 'json', surface: 'tool-card', collapsedPreview: '{}', bodyText: '{}' },
    }));
    const text = expandedText(activity);

    expect(text).toContain('更新内容');
    expect(text).toContain('const value = 2;');
    expect(text).not.toContain('原始内容');
  });

  it('renders shell command and stdout', () => {
    const command = 'pnpm vitest run tests/unit/chat-tool-renderers.test.ts';
    const stdout = 'stdout: 1 test passed';
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Bash',
      input: { command },
      result: textResult(stdout),
    }));
    const text = expandedText(activity);

    expect(text).toContain(command);
    expect(text).toContain(stdout);
  });

  it('renders shell content block output without raw JSON', () => {
    const command = 'printf "from content block"';
    const output = [{
      type: 'tool_result',
      content: [{ type: 'text', text: 'from content block' }],
    }];
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Bash',
      input: { command },
      output,
      result: {
        kind: 'json',
        surface: 'tool-card',
        collapsedPreview: JSON.stringify(output),
        bodyText: JSON.stringify(output, null, 2),
      },
    }));
    const text = allText(activity);

    expect(text).toContain(command);
    expect(text).toContain('from content block');
    expect(text).not.toContain('"type"');
    expect(text).not.toContain('"content"');
    expect(text).not.toContain('"text"');
  });

  it('renders shell details for truncation, full output path, and exit code', () => {
    const command = 'pnpm test';
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Bash',
      input: { command },
      output: { stdout: 'partial stdout', exitCode: 0 },
      result: textResult(JSON.stringify({ stdout: 'partial stdout', exitCode: 0 })),
      ...{ details: { exitCode: 2, truncation: true, fullOutputPath: 'E:/repo/.matcha/shell/full-output.log' } },
    }));
    const text = allText(activity);

    expect(activity.tone).toBe('danger');
    expect(activity.isError).toBe(true);
    expect(text).toContain('partial stdout');
    expect(text).toContain('exit 2');
    expect(text).toContain('输出已截断');
    expect(text).toContain('E:/repo/.matcha/shell/full-output.log');
    expect(text).not.toContain('exit 0');
    expect(text).not.toContain('"exitCode"');
    expect(text).not.toContain('"truncation"');
    expect(text).not.toContain('"fullOutputPath"');
  });

  it('renders search pattern and path without raw JSON', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Grep',
      input: {
        path: 'src/pages/Chat',
        pattern: 'buildToolActivityViewModel',
      },
      result: textResult('src/pages/Chat/tool-activity-view-model.ts'),
    }));
    const text = allText(activity);

    expect(text).toContain('src/pages/Chat');
    expect(text).toContain('buildToolActivityViewModel');
    expect(text).not.toContain('"path"');
    expect(text).not.toContain('"pattern"');
  });

  it('renders read path without raw JSON', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Read',
      input: { file_path: 'src/pages/Chat/tool-activity-view-model.ts' },
      result: textResult('export function buildToolActivityViewModel'),
    }));
    const text = allText(activity);

    expect(text).toContain('src/pages/Chat/tool-activity-view-model.ts');
    expect(text).not.toContain('"file_path"');
  });

  it('renders skill name without raw JSON', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Skill',
      input: { skill: 'graphify', args: 'capture this' },
      result: textResult('Skill completed'),
    }));
    const text = allText(activity);

    expect(text).toContain('graphify');
    expect(text).not.toContain('"skill"');
    expect(text).not.toContain('"args"');
  });

  it('renders skill content block output as plain text', () => {
    const output = [{
      type: 'tool_result',
      content: [{ type: 'text', text: 'Skill block output' }],
    }];
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Skill',
      input: { skill: 'graphify' },
      output,
      result: {
        kind: 'json',
        surface: 'tool-card',
        collapsedPreview: JSON.stringify(output),
        bodyText: JSON.stringify(output, null, 2),
      },
    }));
    const text = allText(activity);

    expect(text).toContain('Skill block output');
    expect(text).not.toContain('"type"');
    expect(text).not.toContain('"content"');
  });

  it('renders agent content block output as plain text', () => {
    const output = [{
      type: 'tool_result',
      content: [{ type: 'text', text: 'Agent block output' }],
    }];
    const activity = buildToolActivityViewModel(toolCard({
      name: 'Agent',
      input: { description: 'summarize logs' },
      output,
      result: {
        kind: 'json',
        surface: 'tool-card',
        collapsedPreview: JSON.stringify(output),
        bodyText: JSON.stringify(output, null, 2),
      },
    }));
    const text = allText(activity);

    expect(text).toContain('summarize logs');
    expect(text).toContain('Agent block output');
    expect(text).not.toContain('"type"');
    expect(text).not.toContain('"content"');
  });

  it('renders web host and query without raw JSON', () => {
    const fetchActivity = buildToolActivityViewModel(toolCard({
      name: 'WebFetch',
      input: { url: 'https://docs.matcha.local/runtime-host?section=events' },
      result: textResult('Runtime host events'),
    }));
    const searchActivity = buildToolActivityViewModel(toolCard({
      name: 'WebSearch',
      input: { query: 'runtime host owner model' },
      result: textResult('Search result'),
    }));
    const text = [allText(fetchActivity), allText(searchActivity)].join('\n');

    expect(text).toContain('docs.matcha.local');
    expect(text).toContain('runtime host owner model');
    expect(text).not.toContain('"url"');
    expect(text).not.toContain('"query"');
  });

  it('normalizes OpenClaw content block output for Grep and WebFetch renderers', () => {
    const output = [{
      type: 'tool_result',
      content: [{ type: 'text', text: 'src/pages/Chat/tool-renderers/search.ts' }],
    }];
    const grepActivity = buildToolActivityViewModel(toolCard({
      name: 'Grep',
      input: { path: 'src/pages/Chat', pattern: 'renderSearchToolActivity' },
      output,
      result: {
        kind: 'json',
        surface: 'tool-card',
        collapsedPreview: JSON.stringify(output),
        bodyText: JSON.stringify(output, null, 2),
      },
    }));
    const fetchActivity = buildToolActivityViewModel(toolCard({
      name: 'WebFetch',
      input: { url: 'https://docs.matcha.local/runtime-host' },
      output: [{
        type: 'tool_result',
        content: [{ type: 'text', text: 'Runtime host events' }],
      }],
    }));
    const text = [expandedText(grepActivity), expandedText(fetchActivity)].join('\n');

    expect(text).toContain('src/pages/Chat/tool-renderers/search.ts');
    expect(text).toContain('Runtime host events');
    expect(text).not.toContain('"type"');
    expect(text).not.toContain('"content"');
  });

  it('projects runtime identity onto tool cards for runtime-specific renderer selection', () => {
    for (const runtimeAdapterId of ['openclaw', 'matcha-agent'] as const) {
      const [item] = projectSessionViewItems(sessionView(runtimeAdapterId));
      expect(item?.kind).toBe('assistant-turn');
      if (item?.kind !== 'assistant-turn') throw new Error('expected assistant turn');
      const [tool] = item.tools;
      expect(tool?.runtimeAdapterId).toBe(runtimeAdapterId);
      expect(buildToolActivityViewModel(tool!).title).toContain(`src/${runtimeAdapterId}.ts`);
    }
  });

  it('projects OpenClaw mcpAppPreview details into a preview instead of raw text blocks', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'demo__show',
      runtimeAdapterId: 'openclaw',
      input: {},
      output: [{ type: 'text', text: 'App rendered' }],
      details: {
        mcpAppPreview: {
          kind: 'canvas',
          surface: 'assistant_message',
          render: 'url',
          title: 'Demo App',
          url: 'https://preview.local/app',
          preferredHeight: 420,
          viewId: 'cv-demo-app',
        },
      },
    }));
    const preview = mcpPreview(activity);
    const text = expandedText(activity);

    expect(preview).toMatchObject({
      title: 'Demo App',
      url: 'https://preview.local/app',
      preferredHeight: 420,
    });
    expect(text).not.toContain('"mcpAppPreview"');
    expect(text).not.toContain('"viewId"');
    expect(text).not.toContain('cv-demo-app');
  });

  it('projects OpenClaw browserTab details into a dedicated preview without raw JSON text', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'browser',
      runtimeAdapterId: 'openclaw',
      input: { action: 'open' },
      details: {
        browserTab: {
          title: 'Example',
          url: 'https://example.com/page',
          target: 'host',
          profile: 'managed',
          targetId: 'tab-1',
          cdpUrl: 'ws://private-debug-target',
        },
      },
    }));
    const preview = (activity as OpenClawToolActivityPreview).browserTabPreview;
    const text = allText(activity);

    expect(preview).toMatchObject({
      title: 'Example',
      url: 'https://example.com/page',
      profile: 'managed',
      targetId: 'tab-1',
    });
    expect(text).not.toContain('"browserTab"');
    expect(text).not.toContain('"targetId"');
    expect(text).not.toContain('ws://private-debug-target');
  });

  it('renders OpenClaw approval reviews with valid states only and without private text', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'run_command',
      runtimeAdapterId: 'openclaw',
      input: { command: 'git status' },
      details: {
        approvalReviews: [
          {
            id: 'review-1',
            label: 'Guardian',
            status: 'approved',
            rationale: 'Narrowly scoped to the requested file.',
            privateNotes: 'review-private-secret',
          },
          {
            id: 'review-2',
            label: 'Invalid reviewer',
            status: 'escalated',
            rationale: 'invalid-rationale-leak',
          },
          {
            id: 'review-3',
            label: 'Policy',
            status: 'in_progress',
            rationale: 'Checking workspace policy.',
          },
        ],
        approvalReviewOutcome: 'reviewing',
        privatePayload: 'approval-private-secret',
      },
    }));
    const preview = activity as OpenClawToolActivityPreview;
    const text = allText(activity);

    expect(preview.approvalReviews).toEqual([
      expect.objectContaining({
        label: 'Guardian',
        status: 'approved',
        rationale: 'Narrowly scoped to the requested file.',
      }),
      expect.objectContaining({
        label: 'Policy',
        status: 'in_progress',
        rationale: 'Checking workspace policy.',
      }),
    ]);
    expect(preview.approvalReviewOutcome).toMatchObject({
      label: expect.any(String),
      status: 'reviewing',
    });
    expect(preview.approvalReviews?.some((review) => review.status === 'escalated')).toBe(false);
    expect(text).not.toContain('Invalid reviewer');
    expect(text).not.toContain('invalid-rationale-leak');
    expect(text).not.toContain('review-private-secret');
    expect(text).not.toContain('approval-private-secret');
  });

  it('drops invalid OpenClaw approval review and outcome states', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'run_command',
      runtimeAdapterId: 'openclaw',
      input: { command: 'git status' },
      details: {
        approvalReviews: [{ id: 'review-invalid', label: 'Invalid reviewer', status: 'escalated', rationale: 'invalid-rationale-leak' }],
        approvalReviewOutcome: 'escalated',
      },
    }));
    const preview = activity as OpenClawToolActivityPreview;
    const text = allText(activity);

    expect(preview.approvalReviews ?? []).toHaveLength(0);
    expect(preview.approvalReviewOutcome).toBeUndefined();
    expect(text).not.toContain('Invalid reviewer');
    expect(text).not.toContain('invalid-rationale-leak');
    expect(text).not.toContain('escalated');
  });

  it('renders OpenClaw progress_card as a progress receipt without raw plan JSON', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'progress_card',
      runtimeAdapterId: 'openclaw',
      input: {
        markdown: 'Implementation is moving.',
        plan: [
          { step: 'Inspect', status: 'completed' },
          { step: 'Implement', status: 'in_progress' },
          { step: 'Verify', status: 'pending' },
        ],
      },
      result: textResult('Progress card updated'),
    }));
    const preview = activity as OpenClawToolActivityPreview;
    const text = allText(activity);

    expect(preview.progressReceipt).toMatchObject({
      completedCount: 1,
      totalCount: 3,
      currentItem: 'Implement',
    });
    expect(text).toMatch(/1\s*\/\s*3/);
    expect(text).toContain('Implement');
    expect(text).not.toContain('"plan"');
    expect(text).not.toContain('"step"');
    expect(text).not.toContain('"status"');
  });

  it('does not apply OpenClaw detail previews to matcha-agent tools', () => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'browser',
      runtimeAdapterId: 'matcha-agent',
      input: { url: 'https://matcha-agent.local' },
      details: {
        mcpAppPreview: {
          kind: 'canvas',
          title: 'Demo App',
          url: 'https://preview.local/app',
        },
        browserTab: {
          title: 'Example',
          url: 'https://example.com/page',
          profile: 'managed',
          targetId: 'tab-1',
        },
        approvalReviews: [{ id: 'review-1', label: 'Guardian', status: 'approved', rationale: 'safe' }],
        approvalReviewOutcome: 'approved',
      },
    }));
    const preview = activity as OpenClawToolActivityPreview;

    expect(mcpPreview(activity)).toBeUndefined();
    expect(preview.browserTabPreview).toBeUndefined();
    expect(preview.approvalReviews).toBeUndefined();
    expect(preview.approvalReviewOutcome).toBeUndefined();
  });

  it('uses generic fallback for unknown tools with raw JSON only in expanded content', () => {
    const rawInput = {
      arbitrary: 'raw-json-marker',
      nested: { enabled: true },
    };
    const activity = buildToolActivityViewModel(toolCard({
      name: 'MysteryTool',
      displayTitle: '',
      input: rawInput,
      inputText: JSON.stringify(rawInput, null, 2),
      result: textResult('Unknown tool completed'),
    }));

    expect(activity.title).toContain('MysteryTool');
    expect(visibleText(activity)).not.toContain('raw-json-marker');
    expect(visibleText(activity)).not.toContain('"arbitrary"');
    expect(activity.canExpand).toBe(true);
    expect(expandedText(activity)).toContain('"arbitrary"');
    expect(expandedText(activity)).toContain('raw-json-marker');
  });

  it('renders generic details only in expanded content without private fields', () => {
    const output = [{ type: 'text', text: 'Primary output' }];
    const activity = buildToolActivityViewModel(toolCard({
      name: 'MysteryTool',
      displayTitle: '',
      displayDetail: 'Stable detail title',
      input: {},
      output,
      summary: 'summary noise',
      result: {
        kind: 'json',
        surface: 'tool-card',
        collapsedPreview: 'collapsed preview noise',
        bodyText: JSON.stringify(output),
      },
      details: {
        changed: true,
        diff: '+const next = 3;',
        private: 'private-secret',
        sourceReply: 'source-secret',
        rawPayload: { token: 'raw-secret' },
        toolInput: { command: 'private command' },
      },
    } as ToolCardInput & { details: unknown }));
    const visible = visibleText(activity);
    const expanded = expandedText(activity);
    const text = allText(activity);

    expect(visible).not.toContain('changed');
    expect(visible).not.toContain('+const next = 3;');
    expect(expanded).toContain('Primary output');
    expect(expanded).toContain('详情');
    expect(expanded).toContain('changed: true');
    expect(expanded).toContain('diff: 字符串');
    expect(text).not.toContain('summary noise');
    expect(text).not.toContain('collapsed preview noise');
    expect(text).not.toContain('private-secret');
    expect(text).not.toContain('source-secret');
    expect(text).not.toContain('raw-secret');
    expect(text).not.toContain('private command');
  });

  it.each([
    [[{ type: 'toolResult', text: 'x' }]],
    [{ type: 'toolresult', content: 'x' }],
    [{ type: 'tool_use_result', content: [{ type: 'text', text: 'x' }] }],
  ])('normalizes OpenClaw tool result content blocks without raw keys', (output) => {
    const activity = buildToolActivityViewModel(toolCard({
      name: 'MysteryTool',
      displayTitle: '',
      input: {},
      output,
      result: {
        kind: 'json',
        surface: 'tool-card',
        collapsedPreview: JSON.stringify(output),
        bodyText: JSON.stringify(output, null, 2),
      },
    }));
    const text = expandedText(activity);

    expect(text).toContain('x');
    expect(text).not.toContain('"type"');
    expect(text).not.toContain('"text"');
    expect(text).not.toContain('"content"');
  });
});
