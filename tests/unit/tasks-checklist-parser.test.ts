import { describe, expect, it } from 'vitest';
import {
  buildStepDetailRows,
  countProgress,
  parseChecklist,
} from '@/pages/Tasks/checklist-parser';

describe('tasks checklist parser', () => {
  it('解析 markdown checklist，并支持完成情况与证据区块', () => {
    const markdown = [
      '- [x] 一级步骤',
      '  - [x] 子步骤 A',
      '    完成情况：已完成',
      '    - 处理了参数校验',
      '    证据：截图 A',
      '    - 日志 B',
      '  - [ ] 子步骤 B',
      '',
      '- [ ] 第二个步骤',
      '  - [ ] 子项 C',
    ].join('\n');

    const checklist = parseChecklist(markdown);
    expect(checklist).toHaveLength(2);
    expect(checklist[0]?.text).toBe('一级步骤');
    expect(checklist[0]?.children).toHaveLength(2);
    expect(checklist[0]?.children[0]?.completionNote).toBe('已完成');
    expect(checklist[0]?.children[0]?.completionDetails).toEqual(['处理了参数校验']);
    expect(checklist[0]?.children[0]?.evidenceDetails).toEqual(['截图 A', '日志 B']);
  });

  it('countProgress 按叶子节点聚合进度', () => {
    const checklist = parseChecklist([
      '- [x] step 1',
      '  - [x] child 1',
      '  - [ ] child 2',
    ].join('\n'));
    const progress = countProgress(checklist[0]!);
    expect(progress).toEqual({ done: 1, total: 2 });
  });

  it('buildStepDetailRows 产出 item/note/completion/evidence 行', () => {
    const checklist = parseChecklist([
      '- [x] step 1',
      '  - [x] child 1',
      '    完成情况：ok',
      '    - detail',
      '    证据：screenshot',
      '  - [ ] child 2',
    ].join('\n'));
    const rows = buildStepDetailRows(checklist[0]!);
    expect(rows.some((row) => row.type === 'item')).toBe(true);
    expect(rows.some((row) => row.type === 'completion')).toBe(true);
    expect(rows.some((row) => row.type === 'evidence')).toBe(true);
  });
});
