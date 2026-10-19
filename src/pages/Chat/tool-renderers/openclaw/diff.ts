// Adapted from OpenClaw. Copyright (c) 2026 OpenClaw Foundation.
// SPDX-License-Identifier: MIT; see LICENSE and NOTICE in this directory.

/**
 * Inline diff data for tool-call rendering.
 *
 * Sources, in preference order:
 * 1. The edit tool's precomputed display diff (`details.diff`, numbered lines).
 * 2. A locally computed line diff from `oldText`/`newText`-style args when a
 *    harness does not ship diff details.
 */

export type DiffLineKind = "add" | "del" | "ctx" | "file" | "skip";

export type DiffLineGap = {
  oldStart: number;
  newStart: number;
  count: number;
};

export type DiffFilePaths = { path: string; oldPath?: string };

export type DiffLine = {
  kind: DiffLineKind;
  /** Source filenames on file separators, for per-side language selection. */
  path?: string;
  oldPath?: string;
  /** 1-based line number in the file (new file for adds/ctx, old file for dels). */
  lineNo?: number;
  /** Session-diff coordinates for an expandable unchanged-lines marker. */
  gap?: DiffLineGap;
  text: string;
};

export type DiffStat = { added: number; removed: number };

export type LineDiffResult =
  | { kind: "complete"; lines: DiffLine[]; stat: DiffStat }
  | { kind: "truncated"; lines: DiffLine[] };

/** Bound diff rendering work; oversized inputs degrade to a truncation marker. */
const MAX_DIFF_INPUT_LINES = 600;
export const MAX_DIFF_RENDER_LINES = 400;

function diffStat(lines: readonly DiffLine[]): DiffStat {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") {
      added += 1;
    } else if (line.kind === "del") {
      removed += 1;
    }
  }
  return { added, removed };
}

/** Numbered display diffs and raw signed rows share the same bounded preview. */
function parseDiffRows(rows: Iterable<string>, numbered: boolean): LineDiffResult | null {
  const lines: DiffLine[] = [];
  const stat = { added: 0, removed: 0 };
  let truncated = false;
  let clipped = false;
  let oldLine: number | undefined;
  let newLine: number | undefined;
  for (const raw of rows) {
    if (!raw || raw === "\\ No newline at end of file") {
      continue;
    }
    if (/^\s*\.\.\.(?:\(truncated\)\.\.\.)?\s*$/.test(raw)) {
      truncated ||= raw.includes("(truncated)");
      if (lines.length < MAX_DIFF_RENDER_LINES) lines.push({ kind: "skip", text: "" });
      else clipped = true;
      continue;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      if (lines.length && lines.at(-1)?.kind !== "skip") {
        if (lines.length < MAX_DIFF_RENDER_LINES) lines.push({ kind: "skip", text: "" });
        else clipped = true;
      }
      continue;
    }
    if (raw === "@@") continue;
    if (/^(?:diff --git |--- |\+\+\+ )/.test(raw)) return null;
    const match = numbered ? raw.match(/^([+\- ])\s*(\d+) (.*)$/s) : raw.match(/^([+\- ])(.*)$/s);
    if (!match) return null;
    const kind = match[1] === "+" ? "add" : match[1] === "-" ? "del" : "ctx";
    const lineNo = numbered ? Number(match[2]) : kind === "del" ? oldLine : newLine;
    if (kind === "add") stat.added += 1;
    else if (kind === "del") stat.removed += 1;
    if (kind !== "add" && oldLine !== undefined) oldLine += 1;
    if (kind !== "del" && newLine !== undefined) newLine += 1;
    if (lines.length < MAX_DIFF_RENDER_LINES) {
      lines.push({ kind, ...(lineNo !== undefined ? { lineNo } : {}), text: match[numbered ? 3 : 2] ?? "" });
    } else {
      clipped = true;
    }
  }
  if (stat.added === 0 && stat.removed === 0) return null;
  if ((clipped || truncated) && lines.at(-1)?.kind !== "skip") lines.push({ kind: "skip", text: "" });
  return truncated ? { kind: "truncated", lines } : { kind: "complete", lines, stat };
}

