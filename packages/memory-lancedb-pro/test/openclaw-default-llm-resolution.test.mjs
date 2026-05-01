import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import jitiFactory from "jiti";

const jiti = jitiFactory(import.meta.url, { interopDefault: true });
const plugin = jiti("../index.ts");

function createMockApi(pluginConfig, openclawConfig, logs, runtimeAuthResolver) {
  return {
    config: openclawConfig,
    pluginConfig,
    hooks: {},
    toolFactories: {},
    services: [],
    runtime: {
      modelAuth: {
        resolveApiKeyForProvider: runtimeAuthResolver,
      },
    },
    logger: {
      info(...args) { logs.push(["info", args.join(" ")]); },
      warn(...args) { logs.push(["warn", args.join(" ")]); },
      error(...args) { logs.push(["error", args.join(" ")]); },
      debug(...args) { logs.push(["debug", args.join(" ")]); },
    },
    resolvePath(value) {
      return value;
    },
    registerTool(toolOrFactory, meta) {
      this.toolFactories[meta.name] =
        typeof toolOrFactory === "function" ? toolOrFactory : () => toolOrFactory;
    },
    registerCli() {},
    registerService(service) {
      this.services.push(service);
    },
    on(name, handler) {
      this.hooks[name] = handler;
    },
    registerHook(name, handler) {
      this.hooks[name] = handler;
    },
  };
}

test("smart extraction inherits OpenClaw default LLM through runtime modelAuth for custom providers", async () => {
  const tempDir = mkdtempSync(path.join(tmpdir(), "memory-pro-openclaw-default-llm-"));
  let modelAuthCalls = 0;

  try {
    const openclawConfig = {
      agents: {
        defaults: {
          model: {
            primary: "custom-default/gpt-5.4",
          },
        },
      },
      models: {
        providers: {
          "custom-default": {
            api: "openai-responses",
            baseUrl: "http://127.0.0.1:8999/v1",
          },
        },
      },
    };

    const logs = [];
    const api = createMockApi(
      {
        dbPath: path.join(tempDir, "db"),
        autoCapture: true,
        autoRecall: false,
        smartExtraction: true,
        extractMinMessages: 1,
        embedding: {
          provider: "local-minilm",
          model: "all-MiniLM-L6-v2",
          dimensions: 384,
        },
        retrieval: {
          mode: "hybrid",
        },
        scopes: {
          default: "global",
          definitions: {
            global: { description: "shared" },
          },
        },
      },
      openclawConfig,
      logs,
      async ({ provider, cfg }) => {
        modelAuthCalls += 1;
        assert.equal(provider, "custom-default");
        assert.equal(cfg, openclawConfig);
        return {
          apiKey: "custom-runtime-key",
          source: "test-runtime",
          mode: "api-key",
        };
      },
    );

    plugin.register(api);

    const agentEndHook = api.hooks.agent_end;
    assert.equal(typeof agentEndHook, "function");

    agentEndHook(
      {
        success: true,
        sessionKey: "agent:main:test",
        messages: [{ role: "user", content: "Remember that I prefer sencha tea." }],
      },
      {
        sessionKey: "agent:main:test",
        sessionId: "session-1",
        agentId: "main",
      },
    );
    await agentEndHook.__lastRun;

    const warnLogs = logs
      .filter(([level]) => level === "warn")
      .map(([, message]) => message);
    const infoLogs = logs
      .filter(([level]) => level === "info")
      .map(([, message]) => message);

    assert.equal(modelAuthCalls, 1, "expected runtime modelAuth to resolve the inherited api key exactly once");
    assert.ok(
      !warnLogs.some((message) => message.includes("smart extraction init failed")),
      `expected smart extraction init to succeed, got warns: ${JSON.stringify(warnLogs)}`,
    );
    assert.ok(
      infoLogs.some((message) => message.includes("smart extraction enabled (LLM model: gpt-5.4")),
      `expected inherited OpenClaw model log, got info: ${JSON.stringify(infoLogs)}`,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
