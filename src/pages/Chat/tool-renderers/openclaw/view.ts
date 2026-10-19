// Adapted from OpenClaw. Copyright (c) 2026 OpenClaw Foundation.
// SPDX-License-Identifier: MIT; see LICENSE and NOTICE in this directory.

/**
 * View-model for tool-call rows.
 *
 * Classifies a tool call into a small set of presentation kinds (command,
 * read, edit, write, search, fetch, generic) across the arg spellings used by
 * the OpenClaw session tools and foreign harnesses (Claude/Codex style).
 */

import { asRecord, readNonBlankString } from "./text";
import { resolveExecTitle } from "./display";
import {
  buildWriteDiffLines,
  computeLineDiff,
  countTextLines,
  joinDiffSections,
  parseDiffDetailsString,
  parseStructuredDiff,
  type DiffLine,
  type DiffStat,
} from "./diff";
import { parsePatchView, type PatchFileOperation } from "./patch";

export type ToolCallKind = "command" | "read" | "edit" | "write" | "search" | "fetch" | "generic";

type ToolCallViewSource = {
  name: string;
  args?: unknown;
  details?: unknown;
  result?: unknown;
};

export type ToolCallView = {
  kind: ToolCallKind;
  /** Agent-supplied purpose for execution tools; does not describe their outcome. */
  title?: string;
  /** Full command text for `command` rows (first line shown collapsed). */
  command?: string;
  /** JavaScript source for code-mode execution, rendered without shell highlighting. */
  code?: string;
  /** File basename or primary target shown bold in the row. */
  target?: string;
  /** Dimmed secondary detail (directory, query scope, URL host…). */
  targetDetail?: string;
  /** Inline diff rows for edit/write calls. */
  diff?: DiffLine[];
  stat?: DiffStat;
  /** Producer-recorded operations for patch rows. */
  fileOperations?: PatchFileOperation[];
  /** Real file contents when no original side or authoritative diff is available. */
  content?: string;
  /** The file result is covered by diff/content; only its remaining fields need output. */
  resultHandled?: boolean;
  resultRemainder?: Record<string, unknown>;
};

const COMMAND_TOOL_NAMES = new Set(["bash", "exec", "shell", "run_command", "run_terminal_cmd"]);
const READ_TOOL_NAMES = new Set(["read", "read_file", "readfile", "notebookread", "notebook_read"]);
const EDIT_TOOL_NAMES = new Set([
  "edit",
  "edit_file",
  "multiedit",
  "multi_edit",
  "notebookedit",
  "notebook_edit",
]);
const TEXT_EDITOR_TOOL_NAMES = new Set(["str_replace_editor", "str_replace_based_edit_tool"]);
const WRITE_TOOL_NAMES = new Set(["write", "write_file", "create_file"]);
const SEARCH_TOOL_NAMES = new Set(["grep", "find", "glob", "ls", "list", "codebase_search"]);
const FETCH_TOOL_NAMES = new Set(["web_fetch", "webfetch", "fetch"]);
const PATCH_TOOL_NAMES = new Set(["apply_patch", "applypatch", "patch"]);

export function resolvePathArg(args: Record<string, unknown> | null): string | undefined {
  if (!args) {
    return undefined;
  }
  return (
    readNonBlankString(args.path) ??
    readNonBlankString(args.file_path) ??
    readNonBlankString(args.filePath) ??
    readNonBlankString(args.file) ??
    readNonBlankString(args.filepath) ??
    readNonBlankString(args.filename) ??
    readNonBlankString(args.notebook_path)
  );
}

function splitPathForDisplay(path: string): { base: string; dir?: string } {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) {
    return { base: normalized || path };
  }
  return { base: normalized.slice(slash + 1), dir: normalized.slice(0, slash) };
}

type EditPair = { oldText: string; newText: string };

type ResolvedEditDiff = { lines: DiffLine[]; stat?: DiffStat };

const MAX_LOCAL_DIFF_PAIRS = 8;
const MAX_LOCAL_DIFF_INPUT_CHARS = 120_000;

