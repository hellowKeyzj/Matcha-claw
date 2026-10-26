import type MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import katex from 'katex';
import type { MarkdownExtension } from './extensions';
import { installMarkdownDetails } from './md-details';

interface MarkdownInlineState {
  src: string;
  pos: number;
  push(type: string, tag: string, nesting: -1 | 0 | 1): Token;
}

interface MarkdownBlockState {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  line: number;
  push(type: string, tag: string, nesting: -1 | 0 | 1): Token;
}

function isWhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a;
}

function countPrecedingBackslashes(src: string, index: number): number {
  let count = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (src.charCodeAt(cursor) !== 0x5c) {
      break;
    }
    count += 1;
  }
  return count;
}

function isEscaped(src: string, index: number): boolean {
  return countPrecedingBackslashes(src, index) % 2 === 1;
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderKatex(content: string, displayMode: boolean): string {
  try {
    return katex.renderToString(content, {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      output: 'html',
    });
  } catch {
    return escapeHtml(content);
  }
}

function mathInlineDollarRule(state: MarkdownInlineState, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;
  if (src.charCodeAt(start) !== 0x24 || src.charCodeAt(start + 1) === 0x24) {
    return false;
  }

  const nextChar = src.charCodeAt(start + 1);
  if (!nextChar || isWhitespaceCode(nextChar)) {
    return false;
  }

  let match = start + 1;
  while ((match = src.indexOf('$', match)) !== -1) {
    if (isEscaped(src, match)) {
      match += 1;
      continue;
    }
    const previousChar = src.charCodeAt(match - 1);
    if (!previousChar || isWhitespaceCode(previousChar)) {
      match += 1;
      continue;
    }
    const content = src.slice(start + 1, match);
    if (!content || content.includes('\n')) {
      return false;
    }
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = content;
      token.markup = '$';
    }
    state.pos = match + 1;
    return true;
  }

  return false;
}

function mathInlineParenRule(state: MarkdownInlineState, silent: boolean): boolean {
  const start = state.pos;
  const src = state.src;
  if (!src.startsWith('\\(', start)) {
    return false;
  }

  let match = start + 2;
  while ((match = src.indexOf('\\)', match)) !== -1) {
    if (isEscaped(src, match)) {
      match += 2;
      continue;
    }
    const content = src.slice(start + 2, match);
    if (!content || content.includes('\n')) {
      return false;
    }
    if (!silent) {
      const token = state.push('math_inline', 'math', 0);
      token.content = content;
      token.markup = '\\(';
    }
    state.pos = match + 2;
    return true;
  }

  return false;
}

function createMathBlockRule(open: string, close: string, markup: string) {
  return (state: MarkdownBlockState, startLine: number, endLine: number, silent: boolean): boolean => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    const firstLine = state.src.slice(start, max);
    if (!firstLine.startsWith(open)) {
      return false;
    }

    const afterOpen = firstLine.slice(open.length);
    const sameLineCloseIndex = afterOpen.indexOf(close);
    if (sameLineCloseIndex >= 0) {
      if (silent) {
        return true;
      }
      const token = state.push('math_block', 'math', 0);
      token.block = true;
      token.content = afterOpen.slice(0, sameLineCloseIndex).trim();
      token.map = [startLine, startLine + 1];
      token.markup = markup;
      state.line = startLine + 1;
      return true;
    }

    const contentLines: string[] = [afterOpen];
    let nextLine = startLine + 1;
    for (; nextLine < endLine; nextLine += 1) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineMax = state.eMarks[nextLine];
      const line = state.src.slice(lineStart, lineMax);
      const closeIndex = line.indexOf(close);
      if (closeIndex >= 0) {
        contentLines.push(line.slice(0, closeIndex));
        if (silent) {
          return true;
        }
        const token = state.push('math_block', 'math', 0);
        token.block = true;
        token.content = contentLines.join('\n').trim();
        token.map = [startLine, nextLine + 1];
        token.markup = markup;
        state.line = nextLine + 1;
        return true;
      }
      contentLines.push(line);
    }

    return false;
  };
}

function installMath(renderer: MarkdownIt): void {
  renderer.inline.ruler.after('backticks', 'math_inline_paren', mathInlineParenRule);
  renderer.inline.ruler.after('math_inline_paren', 'math_inline_dollar', mathInlineDollarRule);
  renderer.block.ruler.before('fence', 'math_block_bracket', createMathBlockRule('\\[', '\\]', '\\['), {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  renderer.block.ruler.before('fence', 'math_block_dollar', createMathBlockRule('$$', '$$', '$$'), {
    alt: ['paragraph', 'reference', 'blockquote', 'list'],
  });
  renderer.renderer.rules.math_inline = (tokens: Token[], idx: number) => renderKatex(tokens[idx]?.content ?? '', false);
  renderer.renderer.rules.math_block = (tokens: Token[], idx: number) => `${renderKatex(tokens[idx]?.content ?? '', true)}\n`;
}

function installCodeBlocks(renderer: MarkdownIt): void {
  renderer.renderer.rules.fence = (tokens: Token[], idx: number) => {
    const token = tokens[idx];
    const language = token.info.trim().split(/\s+/u)[0] || 'text';
    const escapedLanguage = escapeHtml(language);
    const escapedCodeClass = escapeHtml(`language-${language}`);
    const escapedCode = escapeHtml(token.content);

    return [
      '<figure class="chat-code-block" data-chat-code-block>',
      '<figcaption class="chat-code-header">',
      `<span class="chat-code-language">${escapedLanguage}</span>`,
      '<button type="button" class="chat-code-copy" data-chat-code-copy aria-label="Copy code">',
      '<span class="chat-code-copy-default">Copy</span>',
      '<span class="chat-code-copy-done" hidden>Copied</span>',
      '</button>',
      '</figcaption>',
      `<pre><code class="${escapedCodeClass}">${escapedCode}</code></pre>`,
      '</figure>\n',
    ].join('');
  };
}

export const BUILTIN_MARKDOWN_EXTENSIONS: readonly MarkdownExtension[] = Object.freeze([
  { id: 'details', install: installMarkdownDetails },
  { id: 'math', install: installMath },
  { id: 'code', install: installCodeBlocks },
]);
