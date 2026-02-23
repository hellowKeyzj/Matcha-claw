import { describe, expect, it } from 'vitest';
import {
  parseConvergenceDigestFromText,
  parseControllerDecisionFromText,
  parseExecutionBlueprintFromText,
  parseTeamReviewJsonFromText,
  validateTeamPlanProtocol,
  validateTeamReportProtocol,
} from '@/pages/Teams/lib/protocol';

describe('team protocol', () => {
  it('parses controller decision json', () => {
    const result = parseControllerDecisionFromText('CONTROLLER_DECISION: {"action":"ready_for_planning","reply":"ok"}');
    expect(result?.action).toBe('ready_for_planning');
    expect(result?.reply).toBe('ok');
  });

  it('parses controller decision ready_for_convergence action', () => {
    const result = parseControllerDecisionFromText('CONTROLLER_DECISION: {"action":"ready_for_convergence","reply":"start convergence"}');
    expect(result?.action).toBe('ready_for_convergence');
  });

  it('parses controller decision extended fields', () => {
    const result = parseControllerDecisionFromText(
      'CONTROLLER_DECISION: {"action":"ask_user","reply":"need input","questions":["q1"],"missing_info":["m1"],"ready_reason":"n/a"}',
    );
    expect(result?.action).toBe('ask_user');
    expect(result?.questions).toEqual(['q1']);
    expect(result?.missingInfo).toEqual(['m1']);
    expect(result?.readyReason).toBe('n/a');
  });

  it('parses review json', () => {
    const result = parseTeamReviewJsonFromText('REVIEW_JSON: {"agent_id":"dev","verdict":"approve","summary":"looks good","blockers":[],"required_decisions":[],"suggestions":[]}');
    expect(result?.agentId).toBe('dev');
    expect(result?.verdict).toBe('approve');
  });

  it('rejects approve review when blockers or required_decisions exist', () => {
    const result = parseTeamReviewJsonFromText(
      'REVIEW_JSON: {"agent_id":"dev","verdict":"approve","summary":"looks good","blockers":["need fix"],"required_decisions":[],"suggestions":[]}',
    );
    expect(result).toBeNull();
  });

  it('parses required_decisions from review json', () => {
    const result = parseTeamReviewJsonFromText(
      'REVIEW_JSON: {"agent_id":"dev","verdict":"revise","summary":"need decisions","blockers":[],"required_decisions":[{"key":"api","question":"choose api","default_value":"openai","options":["openai","claude"]}],"suggestions":[]}',
    );
    expect(result?.requiredDecisions).toEqual([
      {
        key: 'api',
        question: 'choose api',
        defaultValue: 'openai',
        options: ['openai', 'claude'],
      },
    ]);
  });

  it('parses execution blueprint json', () => {
    const result = parseExecutionBlueprintFromText(
      'EXECUTION_BLUEPRINT: {"action":"ready_to_execute","reply":"go","must_fix":[],"required_decisions_resolved":true,"assumptions":["default api=openai"]}',
    );
    expect(result?.action).toBe('ready_to_execute');
    expect(result?.requiredDecisionsResolved).toBe(true);
  });

  it('parses convergence digest json', () => {
    const result = parseConvergenceDigestFromText('CONVERGENCE_DIGEST_JSON: {"status":"continue","summary":"need one more round","agreements":[],"conflicts":["risk"],"open_questions":["confirm x"]}');
    expect(result?.status).toBe('continue');
    expect(result?.conflicts).toContain('risk');
  });

  it('validates team plan structure', () => {
    const valid = validateTeamPlanProtocol({
      objective: 'build',
      tasks: [{
        taskId: 'task-1',
        instruction: 'do',
        agentId: 'dev',
        acceptance: ['done'],
      }],
    });
    expect(valid.ok).toBe(true);
  });

  it('validates team report structure', () => {
    const valid = validateTeamReportProtocol({
      reportId: 'r1',
      task_id: 'task-1',
      agent_id: 'dev',
      status: 'done',
      result: ['ok'],
    });
    expect(valid.ok).toBe(true);
  });
});
