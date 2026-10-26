/*
 * Adapted from OpenClaw ui/src/components/markdown-details.ts; disclosure styles
 * in src/styles/globals.css adapt ui/src/styles/chat/text.css.
 * MIT License
 * Copyright (c) 2026 OpenClaw Foundation
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type MarkdownIt from 'markdown-it';
import type StateBlock from 'markdown-it/lib/rules_block/state_block.mjs';

const MAX_DETAILS_DEPTH = 32;
const DISCLOSURE_TAG_RE = /<\/?(?:details|summary)(?=[\s>])[^>]*>/gi;
const DETAILS_OPEN_RE = /^<details( open)?>$/i;
const DETAILS_CLOSE_RE = /^<\/details>$/i;
const SUMMARY_OPEN_RE = /^<summary>$/i;
const SUMMARY_CLOSE_RE = /^<\/summary>$/i;
const DETAILS_STACK = Symbol('markdownDetailsStack');
const PARAGRAPH_CODE = Symbol('markdownDetailsParagraphCode');

type CodeSpan = readonly [number, number];
type DetailsFrame = { hasSummary: boolean };
type DetailsBlockState = StateBlock & {
  [DETAILS_STACK]?: DetailsFrame[];
  [PARAGRAPH_CODE]?: { startLine: number; spans: CodeSpan[] };
};
type DisclosureTag = { start: number; end: number; raw: string };

function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function findCodeSpans(text: string, parser: MarkdownIt): CodeSpan[] {
  if (!text.includes('`')) return [];
  // Use the same backtick rule as the inline renderer, including multi-backtick spans.
  const spans: CodeSpan[] = [];
  const inline = new parser.inline.State(text, parser, {}, []);
  let cursor = 0;
  while ((cursor = text.indexOf('`', cursor)) !== -1) {
    if (isEscaped(text, cursor)) {
      cursor += 1;
      continue;
    }
    inline.pos = cursor;
    parser.inline.skipToken(inline);
    spans.push([cursor, inline.pos]);
    cursor = inline.pos;
  }
  return spans;
}

function isParagraphCode(state: DetailsBlockState, line: number): boolean {
  const startLine = state.line;
  let cached = state[PARAGRAPH_CODE];
  if (cached?.startLine !== startLine) {
    let endLine = startLine + 1;
    while (endLine < state.lineMax && !state.isEmpty(endLine)) endLine += 1;
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const text = state.src.slice(start, state.eMarks[endLine - 1]);
    cached = {
      startLine,
      spans: findCodeSpans(text, state.md).map(([from, to]) => [start + from, start + to]),
    };
    state[PARAGRAPH_CODE] = cached;
  }
  const offset = state.bMarks[line] + state.tShift[line];
  return cached.spans.some(([from, to]) => offset >= from && offset < to);
}

function scanDisclosureLine(line: string, parser: MarkdownIt): DisclosureTag[] | null {
  if (!/^[ \t]*<\/?(?:details|summary)(?=[\s>])/i.test(line)) return null;
  const codeSpans = findCodeSpans(line, parser);
  const tags: DisclosureTag[] = [];
  for (const match of line.matchAll(DISCLOSURE_TAG_RE)) {
    const start = match.index;
    if (isEscaped(line, start) || codeSpans.some(([from, to]) => start >= from && start < to)) {
      continue;
    }
    tags.push({ start, end: start + match[0].length, raw: match[0] });
  }
  return tags.length > 0 ? tags : null;
}

function pushParagraph(state: StateBlock, content: string, line: number): void {
  if (!content.trim()) return;
  state.push('paragraph_open', 'p', 1).map = [line, line + 1];
  const inline = state.push('inline', '', 0);
  inline.content = content;
  inline.map = [line, line + 1];
  inline.children = [];
  state.push('paragraph_close', 'p', -1);
}

function pushSummary(state: StateBlock, label: string, line: number): void {
  state.push('summary_open', 'summary', 1).map = [line, line + 1];
  const inline = state.push('inline', '', 0);
  inline.content = label;
  inline.map = [line, line + 1];
  inline.children = [];
  state.push('summary_close', 'summary', -1);
}

function detailsBlockRule(
  state: DetailsBlockState,
  startLine: number,
  _endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const line = state.src.slice(start, state.eMarks[startLine]);
  if (!/^[ \t]*<\/?(?:details|summary)(?=[\s>])/i.test(line)) return false;
  if (silent && state.parentType === 'paragraph' && isParagraphCode(state, startLine)) return false;
  const tags = scanDisclosureLine(line, state.md);
  if (!tags) return false;
  if (silent) return true;

  const stack = state[DETAILS_STACK] ??= [];
  const nextSummaryClose = Array.from({ length: tags.length }, () => -1);
  let nearestSummaryClose = -1;
  for (let index = tags.length - 1; index >= 0; index -= 1) {
    nextSummaryClose[index] = nearestSummaryClose;
    if (SUMMARY_CLOSE_RE.test(tags[index].raw)) nearestSummaryClose = index;
  }
  let cursor = 0;
  let pendingText = '';
  const flushText = () => {
    pushParagraph(state, pendingText, startLine);
    pendingText = '';
  };
  for (let index = 0; index < tags.length; index += 1) {
    const tag = tags[index];
    pendingText += line.slice(cursor, tag.start);
    const opener = DETAILS_OPEN_RE.exec(tag.raw);
    if (opener && stack.length < MAX_DETAILS_DEPTH) {
      flushText();
      const token = state.push('details_open', 'details', 1);
      if (opener[1]) token.attrSet('open', '');
      stack.push({ hasSummary: false });
    } else if (DETAILS_CLOSE_RE.test(tag.raw) && stack.length > 0) {
      flushText();
      state.push('details_close', 'details', -1);
      stack.pop();
    } else if (SUMMARY_OPEN_RE.test(tag.raw)) {
      const frame = stack.at(-1);
      const close = tags[nextSummaryClose[index]];
      if (frame && !frame.hasSummary && close) {
        flushText();
        pushSummary(state, line.slice(tag.end, close.start), startLine);
        frame.hasSummary = true;
        cursor = close.end;
        index = nextSummaryClose[index];
        continue;
      }
      pendingText += tag.raw;
    } else {
      pendingText += tag.raw;
    }
    cursor = tag.end;
  }
  pendingText += line.slice(cursor);
  flushText();
  state.line = startLine + 1;
  return true;
}

export function installMarkdownDetails(parser: MarkdownIt): void {
  parser.block.ruler.before('html_block', 'details_block', detailsBlockRule, {
    alt: ['paragraph', 'reference', 'blockquote'],
  });
  // html:false leaves all other HTML literal; balance only the structural tokens we generate.
  const tokenize = parser.block.tokenize;
  parser.block.tokenize = (state: DetailsBlockState, startLine, endLine) => {
    const parentStack = state[DETAILS_STACK];
    const stack: DetailsFrame[] = [];
    state[DETAILS_STACK] = stack;
    tokenize.call(parser.block, state, startLine, endLine);
    // Each recursive tokenizer call owns one root/list-item/blockquote scope.
    while (stack.length > 0) {
      state.push('details_close', 'details', -1);
      stack.pop();
    }
    state[DETAILS_STACK] = parentStack;
  };
  parser.renderer.rules.details_open = (tokens, index) =>
    tokens[index].attrGet('open') === null ? '<details>' : '<details open>';
  parser.renderer.rules.details_close = () => '</details>\n';
  parser.renderer.rules.summary_open = () => '<summary>';
  parser.renderer.rules.summary_close = () => '</summary>';
}
