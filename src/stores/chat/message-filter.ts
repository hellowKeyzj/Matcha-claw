import {
  extractMessageText,
  type ChatMessageRecord,
  isRecord,
  normalizeMessageRole,
} from './message-content';
import {
  isImageGenerationStatusNarration,
  isInternalDeliveryPlanningText,
  isOpenClawRuntimeEventPrompt,
  sanitizeCanonicalUserText,
} from './message-display';

function readAssistantControlText(message: ChatMessageRecord): string {
  if (typeof message.text === 'string') {
    return message.text;
  }
  return extractMessageText(message.content);
}

function isExactAssistantControlText(text: string): boolean {
  return /^(HEARTBEAT_OK|NO_REPLY)$/i.test(text.trim());
}

export function isInternalAssistantControlMessage(value: unknown): boolean {
  const message = isRecord(value) ? value : {};
  if (normalizeMessageRole(message.role) !== 'assistant') {
    return false;
  }
  const text = readAssistantControlText(message).trim();
  return isExactAssistantControlText(text);
}

export function isAssistantControlPrefixMessage(value: unknown): boolean {
  const message = isRecord(value) ? value : {};
  if (normalizeMessageRole(message.role) !== 'assistant') {
    return false;
  }
  const text = readAssistantControlText(message).trimStart();
  if (!text) {
    return false;
  }
  if (isExactAssistantControlText(text)) {
    return true;
  }
  if (text !== text.toUpperCase()) {
    return false;
  }
  if (text.length < 2 || /[^A-Z_]/.test(text)) {
    return false;
  }
  const silentReply = 'NO_REPLY';
  const heartbeat = 'HEARTBEAT_OK';
  if (text.includes('_')) {
    return silentReply.startsWith(text) || heartbeat.startsWith(text);
  }
  return text === 'NO';
}

function messageHasToolUse(message: ChatMessageRecord): boolean {
  if ((Array.isArray(message.tool_calls) && message.tool_calls.length > 0)
    || (Array.isArray(message.toolCalls) && message.toolCalls.length > 0)) {
    return true;
  }
  const content = message.content;
  return Array.isArray(content) && content.some((block) => (
    isRecord(block)
    && (block.type === 'tool_use' || block.type === 'toolCall' || block.kind === 'toolUse')
  ));
}

function isRuntimeSystemInjectionText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (sanitizeCanonicalUserText(normalized).length === 0 && (
    /\[Bootstrap pending\]/i.test(normalized)
    || /^\s*System:\s*\[[^\]\r\n]+\]\s+[^\r\n]*\[msg:[^\]\r\n]+\]/i.test(normalized)
    || /^\s*Sender:\s*⟦openclaw:ctx⟧/i.test(normalized)
    || /(?:Conversation info|Sender|Forwarded message context)\s*\([^)]*\):/i.test(normalized)
  )) {
    return true;
  }
  if (/^\s*System\s*\(untrusted\)\s*:/i.test(normalized)) {
    return true;
  }
  if (/^\[Inter-session message\]/i.test(normalized)) {
    return true;
  }
  if (isOpenClawRuntimeEventPrompt(normalized)) {
    return true;
  }
  if (
    /An async command you ran earlier has completed/i.test(normalized)
    && /Do not relay it to the user unless explicitly requested/i.test(normalized)
  ) {
    return true;
  }
  return (
    /^\s*Current time\s*:/i.test(normalized)
    && /^\s*Current time\s*:[^\n]*\/\s*\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+UTC\s*$/i.test(normalized)
  );
}

export function isInternalRuntimeDisplayMessage(value: unknown): boolean {
  const message = isRecord(value) ? value : {};
  const role = normalizeMessageRole(message.role);
  if (role !== 'user' && role !== 'assistant') {
    return false;
  }
  const text = role === 'assistant'
    ? readAssistantControlText(message)
    : extractMessageText(message.content ?? message.text);
  if (role === 'assistant' && messageHasToolUse(message)) {
    return false;
  }
  if (role === 'assistant' && isExactAssistantControlText(text)) {
    return true;
  }
  if (role === 'assistant' && isImageGenerationStatusNarration(text)) {
    return true;
  }
  if (role === 'assistant' && isInternalDeliveryPlanningText(text)) {
    return true;
  }
  return isRuntimeSystemInjectionText(text);
}

export function isCanonicalSystemNoticeMessage(value: unknown): boolean {
  const message = isRecord(value) ? value : {};
  if (normalizeMessageRole(message.role) !== 'system') {
    return false;
  }
  return extractMessageText(message.content ?? message.text).trim().length > 0;
}

export function shouldPreserveCanonicalTranscriptMessage(value: unknown): boolean {
  const message = isRecord(value) ? value : {};
  const role = normalizeMessageRole(message.role);
  if (!role) {
    return false;
  }
  if (isCanonicalSystemNoticeMessage(message)) {
    return true;
  }
  if (role === 'toolresult' || role === 'tool_result') {
    return false;
  }
  return !isInternalRuntimeDisplayMessage(message);
}
