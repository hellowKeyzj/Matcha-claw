import type { MessageContextTag } from './extensions';

export interface MessageContext {
  readonly tag: string;
  readonly name: string;
  readonly text: string;
  readonly prompt?: string;
}

const encoder = new TextEncoder();

type Context = Omit<MessageContext, 'tag'> & { readonly tag?: string };

function isContext(value: unknown): value is Omit<MessageContext, 'tag'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return Object.keys(entry).every((key) => ['name', 'text', 'prompt'].includes(key))
    && typeof entry.name === 'string' && !!entry.name.trim() && entry.name.length <= 120
    && typeof entry.text === 'string' && !!entry.text.trim() && encoder.encode(entry.text).byteLength <= 32 * 1024
    && (entry.prompt === undefined || typeof entry.prompt === 'string' && encoder.encode(entry.prompt).byteLength <= 32 * 1024);
}

export function buildTaggedMessage(text: string, contexts: readonly Context[], tags: readonly MessageContextTag[]): string {
  if (contexts.length > 16) throw new Error('Too many message contexts');
  const blocks: string[] = text ? [text] : [];
  const grouped = new Map<string, Omit<MessageContext, 'tag'>[]>();
  for (const { tag, name, text: contextText, prompt } of contexts) {
    const context = { name, text: contextText, ...(prompt !== undefined ? { prompt } : {}) };
    if (!isContext(context)) throw new Error('Invalid message context');
    if (!tag) {
      blocks.push([name, prompt, contextText].filter((part) => part !== undefined && part !== '').join('\n'));
      continue;
    }
    if (!tags.some((entry) => entry.tag === tag)) throw new Error('Message context plugin is unavailable');
    const entries = grouped.get(tag) ?? [];
    entries.push(context);
    grouped.set(tag, entries);
  }
  for (const [tag, entries] of grouped) {
    const payload = JSON.stringify(entries).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    blocks.push(`<${tag}>\n${payload}\n</${tag}>`);
  }
  const message = blocks.join('\n\n');
  if (encoder.encode(message).byteLength > 64 * 1024) throw new Error('Message exceeds 64 KiB');
  return message;
}

export function readTaggedMessage(text: string, tags: readonly MessageContextTag[], complete = true): { text: string; contexts: MessageContext[] } {
  if (!tags.length || !text.includes('<')) return { text, contexts: [] };
  const names = new Set(tags.map((entry) => entry.tag));
  const lines = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  const contexts: MessageContext[] = [];
  const visible: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  let hidden = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r?\n$/, '');
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = { marker: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      visible.push(lines[index]);
      continue;
    }
    const opening = !fence ? /^<([a-z][a-z0-9_-]{0,63})>$/.exec(line) : null;
    if (!opening || !names.has(opening[1])) {
      if (!complete && !fence && index >= lines.length - 2 && [...names].some((tag) => line.startsWith('<') && `<${tag}>`.startsWith(line))) {
        hidden = true;
        break;
      }
      visible.push(lines[index]);
      continue;
    }
    const tag = opening[1];
    const closing = lines.findIndex((candidate, position) => position > index && candidate.replace(/\r?\n$/, '') === `</${tag}>`);
    if (closing < 0) {
      if (!complete) { hidden = true; break; }
      visible.push(lines[index]);
      continue;
    }
    let entries: unknown;
    try { entries = JSON.parse(lines.slice(index + 1, closing).join('')); } catch { /* Literal XML is not a message context. */ }
    if (!Array.isArray(entries) || !entries.length || entries.length > 16 || !entries.every(isContext)) {
      visible.push(lines[index]);
      continue;
    }
    contexts.push(...entries.map((entry) => ({ ...entry, tag })));
    hidden = true;
    index = closing;
  }
  return { text: hidden ? visible.join('').trim() : text, contexts };
}
