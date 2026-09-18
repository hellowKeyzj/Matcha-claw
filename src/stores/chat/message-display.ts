import { extractMessageText, isRecord } from './message-content';

const assistantArtifactExtensions = 'html?|pdf|xlsx?|csv|md|mdx|png|jpe?g|gif|webp|svg|bmp|ts|tsx|js|jsx|json|txt|log';
const assistantMediaArtifactPattern = String.raw`(?<![A-Za-z0-9/\\])MEDIA:(?:(?:https?:\/\/|\/api\/chat\/media\/outgoing\/)[^\s\n"'()\[\],<>]+|(?:\/|~\/|[A-Za-z]:\\)[^\n"'()\[\],<>]*?\.(?:${assistantArtifactExtensions}))(?=$|[\s\n"'()\[\],<>]|[，。；;,.!?])`;
const assistantMediaArtifactLineRegex = new RegExp(`^\\s*${assistantMediaArtifactPattern}\\s*$`, 'i');
const assistantMediaArtifactRegex = new RegExp(assistantMediaArtifactPattern, 'gi');
const assistantOpenClawMediaArtifactRegex = new RegExp(String.raw`(^|[\s([{>])(?:(?:\/|~\/|[A-Za-z]:\\)[^\n"'()\[\],<>]*?\.openclaw[\\/]media[\\/][^\n"'()\[\],<>]*?\.(?:${assistantArtifactExtensions}))(?=$|[\s\n"'()\[\],<>]|[，。；;,.!?])`, 'gi');

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

function isOpenClawGatewayRestartRecoveryPrompt(text: string): boolean {
  return /^\s*\[System\]\s+Your previous turn was interrupted by a gateway restart while OpenClaw was waiting on tool\/model work\./i.test(text.trim());
}

function stripLeadingInternalPromptArtifacts(text: string): string {
  let output = text;
  while (true) {
    const next = (isOpenClawGatewayRestartRecoveryPrompt(output) ? '' : stripLeadingBootstrapPendingBlock(output))
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
        /^\s*Sender:\s*⟦openclaw:ctx⟧\s*(?:```[a-z]*\n[\s\S]*?```\s*|\{[\s\S]*?\}\s*)/i,
        '',
      )
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

function stripInboundMediaVisionEnvelope(text: string): string {
  const startsWithVisionEnvelope = /^\s*(?:\[Image\]\s*(?:\r?\n)?)?User text:/i.test(text);
  const hasDescriptionBlock = /\r?\n\s*Description:\s*\r?\n/i.test(text);
  if (!startsWithVisionEnvelope || !hasDescriptionBlock) {
    return text;
  }
  const withoutHeader = text.replace(/^\s*\[Image\]\s*(?:\r?\n)?/i, '');
  const userTextBlock = /^User text:\s*\r?\n([\s\S]*?)(?:\r?\n\s*Description:\s*\r?\n[\s\S]*)?\s*$/i.exec(withoutHeader);
  if (!userTextBlock) {
    return withoutHeader.replace(/\r?\n\s*Description:\s*\r?\n[\s\S]*$/i, '').trim();
  }
  const userText = userTextBlock[1].trim();
  return /^Process the attached file\(s\)\.\s*$/i.test(userText) ? '' : userText;
}

export function sanitizeCanonicalUserText(text: string): string {
  const cleaned = stripInboundMediaVisionEnvelope(stripLeadingDisplayEnvelopeArtifacts(text))
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

export function isImageGenerationStatusNarration(text: string): boolean {
  const value = text.trim();
  if (!value) {
    return false;
  }
  if (/^Background task started for image generation\s*\([0-9a-f-]{36}\)\.?/i.test(value)) {
    return true;
  }
  if (value.length > 120) {
    return false;
  }
  if (/^(?:图片(?:正在)?生成中|正在生成(?:图片|图像)|生成中)[，,。！!\s]*(?:请)?(?:稍候|稍等|等一下)?[，,。！!\s]*$/i.test(value)) {
    return true;
  }
  return /(?:稍等|稍候|please wait|one moment)/i.test(value) && /(?:图片|图像|image|generat)/i.test(value);
}

export function isOpenClawRuntimeEventPrompt(text: string): boolean {
  const value = text.trim();
  return value.split(/\n+/).some((line) => /^Continue the OpenClaw runtime event\.?$/i.test(line.trim()))
    || isOpenClawGatewayRestartRecoveryPrompt(value);
}

export function isInternalDeliveryPlanningText(text: string): boolean {
  const value = text.trim();
  if (!value) {
    return false;
  }
  return /message tool isn't suitable/i.test(value)
    || /visible-reply contract/i.test(value)
    || /final-reply MEDIA lines/i.test(value)
    || /writing the normal final reply with MEDIA directives/i.test(value)
    || /webchat isn't a valid channel for the message tool/i.test(value)
    || /fall back to writing the normal final reply/i.test(value);
}

function stripInternalDeliveryPlanning(text: string): string {
  const paragraphs = text.split(/\n{2,}/);
  const kept = paragraphs.filter((paragraph) => !isInternalDeliveryPlanningText(paragraph));
  if (kept.length === paragraphs.length) {
    return text;
  }
  return kept
    .join('\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function isInternalAssistantLine(line: string): boolean {
  const value = line.trim();
  return /^(?:HEARTBEAT_OK|NO_REPLY)$/i.test(value)
    || assistantMediaArtifactLineRegex.test(value)
    || isInternalDeliveryPlanningText(value)
    || /^\[Inter-session message\]/i.test(value)
    || isOpenClawRuntimeEventPrompt(value)
    || isImageGenerationStatusNarration(value);
}

function stripTrailingTeamControlBlock(text: string): string {
  return text.replace(/\s*<team_control\b[\s\S]*?<\/team_control>\s*$/i, '').trimEnd();
}

function stripInternalAssistantArtifactLines(text: string): string {
  if (!text) {
    return text;
  }
  return stripTrailingTeamControlBlock(stripInternalDeliveryPlanning(text))
    .split('\n')
    .filter((line) => !isInternalAssistantLine(line))
    .join('\n')
    .replace(/!\[[^\]\n]*\]\((?:\/api\/chat\/media\/outgoing\/|https?:\/\/[^)]+\/api\/chat\/media\/outgoing\/)[^)]+\)/gi, '')
    .replace(assistantMediaArtifactRegex, '')
    .replace(assistantOpenClawMediaArtifactRegex, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
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