function readEditPairs(args: Record<string, unknown>): { pairs: EditPair[]; truncated: boolean } {
  const pairs: EditPair[] = [];
  let inputChars = 0;
  let truncated = false;
  const push = (oldText: unknown, newText: unknown) => {
    if (typeof oldText === "string" && typeof newText === "string") {
      const pairChars = oldText.length + newText.length;
      if (inputChars + pairChars > MAX_LOCAL_DIFF_INPUT_CHARS) {
        truncated = true;
        return;
      }
      inputChars += pairChars;
      pairs.push({ oldText, newText });
    }
  };
  if (Array.isArray(args.edits)) {
    for (let index = 0; index < args.edits.length; index++) {
      if (index >= MAX_LOCAL_DIFF_PAIRS) {
        truncated = true;
        break;
      }
      const entry = args.edits[index];
      const record = asRecord(entry);
      if (record) {
        push(
          record.oldText ?? record.old_string ?? record.oldString ?? record.old_str,
          record.newText ?? record.new_string ?? record.newString ?? record.new_str,
        );
        if (truncated) {
          break;
        }
      }
    }
  } else {
    push(
      args.oldText ?? args.old_string ?? args.oldString ?? args.old_str,
      args.newText ?? args.new_string ?? args.newString ?? args.new_str,
    );
  }
  return { pairs, truncated };
}

type FileDiff = { view: ToolCallView; field: string; nestedField?: string };

function readFileDiff(record: Record<string, unknown> | null, materializeDiff: boolean): FileDiff | null {
  if (!record) return null;
  const gitDiff = asRecord(record.gitDiff);
  const candidates = [
    { field: "diff", value: record.diff },
    { field: "patch", value: record.patch },
    { field: "gitDiff", value: record.gitDiff },
    { field: "gitDiff", nestedField: "patch", value: gitDiff?.patch },
    { field: "gitDiff", nestedField: "diff", value: gitDiff?.diff },
    { field: "structuredPatch", value: record.structuredPatch },
  ];
  for (const { field, nestedField, value } of candidates) {
    const text = readNonBlankString(value);
    if (!text) continue;
    const patch = resolvePatchView({ patch: text }, materializeDiff);
    if (patch) return { view: patch, field, nestedField };
    if (materializeDiff) {
      const parsed = parseDiffDetailsString(text);
      if (parsed) return { view: { kind: "edit", diff: parsed.lines, ...(parsed.kind === "complete" ? { stat: parsed.stat } : {}) }, field, nestedField };
    }
  }
  const patch = Array.isArray(record.changes) ? resolvePatchView({ changes: record.changes }, materializeDiff) : null;
  if (patch) return { view: patch, field: "changes" };
  if (!materializeDiff) return null;
  const parsed = parseStructuredDiff(record.structuredPatch);
  return parsed ? { view: { kind: "edit", diff: parsed.lines, ...(parsed.kind === "complete" ? { stat: parsed.stat } : {}) }, field: "structuredPatch" } : null;
}

function readFileContent(record: Record<string, unknown> | null): string | undefined {
  const content = record?.content;
  return typeof content === "string" ? content : typeof record?.newContent === "string" ? record.newContent : undefined;
}

function contentField(record: Record<string, unknown> | null): string {
  return typeof record?.content === "string" ? "content" : "newContent";
}

function withFileResult(
  view: ToolCallView,
  result: Record<string, unknown> | null,
  consumed: readonly string[] = [],
  nestedField?: string,
): ToolCallView {
  if (!result || consumed.length === 0) return view;
  const remainder: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (consumed.includes(key)) {
      if (key === "gitDiff" && nestedField) {
        const nested = asRecord(value);
        const metadata = Object.fromEntries(Object.entries(nested ?? {}).filter(([key]) => key !== nestedField));
        if (Object.keys(metadata).length) remainder[key] = metadata;
      }
      continue;
    }
    if ((key === "type" || key === "operation") && typeof value === "string" && /^(?:read|create|created|write|update|updated|edit)$/.test(value)) continue;
    if (["path", "file_path", "filePath", "file", "filepath", "filename", "notebook_path"].includes(key) && typeof value === "string" && (view.target !== undefined || view.fileOperations?.length)) continue;
    remainder[key] = value;
  }
  return { ...view, resultHandled: true, ...(Object.keys(remainder).length ? { resultRemainder: remainder } : {}) };
}

function coveredFileContent(lines: readonly DiffLine[] | undefined, result: Record<string, unknown> | null): string[] {
  if (!lines?.length || !result || lines.some((line) => line.kind === "skip" || line.kind === "file")) return [];
  const oldLines = lines.filter((line) => line.kind !== "add");
  const newLines = lines.filter((line) => line.kind !== "del");
  const covers = (rows: DiffLine[], text: unknown) => typeof text === "string" &&
    rows.every((line, index) => line.lineNo === undefined || line.lineNo === index + 1) &&
    text.replace(/\r\n?/g, "\n").replace(/\n$/, "") === rows.map((line) => line.text).join("\n");
  return [
    ...["content", "newContent"].filter((key) => covers(newLines, result[key])),
    ...["originalFile", "originalContent", "oldContent", "fileContent"].filter((key) => covers(oldLines, result[key])),
  ];
}

