import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { registerBackgroundTaskTools } from './application/background-task-tools.js'
import { registerTaskGatewayMethods } from './application/task-gateway-adapters.js'
import { registerTaskPromptHook } from './application/task-prompt-hook.js'
import { registerTaskTools } from './application/task-tools.js'
import { TASK_MANAGER_PLUGIN_ID } from './manifest.js'

const plugin = {
  id: TASK_MANAGER_PLUGIN_ID,
  register(api: OpenClawPluginApi) {
    registerTaskTools(api)
    registerBackgroundTaskTools(api)
    registerTaskGatewayMethods(api)
    registerTaskPromptHook(api)
  },
}

export default plugin
