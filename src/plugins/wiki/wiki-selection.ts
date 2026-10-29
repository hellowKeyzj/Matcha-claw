import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import type { WikiSelectionSnapshot } from '@/types/wiki-selection';

export function normalizeSelectionReplacement(content: string): string {
  const fenced = content.trim().match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1] : content;
}

export function normalizeEditableMarkdown(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

export interface WordDiffPart {
  type: 'equal' | 'insert' | 'delete';
  value: string;
}

export function buildWordDiff(original: string, replacement: string): WordDiffPart[] {
  const tokenize = (value: string) => value.match(/\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
  const left = tokenize(original);
  const right = tokenize(replacement);
  if (left.length * right.length > 250_000) {
    return [
      ...(original ? [{ type: 'delete' as const, value: original }] : []),
      ...(replacement ? [{ type: 'insert' as const, value: replacement }] : []),
    ];
  }
  const rows = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      rows[i][j] = left[i] === right[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
    }
  }
  const parts: WordDiffPart[] = [];
  const push = (type: WordDiffPart['type'], value: string) => {
    const previous = parts[parts.length - 1];
    if (previous?.type === type) previous.value += value;
    else parts.push({ type, value });
  };
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      push('equal', left[i]); i += 1; j += 1;
    } else if (j < right.length && (i === left.length || rows[i][j + 1] >= rows[i + 1][j])) {
      push('insert', right[j]); j += 1;
    } else {
      push('delete', left[i]); i += 1;
    }
  }
  return parts;
}

