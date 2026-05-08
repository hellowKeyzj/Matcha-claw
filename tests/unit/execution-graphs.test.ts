import { describe, expect, it } from 'vitest';
import { deriveExecutionGraphSteps } from '../../runtime-host/application/sessions/execution-graphs';
import type { SessionTimelineEntry } from '../../runtime-host/shared/session-adapter-types';

function buildAssistantMessageEntry(
  partial: Partial<SessionTimelineEntry>,
): SessionTimelineEntry {
  return {
    key: partial.key ?? 'entry-1',
    kind: 'message',
    sessionKey: 'agent:main:main',
    role: 'assistant',
    text: '',
    status: 'final',
    laneKey: 'main',
    turnKey: 'main:run-1',
    thinking: null,
    assistantSegments: [],
    images: [],
    toolUses: [],
    attachedFiles: [],
    toolStatuses: [],
    toolCards: [],
    isStreaming: false,
    ...partial,
  } as SessionTimelineEntry;
}

describe('deriveExecutionGraphSteps', () => {
  it('keeps completed historical tool steps visible while a later tool is still streaming', () => {
    const steps = deriveExecutionGraphSteps([
      buildAssistantMessageEntry({
        key: 'history',
        toolUses: [{ id: 'tool-read', name: 'read', input: { filePath: '/tmp/a.md' } }],
        toolCards: [{ id: 'tool-read', name: 'read', displayTitle: 'read', input: { filePath: '/tmp/a.md' }, status: 'completed', result: { kind: 'none', surface: 'tool-card' } }],
      }),
      buildAssistantMessageEntry({
        key: 'stream',
        status: 'streaming',
        toolUses: [{ id: 'tool-grep', name: 'grep', input: { pattern: 'TODO' } }],
        toolStatuses: [{ toolCallId: 'tool-grep', name: 'grep', status: 'running' }],
        toolCards: [{ id: 'tool-grep', toolCallId: 'tool-grep', name: 'grep', displayTitle: 'grep', input: { pattern: 'TODO' }, status: 'running', result: { kind: 'none', surface: 'tool-card' } }],
        isStreaming: true,
      }),
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tool-read',
        label: 'read',
        status: 'completed',
      }),
      expect.objectContaining({
        id: 'tool-grep',
        label: 'grep',
        status: 'running',
      }),
    ]);
  });

  it('upgrades a historical tool step when streaming status reports a newer state', () => {
    const steps = deriveExecutionGraphSteps([
      buildAssistantMessageEntry({
        key: 'history',
        toolUses: [{ id: 'tool-read', name: 'read', input: { filePath: '/tmp/a.md' } }],
        toolCards: [{ id: 'tool-read', toolCallId: 'tool-read', name: 'read', displayTitle: 'read', input: { filePath: '/tmp/a.md' }, status: 'completed', result: { kind: 'none', surface: 'tool-card' } }],
      }),
      buildAssistantMessageEntry({
        key: 'stream',
        status: 'streaming',
        toolStatuses: [{ toolCallId: 'tool-read', name: 'read', status: 'error', summary: 'Permission denied' }],
        toolCards: [{ id: 'tool-read', toolCallId: 'tool-read', name: 'read', displayTitle: 'read', input: { filePath: '/tmp/a.md' }, status: 'error', summary: 'Permission denied', result: { kind: 'none', surface: 'tool-card' } }],
        isStreaming: true,
      }),
    ]);

    expect(steps).toEqual([
      expect.objectContaining({
        id: 'tool-read',
        label: 'read',
        status: 'error',
        detail: 'Permission denied',
      }),
    ]);
  });
});
