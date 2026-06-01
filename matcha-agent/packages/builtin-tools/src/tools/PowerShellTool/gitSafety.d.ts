/**
 * Git can be weaponized for sandbox escape via two vectors:
 * 1. Bare-repo attack: if cwd contains HEAD + objects/ + refs/ but no valid
 *    .git/HEAD, Git treats cwd as a bare repository and runs hooks from cwd.
 * 2. Git-internal write + git: a compound command creates HEAD/objects/refs/
 *    hooks/ then runs git — the git subcommand executes the freshly-created
 *    malicious hooks.
 */
/**
 * True if arg (raw PS arg text) resolves to a git-internal path in cwd.
 * Covers both bare-repo paths (hooks/, refs/) and standard-repo paths
 * (.git/hooks/, .git/config).
 */
export declare function isGitInternalPathPS(arg: string): boolean
/**
 * True if arg resolves to a path inside .git/ (standard-repo metadata dir).
 * Unlike isGitInternalPathPS, does NOT match bare-repo-style root-level
 * `hooks/`, `refs/` etc. — those are common project directory names.
 */
export declare function isDotGitPathPS(arg: string): boolean
