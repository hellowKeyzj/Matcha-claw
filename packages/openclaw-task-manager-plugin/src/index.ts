import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { registerBackgroundTaskTools } from './application/background-task-tools.js'
import { registerTaskGatewayMethods } from './application/task-gateway-adapters.js'
import { registerWorkBuddyTaskTools } from './application/workbuddy-task-tools.js'
import { TASK_MANAGER_PLUGIN_ID } from './manifest.js'

const plugin = {
  id: TASK_MANAGER_PLUGIN_ID,
  register(api: OpenClawPluginApi) {
    registerWorkBuddyTaskTools(api)
    registerBackgroundTaskTools(api)
    registerTaskGatewayMethods(api)
  },
}

export default plugin