function snapshot(markdown: string, start: number, end: number): WikiSelectionSnapshot {
  return { prefix: markdown.slice(0, start), selectedText: markdown.slice(start, end), suffix: markdown.slice(end), sourceMapped: true };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findUniqueTextSelection(markdown: string, renderedSelection: string): WikiSelectionSnapshot | null {
  const selected = renderedSelection.trim();
  if (!selected) return null;
  const start = markdown.indexOf(selected);
  // Check overlapping occurrences as well (e.g. selecting "aa" in "aaa").
  if (start >= 0 && markdown.indexOf(selected, start + 1) < 0) return snapshot(markdown, start, start + selected.length);
  const words = selected.split(/\s+/u).filter(Boolean);
  if (words.length < 2) return null;
  const pattern = words.map(escapeRegExp).join('\\s+');
  const matches = [...markdown.matchAll(new RegExp(`(?=(${pattern}))`, 'gu'))];
  if (matches.length !== 1 || matches[0].index === undefined) return null;
  return snapshot(markdown, matches[0].index, matches[0].index + matches[0][1].length);
}

const NON_SOURCE_SELECTOR = 'button,figcaption,.katex,[data-selection-ignore]';

export function isMarkdownBodySelection(selection: Selection, root: HTMLElement): boolean {
  if (selection.rangeCount !== 1 || selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return false;
  return !Array.from(root.querySelectorAll(NON_SOURCE_SELECTOR)).some((element) => range.intersectsNode(element));
}

function textPoint(container: Node, offset: number, end: boolean): [Text, number] | null {
  if (container.nodeType === Node.TEXT_NODE) return [container as Text, offset];
  const child = container.childNodes[end ? offset - 1 : offset];
  if (!child) return null;
  if (child.nodeType === Node.TEXT_NODE) return [child as Text, end ? (child.nodeValue?.length ?? 0) : 0];
  const walker = container.ownerDocument!.createTreeWalker(child, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode() as Text | null;
  if (end) for (let next = walker.nextNode(); next; next = walker.nextNode()) text = next as Text;
  return text ? [text, end ? text.length : 0] : null;
}

function originalOffset(source: string, normalizedOffset: number): number {
  let original = 0;
  for (let normalized = 0; normalized < normalizedOffset; normalized += 1) {
    original += source[original] === '\r' && source[original + 1] === '\n' ? 2 : 1;
  }
  return original;
}

function sourceOffset(markdown: string, container: Node, offset: number, root: HTMLElement, end: boolean): number | null {
  const point = textPoint(container, offset, end);
  if (!point) return null;
  const [text, textOffset] = point;
  const parent = text.parentElement?.closest<HTMLElement>('[data-source-start][data-source-end]');
  if (!parent || !root.contains(parent) || parent.childNodes.length !== 1 || parent.firstChild !== text) return null;
  const start = Number(parent.dataset.sourceStart);
  const finish = Number(parent.dataset.sourceEnd);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(finish) || start < 0 || finish > markdown.length
    || start >= finish || textOffset < 0 || textOffset > text.length || normalizeEditableMarkdown(markdown.slice(start, finish)) !== text.data) return null;
  return start + originalOffset(markdown.slice(start, finish), textOffset);
}

export function findDomTextSelection(markdown: string, selection: Selection, root: HTMLElement): WikiSelectionSnapshot | null {
  if (!isMarkdownBodySelection(selection, root)) return null;
  const range = selection.getRangeAt(0);
  const start = sourceOffset(markdown, range.startContainer, range.startOffset, root, false);
  const end = sourceOffset(markdown, range.endContainer, range.endOffset, root, true);
  return start !== null && end !== null && start < end ? snapshot(markdown, start, end) : null;
}

// Only lex the original source. Chat remains the sole HTML renderer/security owner.
const sourceLexer = new MarkdownIt({ html: false, breaks: true, linkify: false });
const BLOCK_SELECTOR = 'p,h1,h2,h3,h4,h5,h6,blockquote,ul,ol,li,table,thead,tbody,tr,th,td,hr,pre';

export function annotateMarkdownSource(root: HTMLElement, markdown: string): void {
  // Lexer line numbers are normalized; keep their offsets in the original source.
  const starts = [0];
  for (const newline of markdown.matchAll(/\r\n?|\n/g)) starts.push(newline.index + newline[0].length);
  const blocks: { tag: string; token?: Token }[] = [];
  const stack: (number | null)[] = [];
  for (const token of sourceLexer.parse(markdown, {})) {
    if (token.nesting === 1) {
      const index = token.hidden ? null : blocks.push({ tag: token.tag }) - 1;
      stack.push(index);
    } else if (token.nesting === -1) {
      stack.pop();
    } else if (token.type === 'inline') {
      const index = [...stack].reverse().find((value) => value !== null);
      if (index !== undefined && index !== null) blocks[index].token = token;
    } else if (token.type === 'fence' || token.type === 'code_block') {
      blocks.push({ tag: 'pre', token });
    } else if (token.tag === 'hr') blocks.push({ tag: 'hr' });
  }
  const elements = Array.from(root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR));
  // ponytail: renderer-only extensions (e.g. display math) invalidate this structural
  // proof; keep ask/unique fallback rather than duplicating Chat's renderer plugins.
  if (elements.length !== blocks.length || elements.some((element, index) => element.tagName.toLowerCase() !== blocks[index].tag)) return;
  blocks.forEach(({ token }, index) => {
    if (!token?.map) return;
    const element = elements[index];
    const from = starts[token.map[0]];
    const to = starts[token.map[1]] ?? markdown.length;
    const source = markdown.slice(from, to);
    const raw = normalizeEditableMarkdown(source);
    const content = token.content;
    // Escapes/entities/math can display characters absent from their raw source.
    if (token.type === 'inline' && /\\|&(?:#\d+|#x[\da-f]+|[a-z]+);|\$/iu.test(content)) return;
    const bodyStart = raw.indexOf(content);
    if (!content || bodyStart < 0 || raw.indexOf(content, bodyStart + 1) >= 0) return;
    const projected = token.type === 'inline'
      ? (token.children ?? []).map((child) => child.type === 'text' || child.type === 'code_inline' ? child.content : child.type === 'softbreak' || child.type === 'hardbreak' ? '\n' : '').join('')
      : content;
    const target = token.type === 'inline' ? element : element.querySelector('code');
    if (!target) return;
    const walker = root.ownerDocument.createTreeWalker(target, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
    // Chat emits a newline text node after each <br>; compare the actual text stream.
    if (nodes.map((node) => node.data).join('') !== projected) return;
    let cursor = 0;
    for (const node of nodes) {
      const value = node.data;
      if (!value) continue;
      const position = content.indexOf(value);
      if (position < cursor || content.indexOf(value, position + 1) >= 0) continue;
      cursor = position + value.length;
      const span = root.ownerDocument.createElement('span');
      span.dataset.sourceStart = String(from + originalOffset(source, bodyStart + position));
      span.dataset.sourceEnd = String(from + originalOffset(source, bodyStart + position + value.length));
      node.replaceWith(span);
      span.append(node);
    }
    // Keep code headers/buttons outside the source-bearing spans.
  });
}