function resolveEditDiff(args: Record<string, unknown> | null): ResolvedEditDiff | null {
  if (!args) {
    return null;
  }
  const { pairs, truncated } = readEditPairs(args);
  if (pairs.length === 0) {
    return truncated ? { lines: [{ kind: "skip", text: "" }] } : null;
  }
  const sections = pairs.map((pair) => computeLineDiff(pair.oldText, pair.newText));
  const result = joinDiffSections(sections, { truncated });
  if (result.lines.length === 0) {
    return null;
  }
  return {
    lines: result.lines,
    ...(result.kind === "complete" ? { stat: result.stat } : {}),
  };
}

function resolveInsertionDiff(
  args: Record<string, unknown> | null,
): ResolvedEditDiff | null {
  const insertText = args ? readNonBlankString(args.insert_text) : undefined;
  if (!insertText) {
    return null;
  }
  const lines = computeLineDiff("", insertText).lines;
  // The text is known, but its surrounding file context is not. Omit an exact
  // stat rather than implying this preview represents the final placement.
  return lines.length > 0 ? { lines } : null;
}

function resolvePatchView(args: Record<string, unknown> | null, materializeDiff: boolean): ToolCallView | null {
  const patch = parsePatchView(args, materializeDiff);
  if (!patch) {
    return null;
  }
  if (patch.paths.length > 1) {
    return {
      kind: "edit",
      target: `${patch.paths.length} files`,
      fileOperations: patch.fileOperations,
      ...(materializeDiff ? { diff: patch.lines, stat: patch.stat } : {}),
    };
  }
  if (patch.move) {
    const from = splitPathForDisplay(patch.move.from);
    const to = splitPathForDisplay(patch.move.to);
    const commonDir = from.dir === to.dir ? from.dir : undefined;
    return {
      kind: "edit",
      target: commonDir ? `${from.base} → ${to.base}` : `${patch.move.from} → ${patch.move.to}`,
      targetDetail: commonDir,
      fileOperations: patch.fileOperations,
      ...(materializeDiff ? { diff: patch.lines, stat: patch.stat } : {}),
    };
  }
  const pathParts = patch.paths[0] ? splitPathForDisplay(patch.paths[0]) : null;
  return {
    kind: "edit",
    target: pathParts?.base,
    targetDetail: pathParts?.dir,
    fileOperations: patch.fileOperations,
    ...(materializeDiff ? { diff: patch.lines, stat: patch.stat } : {}),
  };
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase();
}

type TextEditorCommand = "view" | "str_replace" | "create" | "insert" | "undo_edit";

function resolveTextEditorCommand(args: unknown): TextEditorCommand | undefined {
  const command = readNonBlankString(asRecord(args)?.command)?.trim().toLowerCase();
  switch (command) {
    case "view":
    case "str_replace":
    case "create":
    case "insert":
    case "undo_edit":
      return command;
    default:
      return undefined;
  }
}

export function resolveToolCallKind(name: string, args?: unknown): ToolCallKind {
  const key = normalizeKey(name);
  if (TEXT_EDITOR_TOOL_NAMES.has(key)) {
    switch (resolveTextEditorCommand(args)) {
      case "view":
        return "read";
      case "str_replace":
      case "insert":
      case "undo_edit":
        return "edit";
      case "create":
        return "write";
      default:
        return "generic";
    }
  }
  if (COMMAND_TOOL_NAMES.has(key)) {
    return "command";
  }
  if (READ_TOOL_NAMES.has(key)) {
    return "read";
  }
  if (EDIT_TOOL_NAMES.has(key) || PATCH_TOOL_NAMES.has(key)) {
    return "edit";
  }
  if (WRITE_TOOL_NAMES.has(key)) {
    return "write";
  }
  if (SEARCH_TOOL_NAMES.has(key)) {
    return "search";
  }
  if (FETCH_TOOL_NAMES.has(key)) {
    return "fetch";
  }
  // Arg-shape fallback for harness-specific command tools.
  const record = asRecord(args);
  if (record && typeof record.command === "string" && Object.keys(record).length <= 3) {
    return "command";
  }
  return "generic";
}

export function resolveToolCallView(source: ToolCallViewSource, materializeDiff = true): ToolCallView {
  return buildToolCallView(source, asRecord(source.args), materializeDiff);
}

/**
 * Strip the `sh -lc '<command>'` wrapper harnesses add around agent commands
 * so rows show the command the model actually wrote. Display-only.
 */
function unwrapShellWrapperCommand(command: string): string {
  const match = command.match(
    /^\s*(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]+)\1\s*$/,
  );
  return match?.[2] ?? command;
}

