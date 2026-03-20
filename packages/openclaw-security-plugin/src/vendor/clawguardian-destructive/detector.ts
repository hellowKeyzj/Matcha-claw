import destructiveRulesRaw from "./destructive-rules.json";

export type DestructiveCategory =
  | "file_delete"
  | "git_destructive"
  | "sql_destructive"
  | "system_destructive"
  | "process_kill"
  | "network_destructive"
  | "privilege_escalation";

export type DestructiveSeverity = "low" | "medium" | "high" | "critical";

export type DestructiveMatch = {
  category: DestructiveCategory;
  reason: string;
  severity: DestructiveSeverity;
  pattern: string;
};

type SystemRuleContext = { command: string; args: string[]; argsText: string };

type SqlPatternConfig = {
  name: string;
  pattern: string;
  reason: string;
  severity: DestructiveSeverity;
};

type DangerousPathConfig = {
  pattern: string;
  reason: string;
  severity: DestructiveSeverity;
};

type RemoteCodePatternConfig = {
  name: string;
  pattern: string;
};

type FileTruncationConfig = {
  pattern: string;
  dangerousPrefixes: string[];
  dangerousEquals: string[];
};

type PowershellRuleConfig = {
  allContains?: string[];
  anyContains?: string[];
  category: DestructiveCategory;
  severity: DestructiveSeverity;
  reason: string;
  pattern: string;
};

type SystemRuleConfig = {
  commands: string[];
  allRegex?: string[];
  anyRegex?: string[];
  category: DestructiveCategory;
  severity: DestructiveSeverity;
  reason: string;
  pattern: string;
};

type DestructiveRuleConfig = {
  version: number;
  sqlPatterns: SqlPatternConfig[];
  remoteCodeExecutionPatterns: RemoteCodePatternConfig[];
  dangerousPaths: DangerousPathConfig[];
  fileTruncation: FileTruncationConfig;
  powershellRules: PowershellRuleConfig[];
  system: {
    commandSets: {
      linux: string[];
      windows: string[];
      macos: string[];
    };
    universal: SystemRuleConfig[];
    linux: SystemRuleConfig[];
    windows: SystemRuleConfig[];
    macos: SystemRuleConfig[];
  };
};

type CompiledSystemRule = {
  allRegex: RegExp[];
  anyRegex: RegExp[];
  category: DestructiveCategory;
  severity: DestructiveSeverity;
  reason: string;
  pattern: string;
};

type CompiledRules = {
  sqlPatterns: Array<SqlPatternConfig & { regex: RegExp }>;
  dangerousPaths: Array<DangerousPathConfig & { regex: RegExp }>;
  remoteCodePatterns: Array<RemoteCodePatternConfig & { regex: RegExp }>;
  fileTruncation: {
    pattern: RegExp;
    dangerousPrefixes: string[];
    dangerousEquals: string[];
  };
  powershellRules: Array<PowershellRuleConfig & {
    allContains: string[];
    anyContains: string[];
  }>;
  systemBuckets: {
    universal: Map<string, CompiledSystemRule[]>;
    linux: Map<string, CompiledSystemRule[]>;
    windows: Map<string, CompiledSystemRule[]>;
    macos: Map<string, CompiledSystemRule[]>;
  };
  commandSets: {
    linux: Set<string>;
    windows: Set<string>;
    macos: Set<string>;
  };
};

const destructiveRulesConfig = destructiveRulesRaw as DestructiveRuleConfig;
let compiledRulesCache: CompiledRules | undefined;

function compileRegex(pattern: string, flags = "i"): RegExp {
  return new RegExp(pattern, flags);
}

function compileSystemRules(rules: SystemRuleConfig[]): Map<string, CompiledSystemRule[]> {
  const buckets = new Map<string, CompiledSystemRule[]>();
  for (const rule of rules) {
    const compiledRule: CompiledSystemRule = {
      allRegex: (rule.allRegex ?? []).map((item) => compileRegex(item)),
      anyRegex: (rule.anyRegex ?? []).map((item) => compileRegex(item)),
      category: rule.category,
      severity: rule.severity,
      reason: rule.reason,
      pattern: rule.pattern,
    };
    for (const command of rule.commands) {
      const normalized = command.toLowerCase();
      const items = buckets.get(normalized) ?? [];
      items.push(compiledRule);
      buckets.set(normalized, items);
    }
  }
  return buckets;
}

