import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { registerSecurityRuntime } from "../../application/security-runtime.js";
import {
  SECURITY_CORE_PLUGIN_DESCRIPTION,
  SECURITY_CORE_PLUGIN_ID,
  SECURITY_CORE_PLUGIN_NAME,
} from "../../manifest.js";

const plugin = definePluginEntry({
  id: SECURITY_CORE_PLUGIN_ID,
  name: SECURITY_CORE_PLUGIN_NAME,
  description: SECURITY_CORE_PLUGIN_DESCRIPTION,
  register(api: OpenClawPluginApi) {
    registerSecurityRuntime(api);
  },
});

export default plugin;
