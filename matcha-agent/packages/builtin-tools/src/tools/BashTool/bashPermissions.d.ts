import type { z } from 'zod/v4'
import type { ToolPermissionContext, ToolUseContext } from 'src/Tool.js'
import type { PendingClassifierCheck } from 'src/types/permissions.js'
import { type SimpleCommand } from 'src/utils/bash/ast.js'
import { type CommandPrefixResult } from 'src/utils/bash/commands.js'
import type { ClassifierResult } from 'src/utils/permissions/bashClassifier.js'
import type {
  PermissionDecisionReason,
  PermissionResult,
} from 'src/utils/permissions/PermissionResult.js'
import {
  type ShellPermissionRule,
  permissionRuleExtractPrefix as sharedPermissionRuleExtractPrefix,
} from 'src/utils/permissions/shellRuleMatching.js'
import { BashTool } from './BashTool.js'
export declare const MAX_SUBCOMMANDS_FOR_SECURITY_CHECK = 50
export declare const MAX_SUGGESTED_RULES_FOR_COMPOUND = 5
/**
 * Extract a stable command prefix (command + subcommand) from a raw command string.
 * Skips leading env var assignments only if they are in SAFE_ENV_VARS (or
 * ANT_ONLY_SAFE_ENV_VARS for ant users). Returns null if a non-safe env var is
 * encountered (to fall back to exact match), or if the second token doesn't look
 * like a subcommand (lowercase alphanumeric, e.g., "commit", "run").
 *
 * Examples:
 *   'git commit -m "fix typo"' → 'git commit'
 *   'NODE_ENV=prod npm run build' → 'npm run' (NODE_ENV is safe)
 *   'MY_VAR=val npm run build' → null (MY_VAR is not safe)
 *   'ls -la' → null (flag, not a subcommand)
 *   'cat file.txt' → null (filename, not a subcommand)
 *   'chmod 755 file' → null (number, not a subcommand)
 */
export declare function getSimpleCommandPrefix(command: string): string | null
/**
 * UI-only fallback: extract the first word alone when getSimpleCommandPrefix
 * declines. In external builds TREE_SITTER_BASH is off, so the async
 * tree-sitter refinement in BashPermissionRequest never fires — without this,
 * pipes and compounds (`python3 file.py 2>&1 | tail -20`) dump into the
 * editable field verbatim.
 *
 * Deliberately not used by suggestionForExactCommand: a backend-suggested
 * `Bash(rm:*)` is too broad to auto-generate, but as an editable starting
 * point it's what users expect (Slack C07VBSHV7EV/p1772670433193449).
 *
 * Reuses the same SAFE_ENV_VARS gate as getSimpleCommandPrefix — a rule like
 * `Bash(python3:*)` can never match `RUN=/path python3 ...` at check time
 * because stripSafeWrappers won't strip RUN.
 */
export declare function getFirstWordPrefix(command: string): string | null
/**
 * Extract prefix from legacy :* syntax (e.g., "npm:*" -> "npm")
 * Delegates to shared implementation.
 */
export declare const permissionRuleExtractPrefix: typeof sharedPermissionRuleExtractPrefix
/**
 * Match a command against a wildcard pattern (case-sensitive for Bash).
 * Delegates to shared implementation.
 */
export declare function matchWildcardPattern(
  pattern: string,
  command: string,
): boolean
/**
 * Parse a permission rule into a structured rule object.
 * Delegates to shared implementation.
 */
export declare const bashPermissionRule: (
  permissionRule: string,
) => ShellPermissionRule
export declare function stripSafeWrappers(command: string): string
/**
 * Argv-level counterpart to stripSafeWrappers. Strips the same wrapper
 * commands (timeout, time, nice, nohup) from AST-derived argv. Env vars
 * are already separated into SimpleCommand.envVars so no env-var stripping.
 *
 * KEEP IN SYNC with SAFE_WRAPPER_PATTERNS above — if you add a wrapper
 * there, add it here too.
 */
export declare function stripWrappersFromArgv(argv: string[]): string[]
/**
 * Env vars that make a *different binary* run (injection or resolution hijack).
 * Heuristic only — export-&& form bypasses this, and excludedCommands isn't a
 * security boundary anyway.
 */
export declare const BINARY_HIJACK_VARS: RegExp
/**
 * Strip ALL leading env var prefixes from a command, regardless of whether the
 * var name is in the safe-list.
 *
 * Used for deny/ask rule matching: when a user denies `claude` or `rm`, the
 * command should stay blocked even if prefixed with arbitrary env vars like
 * `FOO=bar claude`. The safe-list restriction in stripSafeWrappers is correct
 * for allow rules (prevents `DOCKER_HOST=evil docker ps` from auto-matching
 * `Bash(docker ps:*)`), but deny rules must be harder to circumvent.
 *
 * Also used for sandbox.excludedCommands matching (not a security boundary —
 * permission prompts are), with BINARY_HIJACK_VARS as a blocklist.
 *
 * SECURITY: Uses a broader value pattern than stripSafeWrappers. The value
 * pattern excludes only actual shell injection characters ($, backtick, ;, |,
 * &, parens, redirects, quotes, backslash) and whitespace. Characters like
 * =, +, @, ~, , are harmless in unquoted env var assignment position and must
 * be matched to prevent trivial bypass via e.g. `FOO=a=b denied_command`.
 *
 * @param blocklist - optional regex tested against each var name; matching vars
 *   are NOT stripped (and stripping stops there). Omit for deny rules; pass
 *   BINARY_HIJACK_VARS for excludedCommands.
 */
