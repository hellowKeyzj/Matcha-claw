import { describe, expect, it } from 'vitest';
import { buildStepDetailRows, parseChecklist } from '@/pages/Tasks/checklist-parser';

describe('tasks checklist parser', () => {
  it('保留“完成情况：”换行明细并生成完成块', () => {
    const markdown = [
      '- [x] **步骤 4：补充业务定义**',
      '  - 根据代码实现反推业务逻辑',
      '  - 补充缺失的业务流程说明',
      '  - **完成情况**：',
      '    - ✅ 创建 `BUSINESS.md`',
      '    - ✅ 创建 `.task-manager/README.md`',
    ].join('\n');

    const steps = parseChecklist(markdown);
    expect(steps).toHaveLength(1);
    expect(steps[0].completionDetails).toHaveLength(2);

    const rows = buildStepDetailRows(steps[0]);
    const completionRow = rows.find((row) => row.type === 'completion');
    expect(completionRow).toBeTruthy();

    if (completionRow?.type === 'completion') {
      expect(completionRow.text).toBe('');
      expect(completionRow.details[0]).toContain('创建 BUSINESS.md');
    }
  });

  it('将证据从完成情况中分离为独立证据块', () => {
    const markdown = [
      '- [x] **步骤 5：输出完善后的文档**',
      '  - 更新或创建业务定义文档',
      '  - **完成情况**：已完成文档整理',
      '    - 结构已校对',
      '  - **证据**：',
      '    - BUSINESS.md',
      '    - BUSINESS_SUPPLEMENT.md',
    ].join('\n');

    const steps = parseChecklist(markdown);
    expect(steps).toHaveLength(1);
    expect(steps[0].completionDetails).toEqual(['结构已校对']);
    expect(steps[0].evidenceDetails).toEqual(['BUSINESS.md', 'BUSINESS_SUPPLEMENT.md']);

    const rows = buildStepDetailRows(steps[0]);
    const completionRow = rows.find((row) => row.type === 'completion');
    const evidenceRow = rows.find((row) => row.type === 'evidence');
    expect(completionRow).toBeTruthy();
    expect(evidenceRow).toBeTruthy();
    if (evidenceRow?.type === 'evidence') {
      expect(evidenceRow.details).toHaveLength(2);
    }
  });
});