function compileRules(config: DestructiveRuleConfig): CompiledRules {
  return {
    sqlPatterns: config.sqlPatterns.map((item) => ({ ...item, regex: compileRegex(item.pattern) })),
    dangerousPaths: config.dangerousPaths.map((item) => ({ ...item, regex: compileRegex(item.pattern) })),
    remoteCodePatterns: config.remoteCodeExecutionPatterns.map((item) => ({ ...item, regex: compileRegex(item.pattern) })),
    fileTruncation: {
      pattern: compileRegex(config.fileTruncation.pattern),
      dangerousPrefixes: [...config.fileTruncation.dangerousPrefixes],
      dangerousEquals: [...config.fileTruncation.dangerousEquals],
    },
    powershellRules: config.powershellRules.map((item) => ({
      ...item,
      allContains: (item.allContains ?? []).map((token) => token.toLowerCase()),
      anyContains: (item.anyContains ?? []).map((token) => token.toLowerCase()),
    })),
    systemBuckets: {
      universal: compileSystemRules(config.system.universal),
      linux: compileSystemRules(config.system.linux),
      windows: compileSystemRules(config.system.windows),
      macos: compileSystemRules(config.system.macos),
    },
    commandSets: {
      linux: new Set(config.system.commandSets.linux.map((item) => item.toLowerCase())),
      windows: new Set(config.system.commandSets.windows.map((item) => item.toLowerCase())),
      macos: new Set(config.system.commandSets.macos.map((item) => item.toLowerCase())),
    },
  };
}

function getCompiledRules(): CompiledRules {
  if (!compiledRulesCache) {
    compiledRulesCache = compileRules(destructiveRulesConfig);
  }
  return compiledRulesCache;
}

export function resetDestructiveRuleCacheForTests(): void {
  compiledRulesCache = undefined;
}

function renderTemplate(template: string, context: SystemRuleContext): string {
  const arg0 = context.args[0] ?? "";
  const arg1 = context.args[1] ?? "";
  return template
    .replaceAll("{command}", context.command)
    .replaceAll("{arg0}", arg0)
    .replaceAll("{arg1}", arg1);
}

/**
 * Check if rm command has both recursive and force flags (SafeExec pattern).
 * Gates: rm -rf, rm -fr, rm --recursive --force
 */
export function isDestructiveRm(args: string[]): DestructiveMatch | undefined {
  let force = false;
  let recursive = false;

  for (const arg of args) {
    if (arg === "--") {
      break;
    }
    if (arg === "--force") {
      force = true;
    }
    if (arg === "--recursive") {
      recursive = true;
    }
    if (arg.startsWith("-") && arg !== "-" && arg !== "--") {
      const hasForceFlag = arg.includes("f");
      const hasRecursiveFlag = arg.includes("r") || arg.includes("R");
      if (hasForceFlag) {
        force = true;
      }
      if (hasRecursiveFlag) {
        recursive = true;
      }
    }
  }

  if (force && recursive) {
    return {
      category: "file_delete",
      reason: "Recursive force deletion (rm -rf)",
      severity: "critical",
      pattern: "rm -rf",
    };
  }
  return undefined;
}

/**
 * Check if git command is destructive (SafeExec patterns).
 * Always gated: reset, revert, checkout, restore
 * Gated if forced: clean -f, switch -f/--discard-changes
 * Gated stash ops: drop, clear, pop
 */
