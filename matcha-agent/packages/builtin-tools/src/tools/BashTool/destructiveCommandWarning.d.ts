/**
 * Detects potentially destructive bash commands and returns a warning string
 * for display in the permission dialog. This is purely informational — it
 * doesn't affect permission logic or auto-approval.
 */
/**
 * Checks if a bash command matches known destructive patterns.
 * Returns a human-readable warning string, or null if no destructive pattern is detected.
 */
export declare function getDestructiveCommandWarning(
  command: string,
): string | null
