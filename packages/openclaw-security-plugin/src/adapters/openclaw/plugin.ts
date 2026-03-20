import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { registerSecurityRuntime } from "../../application/security-runtime.js";

const plugin = {
  id: "security-core",
  name: "Security Core",
  description: "SecureClaw-original based standalone security plugin.",
  register(api: OpenClawPluginApi) {
    registerSecurityRuntime(api);
  },
};

export default plugin;
