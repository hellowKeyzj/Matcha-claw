import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { registerBackgroundTaskTools } from './application/background-task-tools.js'
import { registerTaskGatewayMethods } from './application/task-gateway-adapters.js'
import { registerTaskPromptHook } from './application/task-prompt-hook.js'
import { registerTaskTools } from './application/task-tools.js'
import { TASK_MANAGER_PLUGIN_DESCRIPTION, TASK_MANAGER_PLUGIN_ID, TASK_MANAGER_PLUGIN_NAME } from './manifest.js'

export default definePluginEntry({
  id: TASK_MANAGER_PLUGIN_ID,
  name: TASK_MANAGER_PLUGIN_NAME,
  description: TASK_MANAGER_PLUGIN_DESCRIPTION,
  register(api: OpenClawPluginApi) {
    registerTaskTools(api)
    registerBackgroundTaskTools(api)
    registerTaskGatewayMethods(api)
    registerTaskPromptHook(api)
  },
})