export function parseDiffDetailsString(diff: string): LineDiffResult | null {
  const rows = diff.replace(/\r\n?/g, "\n").split("\n");
  const numbered = rows.every((raw) => !raw || /^\s*\.\.\./.test(raw) || raw === "\\ No newline at end of file" || /^([+\- ])\s*\d+ .*$/s.test(raw));
  return parseDiffRows(rows, numbered);
}

/** jsdiff/SDK structuredPatch hunks already contain real old/new coordinates. */
export function parseStructuredDiff(value: unknown): LineDiffResult | null {
  const hunks = Array.isArray(value) ? value : null;
  if (!hunks) return null;
  function* rows(): Iterable<string> {
    for (const hunk of hunks!) {
      if (typeof hunk === "string") {
        yield* hunk.replace(/\r\n?/g, "\n").split("\n");
        continue;
      }
      if (!hunk || typeof hunk !== "object" || Array.isArray(hunk)) continue;
      const record = hunk as Record<string, unknown>;
      if (!Array.isArray(record.lines)) {
        const text = record.text ?? record.line ?? record.content;
        if (typeof text === "string") yield* text.replace(/\r\n?/g, "\n").split("\n");
        continue;
      }
      if (typeof record.oldStart === "number" && typeof record.newStart === "number") {
        yield `@@ -${record.oldStart} +${record.newStart} @@`;
      } else {
        yield "@@";
      }
      for (const line of record.lines) {
        if (typeof line === "string") yield line;
      }
    }
  }
  return parseDiffRows(rows(), false);
}

function splitDiffLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Empty snippets are zero lines: deletions (`newText: ""`) and insertions
  // from an empty old side must not produce a phantom blank row in the diff.
  if (normalized === "") {
    return [];
  }
  const lines = normalized.split("\n");
  // A trailing newline yields one empty trailing element; drop it so
  // "foo\n" diffs as one line, not two.
  if (lines.length > 1 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function compactLineDiff(
  lines: DiffLine[],
  inputTruncated: boolean,
  compactUnchanged: boolean,
): DiffLine[] {
  if (!compactUnchanged && lines.length <= MAX_DIFF_RENDER_LINES && !inputTruncated) {
    return lines;
  }
  const hasChange = lines.some((line) => line.kind === "add" || line.kind === "del");
  if (!hasChange) {
    if (compactUnchanged && !inputTruncated) {
      return [];
    }
    return inputTruncated
      ? [{ kind: "skip", text: "" }]
      : [...lines.slice(0, MAX_DIFF_RENDER_LINES), { kind: "skip", text: "" }];
  }
  const keep = new Uint8Array(lines.length);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line || (line.kind !== "add" && line.kind !== "del")) {
      continue;
    }
    const start = Math.max(0, index - 3);
    const end = Math.min(lines.length, index + 4);
    keep.fill(1, start, end);
  }
  const preview: DiffLine[] = [];
  let gap = false;
  let clipped = inputTruncated;
  for (let index = 0; index < lines.length; index++) {
    if (keep[index] === 0) {
      gap = true;
      clipped = true;
      continue;
    }
    if (gap && preview.at(-1)?.kind !== "skip") {
      preview.push({ kind: "skip", text: "" });
    }
    gap = false;
    if (preview.length >= MAX_DIFF_RENDER_LINES) {
      clipped = true;
      break;
    }
    const line = lines[index];
    if (line) {
      preview.push(line);
    }
  }
  if (clipped && preview.at(-1)?.kind !== "skip") {
    preview.push({ kind: "skip", text: "" });
  }
  return preview;
}

/**
 * Compute a line diff between two snippets (no file line numbers available).
 * Standard LCS table; inputs are bounded so the quadratic cost stays small.
 *
 * `compactUnchanged` collapses unchanged runs to three lines of context.
 */
