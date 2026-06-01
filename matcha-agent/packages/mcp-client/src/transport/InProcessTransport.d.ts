import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
/**
 * Creates a pair of linked transports for in-process MCP communication.
 * Messages sent on one transport are delivered to the other's `onmessage`.
 *
 * @returns [clientTransport, serverTransport]
 */
export declare function createLinkedTransportPair(): [Transport, Transport]