export function isDestructiveGit(args: string[]): DestructiveMatch | undefined {
  let subcmd = "";
  let subcmdIdx = -1;
  let i = 0;

  while (i < args.length) {
    const a = args[i];
    if (a.match(/^--.*=.*/)) {
      i++;
      continue;
    }
    if (
      [
        "-C",
        "-c",
        "--exec-path",
        "--html-path",
        "--man-path",
        "--info-path",
        "--git-dir",
        "--work-tree",
        "--namespace",
        "--super-prefix",
      ].includes(a)
    ) {
      i += 2;
      continue;
    }
    if (a === "--") {
      i++;
      break;
    }
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    subcmd = a;
    subcmdIdx = i;
    break;
  }

  if (!subcmd) {
    return undefined;
  }

  if (["reset", "revert", "checkout", "restore"].includes(subcmd)) {
    const hasHard = args.some((a) => a === "--hard");
    return {
      category: "git_destructive",
      reason: `git ${subcmd}${hasHard ? " --hard" : ""} can lose uncommitted changes`,
      severity: hasHard ? "critical" : "high",
      pattern: `git ${subcmd}`,
    };
  }

  if (subcmd === "clean") {
    const hasForce = args.some((a) => a === "-f" || a === "--force");
    if (hasForce) {
      return {
        category: "git_destructive",
        reason: "git clean -f removes untracked files permanently",
        severity: "high",
        pattern: "git clean -f",
      };
    }
  }

  if (subcmd === "switch") {
    const hasForce = args.some((a) => a === "-f" || a === "--force" || a === "--discard-changes");
    if (hasForce) {
      return {
        category: "git_destructive",
        reason: "git switch with force/discard-changes loses uncommitted work",
        severity: "high",
        pattern: "git switch -f",
      };
    }
  }

  if (subcmd === "stash" && subcmdIdx + 1 < args.length) {
    const stashOp = args[subcmdIdx + 1];
    if (["drop", "clear", "pop"].includes(stashOp)) {
      return {
        category: "git_destructive",
        reason: `git stash ${stashOp} can lose stashed changes`,
        severity: stashOp === "clear" ? "critical" : "high",
        pattern: `git stash ${stashOp}`,
      };
    }
  }

  if (subcmd === "push") {
    const hasForce = args.some((a) => a === "-f" || a === "--force" || a === "--force-with-lease");
    if (hasForce) {
      return {
        category: "git_destructive",
        reason: "git push --force can overwrite remote history",
        severity: "critical",
        pattern: "git push --force",
      };
    }
  }

  if (subcmd === "branch") {
    const hasDelete = args.some((a) => a === "-d" || a === "-D" || a === "--delete");
    if (hasDelete) {
      return {
        category: "git_destructive",
        reason: "git branch delete removes branch",
        severity: "medium",
        pattern: "git branch -d",
      };
    }
  }

  if (subcmd === "reflog" && subcmdIdx + 1 < args.length) {
    const reflogOp = args[subcmdIdx + 1];
    if (["expire", "delete"].includes(reflogOp)) {
      return {
        category: "git_destructive",
        reason: `git reflog ${reflogOp} removes recovery points`,
        severity: "critical",
        pattern: `git reflog ${reflogOp}`,
      };
    }
  }

  return undefined;
}

/**
 * SQL destructive patterns.
 */
export function isDestructiveSql(text: string): DestructiveMatch | undefined {
  const compiled = getCompiledRules();
  for (const item of compiled.sqlPatterns) {
    if (item.regex.test(text)) {
      return {
        category: "sql_destructive",
        reason: item.reason,
        severity: item.severity,
        pattern: item.name,
      };
    }
  }
  return undefined;
}

function runSystemRules(rules: CompiledSystemRule[], context: SystemRuleContext): DestructiveMatch | undefined {
  for (const rule of rules) {
    if (rule.allRegex.length > 0 && !rule.allRegex.every((re) => re.test(context.argsText))) {
      continue;
    }
    if (rule.anyRegex.length > 0 && !rule.anyRegex.some((re) => re.test(context.argsText))) {
      continue;
    }
    return {
      category: rule.category,
      reason: renderTemplate(rule.reason, context),
      severity: rule.severity,
      pattern: renderTemplate(rule.pattern, context),
    };
  }
  return undefined;
}

