import { describe, expect, it } from "vitest";
import plugin from "../../packages/openclaw-security-plugin/src/index";

type FakeApi = {
  gatewayMethods: Map<string, (options: any) => Promise<void> | void>;
  hooks: Map<string, (event: any, ctx: any) => Promise<any> | any>;
};

function createFakeApi(pluginConfig?: Record<string, unknown>): FakeApi {
  const gatewayMethods = new Map<string, (options: any) => Promise<void> | void>();
  const hooks = new Map<string, (event: any, ctx: any) => Promise<any> | any>();
  const api = {
    pluginConfig,
    logger: {
      info: (_message: string) => {},
      warn: (_message: string) => {},
    },
    registerGatewayMethod: (name: string, handler: (options: any) => Promise<void> | void) => {
      gatewayMethods.set(name, handler);
    },
    on: (name: string, handler: (event: any, ctx: any) => Promise<any> | any) => {
      hooks.set(name, handler);
    },
  };
  plugin.register(api as any);
  return { gatewayMethods, hooks };
}

function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[index];
}

function avg(samples: number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((sum, value) => sum + value, 0) / samples.length;
}

async function runScenario(params: {
  label: string;
  hook: (event: any, ctx: any) => Promise<any> | any;
  eventFactory: (i: number) => Record<string, unknown>;
  iterations: number;
  warmup: number;
}) {
  const { label, hook, eventFactory, iterations, warmup } = params;
  const ctx = { sessionKey: "agent:main:main", agentId: "main" };

  for (let i = 0; i < warmup; i += 1) {
    await hook(eventFactory(i), ctx);
  }

  const samples: number[] = [];
  const totalStart = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    await hook(eventFactory(i), ctx);
    samples.push(performance.now() - started);
  }
  const totalMs = performance.now() - totalStart;
  const qps = (iterations / totalMs) * 1000;

  const result = {
    label,
    iterations,
    totalMs,
    avgMs: avg(samples),
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    qps,
  };
  // 基准输出用于人工比较
  console.log(
    `[security-bench] ${result.label} iterations=${result.iterations} totalMs=${result.totalMs.toFixed(2)} avgMs=${result.avgMs.toFixed(4)} p50Ms=${result.p50Ms.toFixed(4)} p95Ms=${result.p95Ms.toFixed(4)} p99Ms=${result.p99Ms.toFixed(4)} qps=${result.qps.toFixed(2)}`,
  );
  return result;
}

async function readHookLatency(
  gatewayMethods: Map<string, (options: any) => Promise<void> | void>,
): Promise<Record<string, unknown>> {
  const handler = gatewayMethods.get("security.monitor.status");
  if (!handler) {
    return {};
  }
  let payload: Record<string, unknown> | null = null;
  await handler({
    params: {},
    respond: (_ok: boolean, body: Record<string, unknown>) => {
      payload = body;
    },
  });
  if (!payload || typeof payload !== "object") {
    return {};
  }
  return payload;
}

const benchIt = process.env.SECURITY_BENCH === "1" ? it : it.skip;

describe("security-core before_tool_call 基准", () => {
  benchIt("输出真实 p50/p95/QPS", async () => {
    const iterations = 4000;
    const warmup = 500;

    const baseline = createFakeApi();
    const beforeToolCall = baseline.hooks.get("before_tool_call");
    expect(beforeToolCall).toBeTypeOf("function");

    const benign = await runScenario({
      label: "benign_allow",
      hook: beforeToolCall as (event: any, ctx: any) => Promise<any>,
      iterations,
      warmup,
      eventFactory: () => ({
        toolName: "system.run",
        params: { command: "echo hello world" },
      }),
    });

    const destructiveBlock = await runScenario({
      label: "destructive_block",
      hook: beforeToolCall as (event: any, ctx: any) => Promise<any>,
      iterations,
      warmup,
      eventFactory: () => ({
        toolName: "system.run",
        params: { command: "rm -rf /tmp/demo" },
      }),
    });

    const secretBlock = await runScenario({
      label: "secret_block",
      hook: beforeToolCall as (event: any, ctx: any) => Promise<any>,
      iterations,
      warmup,
      eventFactory: () => ({
        toolName: "http.request",
        params: { authorization: "Bearer sk-proj-1234567890abcdefghijklmn" },
      }),
    });

    const redactApi = createFakeApi({
      secrets: {
        severityActions: {
          critical: "redact",
          high: "redact",
          medium: "redact",
          low: "redact",
        },
      },
    });
    const redactHook = redactApi.hooks.get("before_tool_call");
    expect(redactHook).toBeTypeOf("function");
    const secretRedact = await runScenario({
      label: "secret_redact",
      hook: redactHook as (event: any, ctx: any) => Promise<any>,
      iterations,
      warmup,
      eventFactory: () => ({
        toolName: "http.request",
        params: { authorization: "Bearer sk-proj-1234567890abcdefghijklmn" },
      }),
    });

    const hookStatus = await readHookLatency(baseline.gatewayMethods);
    const beforeToolLatency = (
      (hookStatus.hookLatency as Record<string, any> | undefined)?.before_tool_call ?? {}
    ) as Record<string, unknown>;
    console.log(
      `[security-bench] hook_latency before_tool_call count=${String(beforeToolLatency.count ?? 0)} p50Ms=${String(beforeToolLatency.p50Ms ?? 0)} p95Ms=${String(beforeToolLatency.p95Ms ?? 0)} maxMs=${String(beforeToolLatency.maxMs ?? 0)}`,
    );

    expect(benign.avgMs).toBeGreaterThan(0);
    expect(destructiveBlock.avgMs).toBeGreaterThan(0);
    expect(secretBlock.avgMs).toBeGreaterThan(0);
    expect(secretRedact.avgMs).toBeGreaterThan(0);
  });
});
