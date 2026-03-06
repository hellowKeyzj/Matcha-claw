import { describe, expect, it } from 'vitest';
import { calculateMarkdownProgress } from '../../packages/openclaw-task-manager-plugin/src/progress-parser';

describe('task manager markdown progress parser', () => {
  it('calculates progress from markdown checklist', () => {
    const markdown = [
      '# 任务',
      '- [x] 步骤 1',
      '- [ ] 步骤 2',
      '- [X] 步骤 3',
    ].join('\n');

    const result = calculateMarkdownProgress(markdown);
    expect(result.total).toBe(3);
    expect(result.completed).toBe(2);
    expect(result.progress).toBeCloseTo(2 / 3);
  });

  it('ignores checklist lines inside fenced code blocks', () => {
    const markdown = [
      '- [x] 外部已完成',
      '```md',
      '- [ ] 代码块里的未完成',
      '- [x] 代码块里的已完成',
      '```',
      '- [ ] 外部未完成',
    ].join('\n');

    const result = calculateMarkdownProgress(markdown);
    expect(result.total).toBe(2);
    expect(result.completed).toBe(1);
    expect(result.progress).toBe(0.5);
  });
});