function resolvePlatformScopes(command: string, commandSets: CompiledRules["commandSets"]): Array<keyof CompiledRules["systemBuckets"]> {
  if (commandSets.linux.has(command)) return ["linux"];
  if (commandSets.windows.has(command)) return ["windows"];
  if (commandSets.macos.has(command)) return ["macos"];
  return ["linux", "windows", "macos"];
}

/**
 * System destructive commands.
 */
export function isDestructiveSystem(command: string, args: string[]): DestructiveMatch | undefined {
  const compiled = getCompiledRules();
  const normalizedCommand = command.toLowerCase();
  const context: SystemRuleContext = { command: normalizedCommand, args, argsText: args.join(" ") };

  const universalRules = compiled.systemBuckets.universal.get(normalizedCommand) ?? [];
  const universalMatch = runSystemRules(universalRules, context);
  if (universalMatch) {
    return universalMatch;
  }

  const scopes = resolvePlatformScopes(normalizedCommand, compiled.commandSets);
  for (const scope of scopes) {
    const rules = compiled.systemBuckets[scope].get(normalizedCommand) ?? [];
    const scopedMatch = runSystemRules(rules, context);
    if (scopedMatch) {
      return scopedMatch;
    }
  }

  return undefined;
}

/**
 * Check for privilege escalation commands (sudo, doas, su, pkexec).
 * Returns the match and the remaining command/args after stripping the prefix.
 */
export function checkPrivilegeEscalation(
  command: string,
  args: string[],
): { match: DestructiveMatch; innerCommand: string; innerArgs: string[] } | undefined {
  const cmd = command.toLowerCase();
  const privEscCommands = ["sudo", "doas", "pkexec", "su"];
  if (!privEscCommands.includes(cmd)) {
    return undefined;
  }

  let innerCommand = "";
  let innerArgs: string[] = [];
  let i = 0;

  if (cmd === "sudo" || cmd === "doas") {
    while (i < args.length) {
      const a = args[i];
      if (["-u", "-g", "-C", "-h", "-p", "-r", "-t", "-U", "-D"].includes(a)) {
        i += 2;
        continue;
      }
      if (a.startsWith("-")) {
        i++;
        continue;
      }
      innerCommand = a;
      innerArgs = args.slice(i + 1);
      break;
    }
  } else if (cmd === "su") {
    const cIdx = args.indexOf("-c");
    if (cIdx !== -1 && cIdx + 1 < args.length) {
      const cmdStr = args[cIdx + 1];
      const parts = cmdStr.split(/\s+/);
      innerCommand = parts[0] || "";
      innerArgs = parts.slice(1);
    }
  } else if (cmd === "pkexec") {
    while (i < args.length) {
      const a = args[i];
      if (a.startsWith("-")) {
        i++;
        continue;
      }
      innerCommand = a;
      innerArgs = args.slice(i + 1);
      break;
    }
  }

  return {
    match: {
      category: "privilege_escalation",
      reason: `${cmd} runs command with elevated privileges`,
      severity: "high",
      pattern: cmd,
    },
    innerCommand,
    innerArgs,
  };
}

/**
 * Check for dangerous paths in arguments.
 */
export function hasDangerousPath(args: string[]): DestructiveMatch | undefined {
  const compiled = getCompiledRules();
  for (const arg of args) {
    for (const rule of compiled.dangerousPaths) {
      if (rule.regex.test(arg)) {
        return {
          category: "file_delete",
          reason: `Operation on ${rule.reason}`,
          severity: rule.severity,
          pattern: arg,
        };
      }
    }
  }
  return undefined;
}

/**
 * Check for find command with -delete or -exec rm.
 */
export function isDestructiveFind(args: string[]): DestructiveMatch | undefined {
  const hasDelete = args.some((a) => a === "-delete");
  const hasExecRm = args.some((a, i) => {
    if (a === "-exec" && i + 1 < args.length) {
      const execCmd = args[i + 1];
      return execCmd === "rm" || execCmd.endsWith("/rm");
    }
    return false;
  });

  if (hasDelete || hasExecRm) {
    const startPath = args.find((a) => !a.startsWith("-") && a !== "find");
    const isDangerousPath =
      startPath === "/" ||
      startPath === "~" ||
      startPath === "$HOME" ||
      startPath?.startsWith("/etc") ||
      startPath?.startsWith("/usr");

    return {
      category: "file_delete",
      reason: `find with ${hasDelete ? "-delete" : "-exec rm"} can remove many files`,
      severity: isDangerousPath ? "critical" : "high",
      pattern: hasDelete ? "find -delete" : "find -exec rm",
    };
  }
  return undefined;
}

