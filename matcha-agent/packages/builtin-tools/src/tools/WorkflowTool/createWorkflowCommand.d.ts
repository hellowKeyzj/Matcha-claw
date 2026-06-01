import type { Command } from 'src/types/command.js'
/**
 * Scans .claude/workflows/ directory and creates Command objects for each workflow file.
 * Each workflow file becomes a slash command (e.g. /workflow-name).
 */
export declare function getWorkflowCommands(cwd: string): Promise<Command[]>
