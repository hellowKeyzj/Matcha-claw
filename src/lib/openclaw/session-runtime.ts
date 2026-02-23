import type { GatewayRpcInvoker } from '@/lib/openclaw/types';

export interface ChatMessage {
  role?: unknown;
  content?: unknown;
}

export interface AssistantSnapshot {
  text: string;
  toolNames: string[];
}

interface ChatHistoryResult {
  messages?: ChatMessage[];
}

interface SessionsListResult {
  sessions?: unknown[];
}

export interface FetchChatHistoryInput {
  sessionKey: string;
  limit?: number;
}

export interface SendChatMessageInput {
  sessionKey: string;
  message: string;
  deliver?: boolean;
  idempotencyKey?: string;
}

export interface DeleteSessionInput {
  key: string;
  deleteTranscript?: boolean;
}

export interface ListSessionsInput {
  limit?: number;
  offset?: number;
}

const DEFAULT_CHAT_HISTORY_LIMIT = 20;

export function readChatMessageText(message?: ChatMessage): string {
  if (!message) {
    return '';
  }
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((block) => {
        if (!block || typeof block !== 'object') {
          return '';
        }
        const text = (block as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
  }
  return '';
}

function readToolNamesFromBlock(block: unknown): string[] {
  if (!block || typeof block !== 'object') {
    return [];
  }
  const row = block as Record<string, unknown>;
  const type = typeof row.type === 'string' ? row.type.toLowerCase() : '';
  if (type === 'tool_use') {
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    return name ? [name] : [];
  }
  const toolName = typeof row.tool_name === 'string' ? row.tool_name.trim() : '';
  if (toolName) {
    return [toolName];
  }
  if (Array.isArray(row.tool_calls)) {
    return row.tool_calls
      .flatMap((item) => {
        if (!item || typeof item !== 'object') {
          return [];
        }
        const fnName = (item as { function?: { name?: unknown } }).function?.name;
        return typeof fnName === 'string' && fnName.trim().length > 0 ? [fnName.trim()] : [];
      });
  }
  return [];
}

function readChatMessageToolNames(message?: ChatMessage): string[] {
  if (!message || !Array.isArray(message.content)) {
    return [];
  }
  return message.content.flatMap((block) => readToolNamesFromBlock(block));
}

export function findLatestAssistantText(messages?: ChatMessage[]): string {
  if (!Array.isArray(messages) || messages.length === 0) {
    return '';
  }

  let latestAssistant = '';
  for (const message of messages) {
    const role = typeof message?.role === 'string' ? message.role.toLowerCase() : '';
    if (role !== 'assistant') {
      continue;
    }
    const text = readChatMessageText(message).trim();
    if (text) {
      latestAssistant = text;
    }
  }
  if (latestAssistant) {
    return latestAssistant;
  }

  for (const message of messages) {
    const text = readChatMessageText(message).trim();
    if (text) {
      return text;
    }
  }
  return '';
}

export function findLatestAssistantSnapshot(messages?: ChatMessage[]): AssistantSnapshot {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { text: '', toolNames: [] };
  }

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    const role = typeof message?.role === 'string' ? message.role.toLowerCase() : '';
    if (role !== 'assistant') {
      continue;
    }
    const text = readChatMessageText(message).trim();
    const toolNames = readChatMessageToolNames(message);
    if (text || toolNames.length > 0) {
      return { text, toolNames };
    }
  }

  return { text: findLatestAssistantText(messages), toolNames: [] };
}

export async function fetchChatHistory(
  rpc: GatewayRpcInvoker,
  input: FetchChatHistoryInput,
): Promise<ChatMessage[]> {
  const history = await rpc<ChatHistoryResult>('chat.history', {
    sessionKey: input.sessionKey,
    limit: input.limit ?? DEFAULT_CHAT_HISTORY_LIMIT,
  });
  return Array.isArray(history.messages) ? history.messages : [];
}

export async function fetchLatestAssistantText(
  rpc: GatewayRpcInvoker,
  input: FetchChatHistoryInput,
): Promise<string> {
  const messages = await fetchChatHistory(rpc, input);
  return findLatestAssistantText(messages);
}

export async function fetchLatestAssistantSnapshot(
  rpc: GatewayRpcInvoker,
  input: FetchChatHistoryInput,
): Promise<AssistantSnapshot> {
  const messages = await fetchChatHistory(rpc, input);
  return findLatestAssistantSnapshot(messages);
}

export async function sendChatMessage<T = Record<string, unknown>>(
  rpc: GatewayRpcInvoker,
  input: SendChatMessageInput,
  rpcTimeoutMs?: number,
): Promise<T> {
  return rpc<T>('chat.send', {
    sessionKey: input.sessionKey,
    message: input.message,
    ...(input.deliver != null ? { deliver: input.deliver } : {}),
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  }, rpcTimeoutMs);
}

export async function deleteSession(
  rpc: GatewayRpcInvoker,
  input: DeleteSessionInput,
): Promise<void> {
  await rpc('sessions.delete', {
    key: input.key,
    deleteTranscript: input.deleteTranscript ?? true,
  });
}

export async function listSessions(
  rpc: GatewayRpcInvoker,
  input?: ListSessionsInput,
): Promise<unknown[]> {
  const result = await rpc<SessionsListResult>('sessions.list', {
    ...(input?.limit != null ? { limit: input.limit } : {}),
    ...(input?.offset != null ? { offset: input.offset } : {}),
  });
  return Array.isArray(result.sessions) ? result.sessions : [];
}