/**
 * Check for xargs with rm or other dangerous commands.
 */
export function isDestructiveXargs(args: string[]): DestructiveMatch | undefined {
  const rmIdx = args.findIndex((a) => a === "rm" || a.endsWith("/rm"));
  if (rmIdx !== -1) {
    const rmArgs = args.slice(rmIdx + 1);
    const rmMatch = isDestructiveRm(rmArgs);
    if (rmMatch) {
      return {
        ...rmMatch,
        reason: `xargs ${rmMatch.reason}`,
        pattern: `xargs ${rmMatch.pattern}`,
      };
    }
    return {
      category: "file_delete",
      reason: "xargs rm can delete many files",
      severity: "high",
      pattern: "xargs rm",
    };
  }
  return undefined;
}

/**
 * Check for piped remote code execution (curl|bash, wget|sh, etc.).
 */
export function isRemoteCodeExecution(fullCommand: string): DestructiveMatch | undefined {
  const compiled = getCompiledRules();
  for (const item of compiled.remoteCodePatterns) {
    if (item.regex.test(fullCommand)) {
      return {
        category: "system_destructive",
        reason: `Remote code execution via ${item.name}`,
        severity: "critical",
        pattern: item.name,
      };
    }
  }
  return undefined;
}

/**
 * Check for file truncation (> /path).
 */
export function isFileTruncation(fullCommand: string): DestructiveMatch | undefined {
  const compiled = getCompiledRules();
  const match = fullCommand.match(compiled.fileTruncation.pattern);
  if (!match) {
    return undefined;
  }

  const path = match[1] ?? "";
  const isDangerousPrefix = compiled.fileTruncation.dangerousPrefixes.some((prefix) => path.startsWith(prefix));
  const isDangerousExact = compiled.fileTruncation.dangerousEquals.includes(path);
  const isDangerous = isDangerousPrefix || isDangerousExact;
  if (isDangerous || path.startsWith("/")) {
    return {
      category: "file_delete",
      reason: `File truncation can destroy ${path}`,
      severity: isDangerous ? "critical" : "high",
      pattern: `> ${path}`,
    };
  }
  return undefined;
}

