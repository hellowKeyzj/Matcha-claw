import { extractMessageText, isRecord } from './message-content';

function stripLeadingUntrustedMetadataBlocks(text: string): string {
  const fencedPattern = /^\s*(?:[^\n:]{1,80}\s*\(\s*untrusted metadata\s*\):\s*)?```[a-z]*\n[\s\S]*?```\s*/i;
  const inlineJsonPattern = /^\s*(?:[^\n:]{1,80}\s*\(\s*untrusted metadata\s*\):\s*)?\{[\s\S]*?\}\s*/i;

  let output = text;
  while (true) {
    const next = output
      .replace(fencedPattern, '')
      .replace(inlineJsonPattern, '');
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function stripLeadingBootstrapPendingBlock(text: string): string {
  const header = /^\s*\[Bootstrap pending\]\s*(?:\r?\n|$)/i.exec(text);
  if (!header) {
    return text;
  }

  const directivePatterns = [
    /^Please read BOOTSTRAP\.md\b/i,
    /^If this run can complete\b/i,
    /^If it cannot\b/i,
    /^are still possible here\b/i,
    /^Do not pretend bootstrap is complete\b/i,
    /^Do not use a generic first greeting\b/i,
    /^handled BOOTSTRAP\.md\./i,
    /^Your first user-visible reply\b/i,
    /^BOOTSTRAP\.md, not a generic greeting\./i,
  ];

  let offset = header[0].length;
  const linePattern = /.*(?:\r?\n|$)/g;
  linePattern.lastIndex = offset;
  while (linePattern.lastIndex < text.length) {
    const match = linePattern.exec(text);
    if (!match || !match[0]) {
      break;
    }
    const line = match[0];
    const trimmed = line.replace(/\r?\n$/, '').trim();
    if (!trimmed || directivePatterns.some((pattern) => pattern.test(trimmed))) {
      offset = linePattern.lastIndex;
      continue;
    }
    break;
  }
  return text.slice(offset);
}

function stripLeadingInternalPromptArtifacts(text: string): string {
  let output = text;
  while (true) {
    const next = stripLeadingBootstrapPendingBlock(output)
      .replace(/^\s*<relevant-memories>\s*[\s\S]*?<\/relevant-memories>\s*/i, '')
      .replace(/^\s*\[UNTRUSTED DATA[^\n]*\][\s\S]*?\[END UNTRUSTED DATA\]\s*/i, '');
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function stripLeadingConversationEnvelopeArtifacts(text: string): string {
  let output = text;
  while (true) {
    const next = output
      .replace(/^\s*System:\s*\[[^\]\r\n]+\]\s+[^\r\n]*\[msg:[^\]\r\n]+\]\s*(?:\r?\n|$)/i, '')
      .replace(
        /^\s*(?:Conversation info|Sender|Forwarded message context)\s*\([^)]*\):\s*(?:```[a-z]*\n[\s\S]*?```\s*|\{[\s\S]*?\}\s*)/i,
        '',
      )
      .replace(/^\s*(?:Conversation info|Sender|Forwarded message context)\s*\([^)]*\):\s*/i, '')
      .replace(/^\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+[^\]]+\]\s*/i, '');
    if (next === output) {
      break;
    }
    output = next;
  }
  return output;
}

function stripLeadingDisplayEnvelopeArtifacts(text: string): string {
  return stripLeadingConversationEnvelopeArtifacts(stripLeadingInternalPromptArtifacts(text));
}

export function sanitizeCanonicalUserText(text: string): string {
  const cleaned = stripLeadingDisplayEnvelopeArtifacts(text)
    .replace(/\s*\[media attached:[^\]]*\]/gi, '');
  return stripLeadingUntrustedMetadataBlocks(cleaned).trim();
}

export function sanitizeCanonicalUserContent(content: unknown): unknown {
  if (typeof content === 'string') {
    return sanitizeCanonicalUserText(content);
  }
  if (!Array.isArray(content)) {
    return content;
  }

  let changed = false;
  const nextContent = content.map((block) => {
    if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
      return block;
    }
    const nextText = sanitizeCanonicalUserText(block.text);
    if (nextText === block.text) {
      return block;
    }
    changed = true;
    return {
      ...block,
      text: nextText,
    };
  });

  return changed ? nextContent : content;
}

export function stripAssistantReplyDirectivePrefix(text: string): string {
  return text
    .replace(/^\s*(?:\[\[reply_to(?:[:_][a-z0-9:_-]+)?\]\]\s*)+/ig, '')
    .trim();
}

function stripInternalAssistantArtifactLines(text: string): string {
  if (!text) {
    return text;
  }
  return text
    .replace(/(^|\n)[ \t]*(?:HEARTBEAT_OK|NO_REPLY)[ \t]*(?=\n|$)/gi, '$1')
    .replace(/(^|\n)[ \t]*MEDIA:(?:\/|~\/|[A-Za-z]:\\)[^\n]+(?=\n|$)/gi, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export function sanitizeAssistantDisplayText(content: unknown): string {
  const text = typeof content === 'string' ? content : extractMessageText(content);
  return stripInternalAssistantArtifactLines(
    stripLeadingDisplayEnvelopeArtifacts(stripAssistantReplyDirectivePrefix(text))
      .replace(/\s*\[media attached:[^\]]*\]/gi, '')
      .replace(/\r\n?/g, '\n'),
  );
}

export function normalizeAssistantFinalText(content: unknown): string {
  return sanitizeAssistantDisplayText(content)
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}
