import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { parameters } from './schema.js'
import { createSender } from './sender.js'

const tools = [
  ['world_discover', 'discover', 'Discover the authorized World definitions and capabilities.'],
  ['world_query', 'query', 'Read World objects and relations with their current read receipt.'],
  ['world_explain', 'explain', 'Explain visible evidence and support for a World assertion.'],
  ['world_action_propose', 'action_propose', 'Prepare a World action proposal without executing external effects.'],
  ['world_action_submit', 'action_submit', 'Submit an authorized World action proposal.'],
  ['world_action_status', 'action_status', 'Read the status and receipt of a World action.'],
  ['world_observe', 'observe', 'Propose an evidence-backed observation to World fact admission.'],
  ['world_change_propose', 'change_propose', 'Propose a typed World definition change for review.'],
  ['world_branch_test', 'branch_test', 'Evaluate a World branch using its declared test cases.'],
] as const

export default definePluginEntry({
  id: 'world-tools',
  name: 'World Tools',
  description: 'Execution-bound native access to World.',
  register(api) {
    const sender = createSender(api, new Set(tools.map(([name]) => name)))
    for (const [name, operation, description] of tools) {
      const schema = parameters(operation)
      api.registerTool(context => ({
        name,
        label: name,
        description,
        parameters: schema,
        execute: sender(context, name, operation),
      }), { name })
    }
  },
})
