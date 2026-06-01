import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
/**
 * Detects well-formed $(cat <<'DELIM'...DELIM) heredoc substitution patterns.
 * Returns the command with matched heredocs stripped, or null if none found.
 * Used by the pre-split gate to strip safe heredocs and re-check the remainder.
 */
export declare function stripSafeHeredocSubstitutions(
  command: string,
): string | null
/** Detection-only check: does the command contain a safe heredoc substitution? */
export declare function hasSafeHeredocSubstitution(command: string): boolean
/**
 * @deprecated Legacy regex/shell-quote path. Only used when tree-sitter is
 * unavailable. The primary gate is parseForSecurity (ast.ts).
 */
export declare function bashCommandIsSafe_DEPRECATED(
  command: string,
): PermissionResult
/**
 * @deprecated Legacy regex/shell-quote path. Only used when tree-sitter is
 * unavailable. The primary gate is parseForSecurity (ast.ts).
 *
 * Async version of bashCommandIsSafe that uses tree-sitter when available
 * for more accurate parsing. Falls back to the sync regex version when
 * tree-sitter is not available.
 *
 * This should be used by async callers (bashPermissions.ts, bashCommandHelpers.ts).
 * Sync callers (readOnlyValidation.ts) should continue using bashCommandIsSafe().
 */
export declare function bashCommandIsSafeAsync_DEPRECATED(
  command: string,
  onDivergence?: () => void,
): Promise<PermissionResult>
