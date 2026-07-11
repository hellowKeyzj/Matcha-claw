import { Buffer } from 'node:buffer'
import { describe, expect, test } from 'bun:test'
import {
  isAllowedWebSocketOrigin,
  readWebSocketProtocolToken,
} from '../wsServer.js'

function requestWithOrigin(origin?: string): Request {
  return new Request('http://127.0.0.1/ws', {
    headers: origin ? { origin } : undefined,
  })
}

describe('WsServer auth helpers', () => {
  test('accepts only base64url auth subprotocol tokens', () => {
    const encoded = Buffer.from('secret-token', 'utf8').toString('base64url')

    expect(readWebSocketProtocolToken(`rcs.auth.${encoded}`)).toBe(
      'secret-token',
    )
    expect(readWebSocketProtocolToken('token.secret-token')).toBeUndefined()
    expect(readWebSocketProtocolToken('bearer.secret-token')).toBeUndefined()
  })

  test('restricts browser origins to loopback when server binds loopback', () => {
    expect(isAllowedWebSocketOrigin(requestWithOrigin(), '127.0.0.1')).toBe(
      true,
    )
    expect(
      isAllowedWebSocketOrigin(
        requestWithOrigin('http://localhost:5173'),
        '127.0.0.1',
      ),
    ).toBe(true)
    expect(
      isAllowedWebSocketOrigin(
        requestWithOrigin('http://evil.example'),
        '127.0.0.1',
      ),
    ).toBe(false)
    expect(
      isAllowedWebSocketOrigin(
        requestWithOrigin('http://localhost:5173'),
        '0.0.0.0',
      ),
    ).toBe(false)
  })
})
