import { describe, it, expect } from 'vitest';
import { parseReportFromText } from '@/lib/report-parser';

describe('parseReportFromText', () => {
  it('parses REPORT JSON from final reply text', () => {
    const text = 'Done.\nREPORT: {"reportId":"T-1:a:run-1","task_id":"T-1","agent_id":"a","status":"done","result":["x"]}';
    const report = parseReportFromText(text);
    expect(report?.reportId).toBe('T-1:a:run-1');
    expect(report?.status).toBe('done');
  });

  it('parses REPORT fenced JSON and normalizes completed status', () => {
    const text = [
      'REPORT: ```json',
      '{',
      '  "task_id":"task-1",',
      '  "agent_id":"matcha",',
      '  "status":"completed",',
      '  "summary":"all good"',
      '}',
      '```',
    ].join('\n');
    const report = parseReportFromText(text);
    expect(report?.reportId).toBe('task-1:matcha:generated');
    expect(report?.status).toBe('done');
    expect(report?.result).toEqual(['all good']);
  });

  it('parses nested REPORT object payload', () => {
    const text = 'REPORT: {"report":{"task_id":"task-2","agent_id":"dev","status":"partial","result":["draft"]}}';
    const report = parseReportFromText(text);
    expect(report?.reportId).toBe('task-2:dev:generated');
    expect(report?.status).toBe('partial');
    expect(report?.result).toEqual(['draft']);
  });

  it('returns null when REPORT missing', () => {
    expect(parseReportFromText('no report')).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    const text = 'REPORT: {"bad": }';
    expect(parseReportFromText(text)).toBeNull();
  });

  it('fills missing task/agent from defaults when provided', () => {
    const text = 'REPORT: {"status":"done","result":["ok"]}';
    const report = parseReportFromText(text, {
      defaultTaskId: 'task-9',
      defaultAgentId: 'coding-agent',
    });
    expect(report?.task_id).toBe('task-9');
    expect(report?.agent_id).toBe('coding-agent');
    expect(report?.reportId).toBe('task-9:coding-agent:generated');
  });
});
