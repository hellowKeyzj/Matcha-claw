import { describe, expect, it } from 'vitest';
import { AcpFrameParser, encodeAcpJsonRpcMessage } from '../../runtime-host/application/agent-runtime/protocol-connectors/acp/acp-framing';

describe('ACP stdio framing', () => {
  it('parses chunked content-length JSON-RPC frames', () => {
    const frame = encodeAcpJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'session/update', params: { text: 'hello' } });
    const parser = new AcpFrameParser();

    expect(parser.push(frame.slice(0, 10))).toEqual([]);
    expect(parser.push(frame.slice(10))).toEqual([{ jsonrpc: '2.0', id: 1, method: 'session/update', params: { text: 'hello' } }]);
  });

  it('skips malformed frames and continues parsing later frames', () => {
    const parser = new AcpFrameParser();
    const valid = encodeAcpJsonRpcMessage({ jsonrpc: '2.0', id: 'ok', result: { done: true } });

    expect(parser.push('Content-Length: 4\r\n\r\nnope' + valid)).toEqual([{ jsonrpc: '2.0', id: 'ok', result: { done: true } }]);
  });
});
