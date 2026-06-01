import { type StructuredPatchHunk } from 'diff'
import type { EditInput, FileEdit } from './types.js'
/**
 * Strips trailing whitespace from each line in a string while preserving line endings
 * @param str The string to process
 * @returns The string with trailing whitespace removed from each line
 */
export declare function stripTrailingWhitespace(str: string): string
/**
 * Finds the exact string in the file content.
 *
 * @param fileContent The file content to search in
 * @param searchString The string to search for
 * @returns The search string if found, or null if not found
 */
export declare function findActualString(
  fileContent: string,
  searchString: string,
): string | null
/**
 * Transform edits to ensure replace_all always has a boolean value
 * @param edits Array of edits with optional replace_all
 * @returns Array of edits with replace_all guaranteed to be boolean
 */
export declare function applyEditToFile(
  originalContent: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
): string
/**
 * Applies an edit to a file and returns the patch and updated file.
 * Does not write the file to disk.
 */
export declare function getPatchForEdit({
  filePath,
  fileContents,
  oldString,
  newString,
  replaceAll,
}: {
  filePath: string
  fileContents: string
  oldString: string
  newString: string
  replaceAll?: boolean
}): {
  patch: StructuredPatchHunk[]
  updatedFile: string
}
/**
 * Applies a list of edits to a file and returns the patch and updated file.
 * Does not write the file to disk.
 *
 * NOTE: The returned patch is to be used for display purposes only - it has spaces instead of tabs
 */
export declare function getPatchForEdits({
  filePath,
  fileContents,
  edits,
}: {
  filePath: string
  fileContents: string
  edits: FileEdit[]
}): {
  patch: StructuredPatchHunk[]
  updatedFile: string
}
/**
 * Used for attachments, to show snippets when files change.
 *
 * TODO: Unify this with the other snippet logic.
 */
export declare function getSnippetForTwoFileDiff(
  fileAContents: string,
  fileBContents: string,
): string
/**
 * Gets a snippet from a file showing the context around a patch with line numbers.
 * @param originalFile The original file content before applying the patch
 * @param patch The diff hunks to use for determining snippet location
 * @param newFile The file content after applying the patch
 * @returns The snippet text with line numbers and the starting line number
 */
export declare function getSnippetForPatch(
  patch: StructuredPatchHunk[],
  newFile: string,
): {
  formattedSnippet: string
  startLine: number
}
/**
 * Gets a snippet from a file showing the context around a single edit.
 * This is a convenience function that uses the original algorithm.
 * @param originalFile The original file content
 * @param oldString The text to replace
 * @param newString The text to replace it with
 * @param contextLines The number of lines to show before and after the change
 * @returns The snippet and the starting line number
 */
export declare function getSnippet(
  originalFile: string,
  oldString: string,
  newString: string,
  contextLines?: number,
): {
  snippet: string
  startLine: number
}
export declare function getEditsForPatch(
  patch: StructuredPatchHunk[],
): FileEdit[]
/**
 * Normalize the input for the FileEditTool
 * If the string to replace is not found in the file, try with a normalized version
 * Returns the normalized input if successful, or the original input if not
 */
export declare function normalizeFileEditInput({
  file_path,
  edits,
}: {
  file_path: string
  edits: EditInput[]
}): {
  file_path: string
  edits: EditInput[]
}
/**
 * Compare two sets of edits to determine if they are equivalent
 * by applying both sets to the original content and comparing results.
 * This handles cases where edits might be different but produce the same outcome.
 */
export declare function areFileEditsEquivalent(
  edits1: FileEdit[],
  edits2: FileEdit[],
  originalContent: string,
): boolean
/**
 * Unified function to check if two file edit inputs are equivalent.
 * Handles file edits (FileEditTool).
 */
export declare function areFileEditsInputsEquivalent(
  input1: {
    file_path: string
    edits: FileEdit[]
  },
  input2: {
    file_path: string
    edits: FileEdit[]
  },
): boolean
