import type { CoreTool, Tools } from './types.js'
/**
 * Checks if a tool matches the given name (primary name or alias).
 */
export declare function toolMatchesName(
  tool: {
    name: string
    aliases?: string[]
  },
  name: string,
): boolean
/**
 * Finds a tool by name or alias from a list of tools.
 */
export declare function findToolByName(
  tools: Tools,
  name: string,
): CoreTool | undefined
