import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { registerSecurityRuntime } from "./application/security-runtime.js";
import {
  SECURITY_CORE_PLUGIN_DESCRIPTION,
  SECURITY_CORE_PLUGIN_ID,
  SECURITY_CORE_PLUGIN_NAME,
} from "./manifest.js";

export default definePluginEntry({
  id: SECURITY_CORE_PLUGIN_ID,
  name: SECURITY_CORE_PLUGIN_NAME,
  description: SECURITY_CORE_PLUGIN_DESCRIPTION,
  register(api: OpenClawPluginApi) {
    registerSecurityRuntime(api);
  },
});
