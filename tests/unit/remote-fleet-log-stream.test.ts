import { describe, expect, it } from 'vitest';
import { normalizeRemoteFleetLogEvent, redactRemoteFleetLogLine } from '../../runtime-host/application/remote-fleet/remote-fleet-log-stream';

describe('remote fleet log stream seam', () => {
  it('redacts authorization headers, key/value secrets, auth schemes, and common secret tokens from log lines', () => {
    const redacted = redactRemoteFleetLogLine(
      [
        'POST /runtime',
        'Authorization: Bearer abc123',
        'Proxy-Authorization: Basic basic-secret',
        'token=tok_456',
        'secret="s3cr3t"',
        'password=plain',
        'api_key=key-789',
        '--access-token cli-token',
        'upstream bearer free-bearer',
        'downstream basic free-basic',
        'model sk-liveSecret_123',
        'fleet mrf_0123456789abcdef',
      ].join(' '),
    );

    expect(redacted).toContain('Authorization: [REDACTED]');
    expect(redacted).toContain('Proxy-Authorization: [REDACTED]');
    expect(redacted).toContain('token=[REDACTED]');
    expect(redacted).toContain('secret="[REDACTED]"');
    expect(redacted).toContain('password=[REDACTED]');
    expect(redacted).toContain('api_key=[REDACTED]');
    expect(redacted).toContain('--access-token [REDACTED]');
    expect(redacted).toContain('bearer [REDACTED]');
    expect(redacted).toContain('basic [REDACTED]');

    for (const plaintextSecret of [
      'abc123',
      'basic-secret',
      'tok_456',
      's3cr3t',
      'key-789',
      'cli-token',
      'free-bearer',
      'free-basic',
      'sk-liveSecret_123',
      'mrf_0123456789abcdef',
    ]) {
      expect(redacted).not.toContain(plaintextSecret);
    }
  });

  it('redacts quoted and unquoted stdout, stderr, and output assignments alongside credentials', () => {
    const redacted = redactRemoteFleetLogLine(
      [
        'stdout="stdout quoted fixture"',
        'stdout: stdout-unquoted-fixture',
        "stderr: 'stderr quoted fixture'",
        'stderr=stderr-unquoted-fixture',
        'output="output quoted fixture"',
        'output: output-unquoted-fixture',
        'Authorization: Bearer authorization-fixture',
        'mrf_mixedfixture123',
      ].join(' '),
    );

    expect(redacted).toBe([
      'stdout="[REDACTED]"',
      'stdout: [REDACTED]',
      "stderr: '[REDACTED]'",
      'stderr=[REDACTED]',
      'output="[REDACTED]"',
      'output: [REDACTED]',
      'Authorization: [REDACTED]',
      '[REDACTED]',
    ].join(' '));

    for (const plaintextValue of [
      'stdout quoted fixture',
      'stdout-unquoted-fixture',
      'stderr quoted fixture',
      'stderr-unquoted-fixture',
      'output quoted fixture',
      'output-unquoted-fixture',
      'authorization-fixture',
      'mrf_mixedfixture123',
    ]) {
      expect(redacted).not.toContain(plaintextValue);
    }
  });

  it('normalizes cursor, timestamp, dimensions, and redacts the event line', () => {
    const event = normalizeRemoteFleetLogEvent({
      nodeId: ' node-1 ',
      agentId: ' ',
      runtimeId: 'runtime-1',
      endpointId: ' endpoint-1 ',
      cursor: 42,
      occurredAt: new Date('2026-07-06T01:02:03.004Z'),
      stream: 'stderr',
      level: 'error',
      line: 'failed with Authorization=Bearer runtime-token',
    });

    expect(event).toEqual({
      nodeId: 'node-1',
      agentId: undefined,
      runtimeId: 'runtime-1',
      endpointId: 'endpoint-1',
      cursor: { value: '42' },
      occurredAt: '2026-07-06T01:02:03.004Z',
      stream: 'stderr',
      level: 'error',
      line: 'failed with Authorization=[REDACTED]',
    });
  });

  it('rejects empty cursors', () => {
    expect(() => normalizeRemoteFleetLogEvent({
      cursor: { value: '   ' },
      occurredAt: '2026-07-06T01:02:03.004Z',
      stream: 'system',
      line: 'ready',
    })).toThrow('Remote fleet log cursor must not be empty.');
  });
});