function buildToolCallView(
  source: ToolCallViewSource,
  args: Record<string, unknown> | null,
  materializeDiff: boolean,
): ToolCallView {
  const kind = resolveToolCallKind(source.name, source.args);
  const key = normalizeKey(source.name);
  const editorCommand = TEXT_EDITOR_TOOL_NAMES.has(key)
    ? resolveTextEditorCommand(source.args)
    : undefined;

  if (kind === "command") {
    const command = args ? readNonBlankString(args.command) : undefined;
    return {
      kind,
      title: COMMAND_TOOL_NAMES.has(key) ? resolveExecTitle(args) : undefined,
      command: command ? unwrapShellWrapperCommand(command) : command,
      code: args ? readNonBlankString(args.code) : undefined,
    };
  }

  if (kind === "read") {
    const result = materializeDiff ? asRecord(source.result) : null;
    const path = resolvePathArg(args) ?? resolvePathArg(result);
    if (!path) return { kind: "generic" };
    const { base, dir } = splitPathForDisplay(path);
    const content = readFileContent(result);
    return withFileResult({ kind, target: base, targetDetail: dir, ...(content !== undefined ? { content } : {}) }, result, content !== undefined ? [contentField(result)] : []);
  }

  if (kind === "edit" || kind === "write") {
    const details = asRecord(source.details);
    // Collapsed rows may inspect producer metadata, never the result payload.
    const result = materializeDiff ? asRecord(source.result) : null;
    const path = resolvePathArg(args) ?? resolvePathArg(result);
    const parts = path ? splitPathForDisplay(path) : null;
    const base: ToolCallView = { kind, target: parts?.base, targetDetail: parts?.dir };
    if (details?.changed === false || result?.changed === false) return base;
    const detailsDiff = readFileDiff(details, materializeDiff);
    const resultDiff = detailsDiff ? null : readFileDiff(result, materializeDiff);
    const produced = detailsDiff ?? resultDiff;
    if (produced) {
      const diffView = produced.view;
      const fileOperations = diffView.fileOperations ?? (path ? [{ path, operation: details?.created === true || result?.created === true ? "add" as const : "update" as const }] : undefined);
      const view = { ...base, ...diffView, kind, target: diffView.target ?? base.target, targetDetail: diffView.targetDetail ?? base.targetDetail, ...(fileOperations ? { fileOperations } : {}) };
      return resultDiff ? withFileResult(view, result, [resultDiff.field, ...coveredFileContent(view.diff, result)], resultDiff.nestedField) : view;
    }
    if (PATCH_TOOL_NAMES.has(key)) {
      const patch = resolvePatchView(args, materializeDiff);
      return patch ?? { kind: "generic" };
    }
    if (!path) return { kind: "generic" };
    if (!materializeDiff) return base;
    const content = readFileContent(result);
    const original = result?.originalFile ?? result?.originalContent ?? result?.oldContent ?? result?.fileContent;
    if (content !== undefined && typeof original === "string") {
      const diff = computeLineDiff(original, content);
      return withFileResult({ ...base, diff: diff.lines, ...(diff.kind === "complete" ? { stat: diff.stat } : {}) }, result, coveredFileContent(diff.lines, result));
    }
    const created = details?.created === true || result?.created === true;
    if (content !== undefined && !created) return withFileResult({ ...base, content }, result, [contentField(result)]);
    if (kind === "edit" && !created) {
      const diff = editorCommand === "insert" ? resolveInsertionDiff(args)
        : editorCommand === "undo_edit" ? null : resolveEditDiff(args);
      return { ...base, ...(diff ? { diff: diff.lines, ...(diff.stat ? { stat: diff.stat } : {}) } : {}) };
    }
    const inputContent = editorCommand === "create" ? args?.file_text : args?.content;
    const writeContent = content ?? (typeof inputContent === "string" ? inputContent : undefined);
    if (writeContent === undefined) return base;
    if (!created) return { ...base, content: writeContent };
    const view = {
      ...base,
      diff: buildWriteDiffLines(writeContent),
      stat: { added: countTextLines(writeContent), removed: 0 },
      fileOperations: [{ path, operation: "add" as const }],
    };
    return content !== undefined ? withFileResult(view, result, coveredFileContent(view.diff, result)) : view;
  }

  if (kind === "search") {
    const pattern = args
      ? (readNonBlankString(args.pattern) ??
        readNonBlankString(args.query) ??
        readNonBlankString(args.glob))
      : undefined;
    const path = resolvePathArg(args);
    if (!pattern && !path) {
      return { kind: "generic" };
    }
    return { kind, target: pattern ?? path, targetDetail: pattern ? path : undefined };
  }

  if (kind === "fetch") {
    const url = args ? readNonBlankString(args.url) : undefined;
    if (!url) {
      return { kind: "generic" };
    }
    return { kind, target: url };
  }

  return { kind: "generic" };
}
