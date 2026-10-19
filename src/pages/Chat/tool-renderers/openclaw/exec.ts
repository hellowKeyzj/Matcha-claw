// Adapted from OpenClaw tool-display-exec-shell and chat-tool-cards.
// Copyright (c) 2026 OpenClaw Foundation. SPDX-License-Identifier: MIT.
// See LICENSE and NOTICE in this directory.

import { redactToolPayloadText } from './redact';
import { sanitizeTerminalText, sliceUtf16Safe } from './text';

function stripOuterQuotes(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

type ShellWords = {
  words: string[];
  hereInput?: 'heredoc' | 'here-string';
  unsupported: boolean;
};

/** Separates command arguments from unquoted shell redirects before quote removal. */
function parseShellWords(input: string | undefined, maxWords = 48): ShellWords {
  const source = input ?? '';
  const result: ShellWords = { words: [], unsupported: false };
  let current = '';
  let quote: '"' | "'" | 'ansi-c' | undefined;
  let previousUnquotedDollar = false;
  let started = false;
  let protectedWord = false;
  let redirectOperand = false;
  const flush = () => {
    if (started) {
      if (!redirectOperand) {
        result.words.push(current);
      }
      redirectOperand = false;
    }
    current = '';
    started = false;
    protectedWord = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source.charAt(index);
    const next = source.charAt(index + 1);
    const wasUnquotedDollar: boolean = previousUnquotedDollar;
    previousUnquotedDollar = false;
    if (quote === "'") {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '\\' && (!quote || quote === 'ansi-c' || /[$`"\\\n]/u.test(next))) {
      if (!next) {
        result.unsupported = true;
        break;
      }
      index += 1;
      if (next !== '\n') {
        current += next;
        started = protectedWord = true;
      } else {
        previousUnquotedDollar = wasUnquotedDollar;
      }
      continue;
    }
    if (quote) {
      if (char === (quote === 'ansi-c' ? "'" : quote)) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char === "'" && wasUnquotedDollar ? 'ansi-c' : char;
      started = protectedWord = true;
      continue;
    }
    if (/\s/u.test(char)) {
      flush();
      if (result.words.length >= maxWords) {
        return result;
      }
      continue;
    }
    if (char === '#' && !started) {
      break;
    }
    if (char === '<' || char === '>' || (char === '&' && next === '>')) {
      if (next === '(') {
        result.unsupported = true;
      }
      // Only unquoted adjacent digits or {name} belong to the redirect's fd prefix.
      if (!protectedWord && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/u.test(current)) {
        current = '';
        started = false;
      }
      flush();
      let operator = char;
      if (char === '&') {
        operator += next;
        index += 1;
        if (source.charAt(index + 1) === '>') {
          operator += '>';
          index += 1;
        }
      } else if (
        next === char ||
        next === '&' ||
        (char === '<' && next === '>') ||
        (char === '>' && next === '|')
      ) {
        operator += next;
        index += 1;
        if (
          operator === '<<' &&
          (source.charAt(index + 1) === '-' || source.charAt(index + 1) === '<')
        ) {
          operator += source.charAt(++index);
        }
      }
      if (operator.startsWith('<<')) {
        result.hereInput = operator === '<<<' ? 'here-string' : 'heredoc';
      }
      redirectOperand = true;
      continue;
    }
    current += char;
    started = true;
    previousUnquotedDollar = char === '$';
  }
  flush();
  result.unsupported ||= quote !== undefined || redirectOperand;
  return result;
}

function binaryName(token: string | undefined): string | undefined {
  if (!token) {
    return undefined;
  }
  const cleaned = stripOuterQuotes(token) ?? token;
  const segment = cleaned.split(/[/]/).at(-1) ?? cleaned;
  return segment.trim().toLowerCase();
}

type HeredocMarker = {
  value: string;
  stripLeadingTabs: boolean;
  operatorIndex: number;
};

function parseHeredocMarker(command: string, operatorIndex: number): HeredocMarker | undefined {
  if (
    command[operatorIndex] !== '<' ||
    command[operatorIndex - 1] === '<' ||
    command[operatorIndex + 1] !== '<' ||
    command[operatorIndex + 2] === '<'
  ) {
    return undefined;
  }

  const stripLeadingTabs = command[operatorIndex + 2] === '-';
  let index = operatorIndex + (stripLeadingTabs ? 3 : 2);
  while (/[ \t]/u.test(command[index] ?? '')) {
    index += 1;
  }

  let value = '';
  let quote: '"' | "'" | undefined;
  for (; index < command.length; index += 1) {
    const char = command[index] ?? '';
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && char === '\\' && index + 1 < command.length) {
        index += 1;
        value += command[index] ?? '';
        continue;
      }
      value += char;
      continue;
    }

    if (/[\r\n;&|<>]/u.test(char) || /[ \t]/u.test(char)) {
      break;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '\\' && index + 1 < command.length) {
      index += 1;
      value += command[index] ?? '';
      continue;
    }
    value += char;
  }

  return value ? { value, stripLeadingTabs, operatorIndex } : undefined;
}

function findHeredocBodyEnd(
  command: string,
  marker: HeredocMarker,
  bodyStart: number,
): number | undefined {
  let lineStart = bodyStart;
  while (lineStart <= command.length) {
    const lineEnd = command.indexOf('\n', lineStart);
    const end = lineEnd === -1 ? command.length : lineEnd;
    const rawLine = command.slice(lineStart, end).replace(/\r$/u, '');
    const candidate = marker.stripLeadingTabs ? rawLine.replace(/^\t+/u, '') : rawLine;
    if (candidate === marker.value) {
      return end;
    }
    if (lineEnd === -1) {
      return undefined;
    }
    lineStart = lineEnd + 1;
  }

  return undefined;
}

function findArithmeticSecondParen(command: string, firstParenIndex: number): number | undefined {
  let index = firstParenIndex + 1;
  // Bash removes unquoted backslash-newline pairs before recognizing the `((` token.
  while (command[index] === '\\' && command[index + 1] === '\n') {
    index += 2;
  }
  return command[index] === '(' ? index : undefined;
}

function scanTopLevelChars(
  command: string,
  visit: (char: string, index: number) => boolean | void,
  visitHeredocBody?: (operatorIndex: number, start: number, end: number) => void,
): void {
  let quote: '"' | "'" | 'ansi-c' | undefined;
  let escaped = false;
  let atWordStart = true;
  let arithmeticDepth = 0;
  let plainSubshellDepth = 0;
  let pendingHeredocs: HeredocMarker[] = [];
  let previousUnquotedDollar = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command.charAt(i);
    const previousWasUnquotedDollar: boolean = previousUnquotedDollar;
    previousUnquotedDollar = false;

    if (escaped) {
      escaped = false;
      if (char === '\n') {
        // A line continuation disappears before tokenization; keep both code units absent.
        previousUnquotedDollar = previousWasUnquotedDollar;
        if (visit('', i - 1) === false || visit('', i) === false) {
          return;
        }
      } else {
        atWordStart = false;
      }
      continue;
    }

    if (quote === "'") {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '\\') {
      // Defer adjacency until the escaped character reveals whether this is a continuation.
      previousUnquotedDollar = previousWasUnquotedDollar;
      escaped = true;
      continue;
    }

    if (quote) {
      const terminator = quote === 'ansi-c' ? "'" : quote;
      if (char === terminator) {
        quote = undefined;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char === "'" && previousWasUnquotedDollar ? 'ansi-c' : char;
      atWordStart = false;
      continue;
    }

    if (char === '#' && atWordStart && arithmeticDepth === 0) {
      const newline = command.indexOf('\n', i + 1);
      if (newline === -1) {
        return;
      }
      i = newline - 1;
      continue;
    }

    const arithmeticSecondParenIndex =
      arithmeticDepth === 0 && char === '(' && (previousWasUnquotedDollar || atWordStart)
        ? findArithmeticSecondParen(command, i)
        : undefined;
    const startsArithmetic = arithmeticSecondParenIndex !== undefined;
    const inArithmetic = arithmeticDepth > 0 || startsArithmetic;

    if (!inArithmetic) {
      const heredoc = parseHeredocMarker(command, i);
      if (heredoc) {
        pendingHeredocs.push(heredoc);
      }
    }

    if (char === '\n' && pendingHeredocs.length > 0) {
      let bodyStart = i + 1;
      let bodyEnd: number | undefined;
      const bodies: Array<{ marker: HeredocMarker; start: number; end: number }> = [];
      for (const marker of pendingHeredocs) {
        bodyEnd = findHeredocBodyEnd(command, marker, bodyStart);
        if (bodyEnd === undefined) {
          break;
        }
        bodies.push({ marker, start: bodyStart, end: bodyEnd });
        bodyStart = bodyEnd + 1;
      }
      pendingHeredocs = [];
      if (bodyEnd !== undefined) {
        for (const body of bodies) {
          visitHeredocBody?.(body.marker.operatorIndex, body.start, body.end);
        }
        i = bodyEnd - 1;
        continue;
      }
    }

    if (arithmeticSecondParenIndex !== undefined) {
      // Expose only the `((` opener; separators inside the arithmetic body stay protected.
      if (
        visit(char, i) === false ||
        visit(command.charAt(arithmeticSecondParenIndex), arithmeticSecondParenIndex) === false
      ) {
        return;
      }
    } else if (!inArithmetic && visit(char, i) === false) {
      return;
    }

    if (char === '(' && (arithmeticDepth > 0 || startsArithmetic)) {
      arithmeticDepth += 1;
      continue;
    }
    if (char === ')' && arithmeticDepth > 0) {
      arithmeticDepth -= 1;
      continue;
    }
    if (inArithmetic) {
      continue;
    }

    if (/\s/u.test(char)) {
      atWordStart = true;
    } else if (char === '(') {
      const previous = command[i - 1];
      const isWordExpansion = previous === '$' || previous === '<' || previous === '>';
      if (isWordExpansion) {
        // The expansion is part of the surrounding word, but its body starts a fresh command.
        atWordStart = true;
      } else if (atWordStart) {
        plainSubshellDepth += 1;
        atWordStart = true;
      }
    } else if (char === ')') {
      if (plainSubshellDepth > 0) {
        plainSubshellDepth -= 1;
        atWordStart = true;
      } else {
        // Command and process substitutions remain part of the word that opened them.
        atWordStart = false;
      }
    } else if (/[;&|<>]/u.test(char)) {
      atWordStart = true;
    } else {
      atWordStart = false;
    }
    previousUnquotedDollar = char === '$';
  }
}

function parseChdirTarget(head: string): string | undefined {
  const { words } = parseShellWords(head, 3);
  const bin = binaryName(words[0]);
  if (bin === 'cd' || bin === 'pushd') {
    return words[1] || undefined;
  }
  return undefined;
}

function isChdirCommand(head: string): boolean {
  const bin = binaryName(parseShellWords(head, 2).words[0]);
  return bin === 'cd' || bin === 'pushd' || bin === 'popd';
}

function isPopdCommand(head: string): boolean {
  return binaryName(parseShellWords(head, 2).words[0]) === 'popd';
}

/** Removes leading setup commands such as exports and cwd changes from display summaries. */
function stripShellPreamble(command: string): { command: string; chdirPath?: string } {
  let rest = command.trim();
  let chdirPath: string | undefined;

  for (let i = 0; i < 4; i += 1) {
    let first: { index: number; length: number; isOr?: boolean } | undefined;
    // Only scan top-level separators so quoted strings and nested shell fragments stay intact in
    // the command fragment that display code will summarize.
    scanTopLevelChars(rest, (char, idx) => {
      if (char === '&' && rest[idx + 1] === '&') {
        first = { index: idx, length: 2 };
        return false;
      }
      if (char === '|' && rest[idx + 1] === '|') {
        first = { index: idx, length: 2, isOr: true };
        return false;
      }
      if (char === ';' || char === '\n') {
        first = { index: idx, length: 1 };
        return false;
      }
      return undefined;
    });
    const head = (first ? rest.slice(0, first.index) : rest).trim();
    const isChdir = (first ? !first.isOr : i > 0) && isChdirCommand(head);
    const isPreamble =
      head.startsWith('set ') || head.startsWith('export ') || head.startsWith('unset ') || isChdir;

    if (!isPreamble) {
      break;
    }

    if (isChdir) {
      if (isPopdCommand(head)) {
        chdirPath = undefined;
      } else {
        chdirPath = parseChdirTarget(head) ?? chdirPath;
      }
    }

    rest = first ? rest.slice(first.index + first.length).trimStart() : '';
    if (!rest) {
      break;
    }
  }

  return { command: rest.trim(), chdirPath };
}

export function resolveExecCommandPreview(command: string): string {
  const firstLine = (stripShellPreamble(command).command || command).split('\n')[0]?.trim() ?? '';
  return sliceUtf16Safe(redactToolPayloadText(sanitizeTerminalText(firstLine)), 0, 120);
}
