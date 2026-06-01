/**
 * Parser for sed edit commands (-i flag substitutions)
 * Extracts file paths and substitution patterns to enable file-edit-style rendering
 */
export type SedEditInfo = {
  /** The file path being edited */
  filePath: string
  /** The search pattern (regex) */
  pattern: string
  /** The replacement string */
  replacement: string
  /** Substitution flags (g, i, etc.) */
  flags: string
  /** Whether to use extended regex (-E or -r flag) */
  extendedRegex: boolean
}
/**
 * Check if a command is a sed in-place edit command
 * Returns true only for simple sed -i 's/pattern/replacement/flags' file commands
 */
export declare function isSedInPlaceEdit(command: string): boolean
/**
 * Parse a sed edit command and extract the edit information
 * Returns null if the command is not a valid sed in-place edit
 */
export declare function parseSedEditCommand(command: string): SedEditInfo | null
/**
 * Apply a sed substitution to file content
 * Returns the new content after applying the substitution
 */
export declare function applySedSubstitution(
  content: string,
  sedInfo: SedEditInfo,
): string
