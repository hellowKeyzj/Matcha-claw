import type { OpenClawPluginApi } from 'openclaw/plugin-sdk'
import { registerTaskGatewayMethods } from './application/task-gateway-adapters.js'
import { registerTaskTools } from './application/task-tool-adapters.js'
import { TASK_MANAGER_PLUGIN_ID } from './manifest.js'

const plugin = {
  id: TASK_MANAGER_PLUGIN_ID,
  register(api: OpenClawPluginApi) {
    registerTaskTools(api)
    registerTaskGatewayMethods(api)
  },
}

export default plugin
