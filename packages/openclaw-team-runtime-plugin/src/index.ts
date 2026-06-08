import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry'
import { registerTeamGatewayMethods } from './gateway/team-gateway-methods.js'
import { registerTeamArtifactTools } from './tools/team-artifact-tools.js'
import {
  TEAM_RUNTIME_PLUGIN_DESCRIPTION,
  TEAM_RUNTIME_PLUGIN_ID,
  TEAM_RUNTIME_PLUGIN_NAME,
} from './manifest.js'

export default definePluginEntry({
  id: TEAM_RUNTIME_PLUGIN_ID,
  name: TEAM_RUNTIME_PLUGIN_NAME,
  description: TEAM_RUNTIME_PLUGIN_DESCRIPTION,
  register(api: OpenClawPluginApi) {
    registerTeamGatewayMethods(api)
    registerTeamArtifactTools(api)
  },
})