export function computeLineDiff(
  oldText: string,
  newText: string,
  options?: { compactUnchanged?: boolean },
): LineDiffResult {
  const allOldLines = splitDiffLines(oldText);
  const allNewLines = splitDiffLines(newText);
  const inputTruncated =
    allOldLines.length > MAX_DIFF_INPUT_LINES || allNewLines.length > MAX_DIFF_INPUT_LINES;
  const inputsEqual =
    allOldLines.length === allNewLines.length &&
    allOldLines.every((line, index) => line === allNewLines[index]);
  const comparisonTruncated = inputTruncated && !inputsEqual;
  const oldLines = allOldLines.slice(0, MAX_DIFF_INPUT_LINES);
  const newLines = allNewLines.slice(0, MAX_DIFF_INPUT_LINES);
  const n = oldLines.length;
  const m = newLines.length;
  // lcs[i][j] = LCS length of oldLines[i..] vs newLines[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    Array.from({ length: m + 1 }, () => 0),
  );
  for (let i = n - 1; i >= 0; i--) {
    const row = lcs[i];
    const nextRow = lcs[i + 1];
    if (!row || !nextRow) {
      continue;
    }
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        oldLines[i] === newLines[j]
          ? (nextRow[j + 1] ?? 0) + 1
          : Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];
    if (oldLine === undefined || newLine === undefined) {
      break;
    }
    if (oldLine === newLine) {
      lines.push({ kind: "ctx", text: oldLine });
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      lines.push({ kind: "del", text: oldLine });
      i++;
    } else {
      lines.push({ kind: "add", text: newLine });
      j++;
    }
  }
  while (i < n) {
    const line = oldLines[i];
    if (line !== undefined) {
      lines.push({ kind: "del", text: line });
    }
    i++;
  }
  while (j < m) {
    const line = newLines[j];
    if (line !== undefined) {
      lines.push({ kind: "add", text: line });
    }
    j++;
  }
  const preview = compactLineDiff(lines, comparisonTruncated, options?.compactUnchanged === true);
  return comparisonTruncated
    ? { kind: "truncated", lines: preview }
    : { kind: "complete", lines: preview, stat: diffStat(lines) };
}

/** All-added preview for freshly written files, numbered from line 1. */
export function buildWriteDiffLines(content: string, maxLines = 80): DiffLine[] {
  const sourceLines = splitDiffLines(content);
  const lines: DiffLine[] = [];
  for (const [index, text] of sourceLines.slice(0, maxLines).entries()) {
    lines.push({ kind: "add", lineNo: index + 1, text });
  }
  if (sourceLines.length > maxLines) {
    lines.push({ kind: "skip", text: "" });
  }
  return lines;
}

export function countTextLines(content: string): number {
  return splitDiffLines(content).length;
}

/**
 * Concatenate per-edit diffs with skip separators, e.g. for multi-edit calls
 * where each `edits[i]` produced its own local diff.
 */
export function joinDiffSections(
  sections: ReadonlyArray<LineDiffResult>,
  options?: { truncated?: boolean; maxLines?: number },
): LineDiffResult {
  const maxLines = options?.maxLines ?? MAX_DIFF_RENDER_LINES;
  const joined: DiffLine[] = [];
  const comparisonTruncated =
    options?.truncated === true || sections.some((section) => section.kind === "truncated");
  let previewTruncated = comparisonTruncated;
  for (const section of sections) {
    if (section.lines.length === 0) {
      continue;
    }
    if (joined.length > 0) {
      if (joined.length >= maxLines) {
        previewTruncated = true;
        break;
      }
      joined.push({ kind: "skip", text: "" });
    }
    const remaining = maxLines - joined.length;
    if (section.lines.length > remaining) {
      joined.push(...section.lines.slice(0, remaining));
      previewTruncated = true;
      break;
    }
    joined.push(...section.lines);
  }
  if (previewTruncated && joined.at(-1)?.kind !== "skip") {
    joined.push({ kind: "skip", text: "" });
  }
  if (comparisonTruncated) {
    return { kind: "truncated", lines: joined };
  }
  const stat = sections.reduce(
    (sum, section) => ({
      added: sum.added + (section.kind === "complete" ? section.stat.added : 0),
      removed: sum.removed + (section.kind === "complete" ? section.stat.removed : 0),
    }),
    { added: 0, removed: 0 },
  );
  return { kind: "complete", lines: joined, stat };
}
