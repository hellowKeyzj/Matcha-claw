import ignore from 'ignore'
import type { ToolPermissionContext } from '../../Tool.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import {
  getAskRuleForTool,
  getDenyRuleForTool,
  getRuleByContentsForToolName,
} from '../../utils/permissions/permissions.js'
import { matchWildcardPattern } from '../../utils/permissions/shellRuleMatching.js'
import { parseSealedSkillPath } from './reference.js'

// Virtual resources have no filesystem alias. Apply native Read deny/ask rules
// to the URI and package-relative path, never to a fabricated local filename.
export function sealedReadPermission(
  uri: string,
  context: ToolPermissionContext,
): PermissionDecision {
  const { skillKey, path } = parseSealedSkillPath(uri)
  const tool = { name: 'Read' }
  for (const behavior of ['deny', 'ask'] as const) {
    const rule =
      (behavior === 'deny'
        ? getDenyRuleForTool(context, tool)
        : getAskRuleForTool(context, tool)) ??
      [...getRuleByContentsForToolName(context, 'Read', behavior)].find(
        ([pattern]) =>
          [uri, `${skillKey}/${path}`, path].some(value =>
            matchWildcardPattern(pattern, value),
          ) ||
          (!pattern.startsWith('/') &&
            !pattern.startsWith('~') &&
            !pattern.startsWith('matcha-skill:') &&
            ignore()
              .add(pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern)
              .ignores(path)),
      )?.[1]
    if (rule) {
      return {
        behavior,
        message:
          behavior === 'deny'
            ? 'Sealed skill Read is denied by native permission settings.'
            : 'Sealed skill Read requires native permission.',
        decisionReason: { type: 'rule', rule },
      }
    }
  }
  // This permits only attempting the scoped catalog read, not arbitrary files.
  return { behavior: 'allow' }
}
