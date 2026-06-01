/**
 * Shell-agnostic git operation tracking for usage metrics.
 *
 * Detects `git commit`, `git push`, `gh pr create`, `glab mr create`, and
 * curl-based PR creation in command strings, then increments OTLP counters
 * and fires analytics events. The regexes operate on raw command text so they
 * work identically for Bash and PowerShell (both invoke git/gh/glab/curl as
 * external binaries with the same argv syntax).
 */
export type CommitKind = 'committed' | 'amended' | 'cherry-picked'
export type BranchAction = 'merged' | 'rebased'
export type PrAction =
  | 'created'
  | 'edited'
  | 'merged'
  | 'commented'
  | 'closed'
  | 'ready'
export declare function parseGitCommitId(stdout: string): string | undefined
/**
 * Scan bash command + output for git operations worth surfacing in the
 * collapsed tool-use summary ("committed a1b2c3, created PR #42, ran 3 bash
 * commands"). Checks the command to avoid matching SHAs/URLs that merely
 * appear in unrelated output (e.g. `git log`).
 *
 * Pass stdout+stderr concatenated — git push writes the ref update to stderr.
 */
export declare function detectGitOperation(
  command: string,
  output: string,
): {
  commit?: {
    sha: string
    kind: CommitKind
  }
  push?: {
    branch: string
  }
  branch?: {
    ref: string
    action: BranchAction
  }
  pr?: {
    number: number
    url?: string
    action: PrAction
  }
}
export declare function trackGitOperations(
  command: string,
  exitCode: number,
  stdout?: string,
): void