function normalizeCommandName(rawCommand: string): string {
  const parts = rawCommand.split(/[\\/]/);
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

function applyPowershellRules(script: string): DestructiveMatch | undefined {
  const compiled = getCompiledRules();
  for (const rule of compiled.powershellRules) {
    if (rule.allContains.length > 0 && !rule.allContains.every((token) => script.includes(token))) {
      continue;
    }
    if (rule.anyContains.length > 0 && !rule.anyContains.some((token) => script.includes(token))) {
      continue;
    }
    return {
      category: rule.category,
      reason: rule.reason,
      severity: rule.severity,
      pattern: rule.pattern,
    };
  }
  return undefined;
}

/**
 * Main detection function - checks all patterns.
 */
export function detectDestructive(
  toolName: string,
  params: Record<string, unknown>,
): DestructiveMatch | undefined {
  const name = toolName.toLowerCase();

  let command = "";
  let args: string[] = [];
  let fullCommand = "";

  if (typeof params.command === "string") {
    fullCommand = params.command;
    const parts = params.command.split(/\s+/);
    command = parts[0] || "";
    args = parts.slice(1);
  } else if (typeof params.cmd === "string") {
    fullCommand = params.cmd;
    const parts = params.cmd.split(/\s+/);
    command = parts[0] || "";
    args = parts.slice(1);
  } else if (Array.isArray(params.args)) {
    args = params.args.map(String);
    command = args[0] || "";
    args = args.slice(1);
    fullCommand = params.args.join(" ");
  } else if (typeof params.input === "string") {
    fullCommand = params.input;
    const sqlMatch = isDestructiveSql(params.input);
    if (sqlMatch) {
      return sqlMatch;
    }
  }

  if (fullCommand) {
    const rceMatch = isRemoteCodeExecution(fullCommand);
    if (rceMatch) {
      return rceMatch;
    }

    const truncateMatch = isFileTruncation(fullCommand);
    if (truncateMatch) {
      return truncateMatch;
    }
  }

  const cmdName = normalizeCommandName(command) || name;

  const privEsc = checkPrivilegeEscalation(cmdName, args);
  if (privEsc) {
    const innerCmdName = normalizeCommandName(privEsc.innerCommand);

    if (innerCmdName === "rm" || innerCmdName === "del" || innerCmdName === "remove") {
      const rmMatch = isDestructiveRm(privEsc.innerArgs);
      if (rmMatch) {
        return {
          ...rmMatch,
          reason: `sudo ${rmMatch.reason}`,
          severity: "critical",
          pattern: `sudo ${rmMatch.pattern}`,
        };
      }
    }

    if (innerCmdName === "git") {
      const gitMatch = isDestructiveGit(privEsc.innerArgs);
      if (gitMatch) {
        return {
          ...gitMatch,
          reason: `sudo ${gitMatch.reason}`,
          pattern: `sudo ${gitMatch.pattern}`,
        };
      }
    }

    if (innerCmdName === "find") {
      const findMatch = isDestructiveFind(privEsc.innerArgs);
      if (findMatch) {
        return {
          ...findMatch,
          reason: `sudo ${findMatch.reason}`,
          severity: "critical",
          pattern: `sudo ${findMatch.pattern}`,
        };
      }
    }

    const innerSysMatch = isDestructiveSystem(innerCmdName, privEsc.innerArgs);
    if (innerSysMatch) {
      return {
        ...innerSysMatch,
        reason: `sudo ${innerSysMatch.reason}`,
        severity: "critical",
        pattern: `sudo ${innerSysMatch.pattern}`,
      };
    }

    const innerPathMatch = hasDangerousPath(privEsc.innerArgs);
    if (innerPathMatch) {
      return {
        ...innerPathMatch,
        reason: `sudo ${innerPathMatch.reason}`,
        severity: "critical",
        pattern: `sudo ${innerPathMatch.pattern}`,
      };
    }

    return privEsc.match;
  }

  if (cmdName === "rm" || cmdName === "del" || cmdName === "remove") {
    const rmMatch = isDestructiveRm(args);
    if (rmMatch) {
      return rmMatch;
    }
  }

  if (cmdName === "git") {
    const gitMatch = isDestructiveGit(args);
    if (gitMatch) {
      return gitMatch;
    }
  }

  if (cmdName === "find") {
    const findMatch = isDestructiveFind(args);
    if (findMatch) {
      return findMatch;
    }
  }

  if (cmdName === "xargs") {
    const xargsMatch = isDestructiveXargs(args);
    if (xargsMatch) {
      return xargsMatch;
    }
  }

  if (cmdName === "powershell" || cmdName === "pwsh") {
    const psScript = [command, ...args].join(" ").toLowerCase();
    const psMatch = applyPowershellRules(psScript);
    if (psMatch) {
      return psMatch;
    }
  }

  const sysMatch = isDestructiveSystem(cmdName, args);
  if (sysMatch) {
    return sysMatch;
  }

  const pathMatch = hasDangerousPath(args);
  if (pathMatch) {
    return pathMatch;
  }

  for (const value of Object.values(params)) {
    if (typeof value === "string") {
      const sqlMatch = isDestructiveSql(value);
      if (sqlMatch) {
        return sqlMatch;
      }
    }
  }

  return undefined;
}

/**
 * Quick check if a tool call might be destructive.
 */
export function mightBeDestructive(toolName: string, params: Record<string, unknown>): boolean {
  return detectDestructive(toolName, params) !== undefined;
}
