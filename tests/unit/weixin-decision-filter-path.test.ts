import { describe, expect, it } from "vitest";

import plugin from "../../packages/openclaw-task-manager-plugin/src/index";
import { markdownToPlainText } from "../../node_modules/.pnpm/@tencent-weixin+openclaw-weixin@1.0.2/node_modules/@tencent-weixin/openclaw-weixin/src/messaging/send";

type HookHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
type PluginApiLike = Parameters<NonNullable<typeof plugin.register>>[0];

function createFakeApi() {
  const hooks = new Map<string, HookHandler>();
  const api = {
    config: {},
    pluginConfig: {},
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    registerTool: () => {},
    registerGatewayMethod: () => {},
    registerHttpRoute: () => {},
    on: (name: string, handler: HookHandler) => {
      hooks.set(name, handler);
    },
  };
  plugin.register(api as PluginApiLike);
  return { hooks };
}

describe("weixin 普通聊天链路与 task-manager 过滤差异", () => {
  const raw = [
    "先给你结论。",
    "```task_router_decision_json",
    '{"decision":"draft","reuseExisting":false,"existingTaskId":"","allowDuplicate":false,"confidence":0.82}',
    "```",
  ].join("\n");

  it("task-manager message_sending 会剥离决策块", () => {
    const { hooks } = createFakeApi();
    const hook = hooks.get("message_sending");
    expect(hook).toBeTypeOf("function");

    const result = hook?.(
      { to: "oc_xxx", content: raw },
      { channelId: "feishu", accountId: "acc-1", conversationId: "conv-1" },
    );

    expect(result).toEqual({ content: "先给你结论。" });
  });

  it("weixin 发送前 markdownToPlainText 不会删除决策 JSON 内容", () => {
    const plain = markdownToPlainText(raw);
    expect(plain).toContain("先给你结论。");
    expect(plain).toContain('"decision":"draft"');
    expect(plain).not.toContain("```");
  });
});
