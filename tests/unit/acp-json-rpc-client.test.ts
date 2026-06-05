import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { encodeAcpJsonRpcMessage } from '../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-framing';
import { AcpJsonRpcClient } from '../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-json-rpc-client';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  default: { spawn: spawnMock },
  spawn: spawnMock,
}));

class MockChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  readonly writes: string[] = [];
  readonly stdin = new Writable({
    write: (chunk, _encoding, callback) => {
      this.writes.push(chunk.toString());
      callback();
    },
  });

  kill(): boolean {
    this.killed = true;
    this.emit('exit', 0, null);
    return true;
  }
}

function createClient() {
  const child = new MockChild();
  spawnMock.mockReturnValueOnce(child);
  const client = new AcpJsonRpcClient({
    endpointId: 'claude-code',
    launcher: { command: 'acp-server', args: ['--stdio'] },
  });
  return { child, client };
}

describe('ACP JSON-RPC client', () => {
  it('resolves matching responses and ignores unknown response ids', async () => {
    const { child, client } = createClient();
    const request = client.request('session/prompt', { message: 'hello' });

    child.stdout.emit('data', encodeAcpJsonRpcMessage({ jsonrpc: '2.0', id: 999, result: 'ignored' }));
    child.stdout.emit('data', encodeAcpJsonRpcMessage({ jsonrpc: '2.0', id: 1, result: { ok: true } }));

    await expect(request).resolves.toEqual({ ok: true });
    expect(spawnMock).toHaveBeenCalledWith('acp-server', ['--stdio'], expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }));
  });

  it('rejects pending requests when the child exits', async () => {
    const { child, client } = createClient();
    const request = client.request('session/prompt', { message: 'hello' });

    child.emit('exit', 1, null);

    await expect(request).rejects.toThrow('ACP process exited: claude-code');
  });

  it('times out unanswered requests', async () => {
    vi.useFakeTimers();
    try {
      const { client } = createClient();
      const assertion = expect(client.request('session/prompt', { message: 'hello' }, 10))
        .rejects.toThrow('ACP request timed out: session/prompt');

      await vi.advanceTimersByTimeAsync(10);

      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops old epoch output after restart and resolves the new process response', async () => {
    const firstChild = new MockChild();
    const secondChild = new MockChild();
    spawnMock.mockReturnValueOnce(firstChild).mockReturnValueOnce(secondChild);
    const client = new AcpJsonRpcClient({
      endpointId: 'hermes',
      launcher: { command: 'hermes', args: ['acp'] },
    });

    const firstRequest = client.request('session/prompt', { message: 'first' });
    firstChild.emit('exit', 1, null);
    await expect(firstRequest).rejects.toThrow('ACP process exited: hermes');

    const secondRequest = client.request('session/prompt', { message: 'second' });
    firstChild.stdout.emit('data', encodeAcpJsonRpcMessage({ jsonrpc: '2.0', id: 2, result: 'old' }));
    secondChild.stdout.emit('data', encodeAcpJsonRpcMessage({ jsonrpc: '2.0', id: 2, result: 'new' }));

    await expect(secondRequest).resolves.toBe('new');
  });
});
