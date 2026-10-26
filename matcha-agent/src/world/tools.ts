import { buildTool, type Tool, type ToolDef } from '../Tool.js'
import { parameters, type WorldResult } from './schema.js'
import { admitted, available, execute } from './sender.js'

const OPERATIONS = [
  ['world_discover', 'discover', true],
  ['world_query', 'query', true],
  ['world_explain', 'explain', true],
  ['world_action_propose', 'action_propose', false],
  ['world_action_submit', 'action_submit', false],
  ['world_action_status', 'action_status', true],
  ['world_observe', 'observe', false],
  ['world_change_propose', 'change_propose', false],
  ['world_branch_test', 'branch_test', false],
] as const

export const worldTools: readonly Tool[] = OPERATIONS.map(
  ([name, operation, readOnly]) => {
    const schema = parameters(operation)
    return buildTool({
      name,
      inputSchema: schema.input,
      inputJSONSchema: schema.json,
      maxResultSizeChars: 50_000,
      isEnabled: available,
      isReadOnly: () => readOnly,
      isDestructive: () => operation === 'action_submit',
      isOpenWorld: () => true,
      toAutoClassifierInput: input => input,
      async checkPermissions() {
        return {
          behavior: 'passthrough',
          message: `Allow ${name} to access the World?`,
        }
      },
      async description() {
        return `World native ${operation} operation.`
      },
      async prompt() {
        return 'Use the public World request schema. Native runtime permission and current World grants are both required; parameters cannot select an identity or grant authority.'
      },
      async call(input) {
        // Revalidate the final hook/permission-modified input, not only the model's first input.
        const parsed = schema.input.parse(input)
        return { data: await execute(name, operation, parsed) }
      },
      renderToolUseMessage: () => name,
      mapToolResultToToolResultBlockParam: (data, toolUseId) => ({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: JSON.stringify(data),
        is_error: !data.success,
      }),
    } satisfies ToolDef<typeof schema.input, WorldResult>)
  },
)

/** Identity comparison prevents a same-named ordinary/MCP tool from acquiring native admission. */
export function invokeWorldTool<T>(
  tool: Tool,
  input: unknown,
  context: Parameters<typeof admitted>[2],
  invoke: () => T,
): T {
  return worldTools.includes(tool)
    ? admitted(tool.name, input, context, invoke)
    : invoke()
}