export declare function stripAllLeadingEnvVars(
  command: string,
  blocklist?: RegExp,
): string
/**
 * Checks if the subcommand is an exact match for a permission rule
 */
export declare const bashToolCheckExactMatchPermission: (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
) => PermissionResult
export declare const bashToolCheckPermission: (
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  compoundCommandHasCd?: boolean,
  astCommand?: SimpleCommand,
) => PermissionResult
/**
 * Processes an individual subcommand and applies prefix checks & suggestions
 */
export declare function checkCommandAndSuggestRules(
  input: z.infer<typeof BashTool.inputSchema>,
  toolPermissionContext: ToolPermissionContext,
  commandPrefixResult: CommandPrefixResult | null | undefined,
  compoundCommandHasCd?: boolean,
  astParseSucceeded?: boolean,
): Promise<PermissionResult>
/**
 * Start a speculative bash allow classifier check early, so it runs in
 * parallel with pre-tool hooks, deny/ask classifiers, and permission dialog setup.
 * The result can be consumed later by executeAsyncClassifierCheck via
 * consumeSpeculativeClassifierCheck.
 */
export declare function peekSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined
export declare function startSpeculativeClassifierCheck(
  command: string,
  toolPermissionContext: ToolPermissionContext,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): boolean
/**
 * Consume a speculative classifier check result for the given command.
 * Returns the promise if one exists (and removes it from the map), or undefined.
 */
export declare function consumeSpeculativeClassifierCheck(
  command: string,
): Promise<ClassifierResult> | undefined
export declare function clearSpeculativeChecks(): void
/**
 * Await a pending classifier check and return a PermissionDecisionReason if
 * high-confidence allow, or undefined otherwise.
 *
 * Used by swarm agents (both tmux and in-process) to gate permission
 * forwarding: run the classifier first, and only escalate to the leader
 * if the classifier doesn't auto-approve.
 */
export declare function awaitClassifierAutoApproval(
  pendingCheck: PendingClassifierCheck,
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
): Promise<PermissionDecisionReason | undefined>
type AsyncClassifierCheckCallbacks = {
  shouldContinue: () => boolean
  onAllow: (decisionReason: PermissionDecisionReason) => void
  onComplete?: () => void
}
/**
 * Execute the bash allow classifier check asynchronously.
 * This runs in the background while the permission prompt is shown.
 * If the classifier allows with high confidence and the user hasn't interacted, auto-approves.
 *
 * @param pendingCheck - Classifier check metadata from bashToolHasPermission
 * @param signal - Abort signal
 * @param isNonInteractiveSession - Whether this is a non-interactive session
 * @param callbacks - Callbacks to check if we should continue and handle approval
 */
export declare function executeAsyncClassifierCheck(
  pendingCheck: {
    command: string
    cwd: string
    descriptions: string[]
  },
  signal: AbortSignal,
  isNonInteractiveSession: boolean,
  callbacks: AsyncClassifierCheckCallbacks,
): Promise<void>
/**
 * The main implementation to check if we need to ask for user permission to call BashTool with a given input
 */
export declare function bashToolHasPermission(
  input: z.infer<typeof BashTool.inputSchema>,
  context: ToolUseContext,
  getCommandSubcommandPrefixFn?: {
    (
      command: string,
      abortSignal: AbortSignal,
      isNonInteractiveSession: boolean,
    ): Promise<
      import('src/utils/shell/prefix.js').CommandSubcommandPrefixResult | null
    >
    cache: {
      clear: () => void
      size: () => number
      delete: (key: string) => boolean
      get: (
        key: string,
      ) =>
        | Promise<
            | import('src/utils/shell/prefix.js').CommandSubcommandPrefixResult
            | null
          >
        | undefined
      has: (key: string) => boolean
    }
  },
): Promise<PermissionResult>
/**
 * Checks if a subcommand is a git command after normalizing away safe wrappers
 * (env vars, timeout, etc.) and shell quotes.
 *
 * SECURITY: Must normalize before matching to prevent bypasses like:
 *   'git' status    — shell quotes hide the command from a naive regex
 *   NO_COLOR=1 git status — env var prefix hides the command
 */
export declare function isNormalizedGitCommand(command: string): boolean
/**
 * Checks if a subcommand is a cd command after normalizing away safe wrappers
 * (env vars, timeout, etc.) and shell quotes.
 *
 * SECURITY: Must normalize before matching to prevent bypasses like:
 *   FORCE_COLOR=1 cd sub — env var prefix hides the cd from a naive /^cd / regex
 *   This mirrors isNormalizedGitCommand to ensure symmetric normalization.
 *
 * Also matches pushd/popd — they change cwd just like cd, so
 *   pushd /tmp/bare-repo && git status
 * must trigger the same cd+git guard. Mirrors PowerShell's
 * DIRECTORY_CHANGE_ALIASES (src/utils/powershell/parser.ts).
 */
export declare function isNormalizedCdCommand(command: string): boolean
/**
 * Checks if a compound command contains any cd command,
 * using normalized detection that handles env var prefixes and shell quotes.
 */
export declare function commandHasAnyCd(command: string): boolean
export {}
