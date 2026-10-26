// Adapted from OpenClaw normalization-core and terminal-core pure helpers.
// Copyright (c) 2026 OpenClaw Foundation. SPDX-License-Identifier: MIT.
// See LICENSE and NOTICE in this directory.

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readNonBlankString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function sliceUtf16Safe(input: string, start: number, end?: number): string {
  const length = input.length;
  let from = start < 0 ? Math.max(length + start, 0) : Math.min(start, length);
  let to = end === undefined ? length : end < 0 ? Math.max(length + end, 0) : Math.min(end, length);
  if (to <= from) return '';
  if (from > 0 && from < length && isLowSurrogate(input.charCodeAt(from)) && isHighSurrogate(input.charCodeAt(from - 1))) {
    from += 1;
  }
  if (to > 0 && to < length && isHighSurrogate(input.charCodeAt(to - 1)) && isLowSurrogate(input.charCodeAt(to))) {
    to -= 1;
  }
  return input.slice(from, to);
}

// Only the non-compatibility stripAnsi path used by safe-text is needed here.
// eslint-disable-next-line no-control-regex -- terminal sanitizer intentionally recognizes control sequences.
const ANSI_OSC_AT_INDEX = new RegExp('(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c]*(?:\\x1b\\\\|\\x07|\\x9c)', 'y');

function scanAnsiCsiAt(input: string, index: number): { controls: string[]; length: number } | undefined {
  const code = input.charCodeAt(index);
  const introducerLength = code === 0x9b ? 1 : code === 0x1b && input.charCodeAt(index + 1) === 0x5b ? 2 : 0;
  if (!introducerLength) return undefined;
  let cursor = index + introducerLength;
  const controls: string[] = [];
  while (cursor < input.length) {
    const current = input.charCodeAt(cursor);
    if (current === 0x18 || current === 0x1a) {
      cursor += 1;
      break;
    }
    if (current === 0x1b || current === 0x9b) break;
    if (current <= 0x1f || current === 0x7f) {
      controls.push(input.charAt(cursor));
      cursor += 1;
      continue;
    }
    if (current >= 0x20 && current <= 0x3f) {
      cursor += 1;
      continue;
    }
    if (current >= 0x40 && current <= 0x7e) cursor += 1;
    break;
  }
  return { controls, length: cursor - index };
}

function stripAnsi(input: string): string {
  if (!input.includes('\u001b') && !input.includes('\u009b') && !input.includes('\u009d')) return input;
  const output: string[] = [];
  let copyStart = 0;
  let index = 0;
  while (index < input.length) {
    const code = input.charCodeAt(index);
    if (code !== 0x1b && code !== 0x9b && code !== 0x9d) {
      index += 1;
      continue;
    }
    ANSI_OSC_AT_INDEX.lastIndex = index;
    const osc = ANSI_OSC_AT_INDEX.exec(input)?.[0];
    if (osc) {
      output.push(input.slice(copyStart, index));
      index += osc.length;
      copyStart = index;
      continue;
    }
    const csi = scanAnsiCsiAt(input, index);
    if (!csi) {
      index += 1;
      continue;
    }
    output.push(input.slice(copyStart, index), ...csi.controls);
    index += csi.length;
    copyStart = index;
  }
  output.push(input.slice(copyStart));
  return output.join('');
}

export function sanitizeTerminalText(input: string): string {
  return stripAnsi(input).replace(/\p{Cc}/gu, (control) =>
    control === '\r' ? '\\r' : control === '\n' ? '\\n' : control === '\t' ? '\\t' : '',
  );
}
