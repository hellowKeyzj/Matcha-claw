import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  detectDestructive,
  type DestructiveCategory,
  type DestructiveMatch,
  type DestructiveSeverity,
} from "../../packages/openclaw-security-plugin/src/vendor/clawguardian-destructive/detector";

type ExternalRule = {
  name: string;
  commands: string[];
  target: "args" | "full";
  require: string[];
  result: {
    category: DestructiveCategory;
    severity: DestructiveSeverity;
    reason: string;
    pattern: string;
  };
};

type ExternalRuleBundle = {
  version: number;
  rules: ExternalRule[];
};

type CompiledExternalRule = {
  target: "args" | "full";
  matchers: RegExp[];
  result: DestructiveMatch;
};

type DetectorFn = (toolName: string, params: Record<string, unknown>) => DestructiveMatch | undefined;

const benchIt = process.env.DESTRUCTIVE_AB_BENCH === "1" ? it : it.skip;

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

function readExternalRuleBundle(): ExternalRuleBundle {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const fixturePath = path.join(currentDir, "fixtures", "destructive-rules.external.json");
  const raw = fs.readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as ExternalRuleBundle;
  if (!Array.isArray(parsed.rules)) {
    throw new Error("Invalid external rule bundle: rules must be an array");
  }
  return parsed;
}

function compileExternalDetector(bundle: ExternalRuleBundle): DetectorFn {
  const buckets = new Map<string, CompiledExternalRule[]>();

  for (const rule of bundle.rules) {
    const compiledRule: CompiledExternalRule = {
      target: rule.target,
      matchers: rule.require.map((pattern) => new RegExp(pattern, "i")),
      result: {
        category: rule.result.category,
        severity: rule.result.severity,
        reason: rule.result.reason,
        pattern: rule.result.pattern,
      },
    };
    for (const cmd of rule.commands) {
      const normalizedCmd = cmd.toLowerCase();
      const list = buckets.get(normalizedCmd) ?? [];
      list.push(compiledRule);
      buckets.set(normalizedCmd, list);
    }
  }

  return (_toolName: string, params: Record<string, unknown>): DestructiveMatch | undefined => {
    if (typeof params.command !== "string") {
      return undefined;
    }
    const fullCommand = params.command;
    const parts = fullCommand.split(/\s+/);
    const command = (parts[0] ?? "").split("/").pop()?.toLowerCase() ?? "";
    if (!command) {
      return undefined;
    }
    const argsText = parts.slice(1).join(" ");
    const rules = buckets.get(command);
    if (!rules || rules.length === 0) {
      return undefined;
    }
    for (const rule of rules) {
      const targetText = rule.target === "full" ? fullCommand : argsText;
      if (rule.matchers.every((re) => re.test(targetText))) {
        return rule.result;
      }
    }
    return undefined;
  };
}

async function runScenario(params: {
  label: string;
  detector: DetectorFn;
  cases: Array<{ toolName: string; payload: Record<string, unknown> }>;
  iterations: number;
  warmup: number;
}) {
  const { label, detector, cases, iterations, warmup } = params;

  for (let i = 0; i < warmup; i += 1) {
    const item = cases[i % cases.length];
    detector(item.toolName, item.payload);
  }

  const samples: number[] = [];
  const totalStart = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    const item = cases[i % cases.length];
    const started = performance.now();
    detector(item.toolName, item.payload);
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

  console.log(
    `[destructive-ab] ${label} iterations=${result.iterations} totalMs=${result.totalMs.toFixed(2)} avgMs=${result.avgMs.toFixed(4)} p50Ms=${result.p50Ms.toFixed(4)} p95Ms=${result.p95Ms.toFixed(4)} p99Ms=${result.p99Ms.toFixed(4)} qps=${result.qps.toFixed(2)}`,
  );
  return result;
}

describe("destructive detector A/B 基准（写死 vs 外置缓存）", () => {
  benchIt("输出 A/B 实测数据", async () => {
    const externalDetector = compileExternalDetector(readExternalRuleBundle());
    const hardcodedDetector: DetectorFn = (toolName, payload) => detectDestructive(toolName, payload);

    const testCases = [
      { toolName: "system.run", payload: { command: "rm -rf /tmp/demo" } },
      { toolName: "system.run", payload: { command: "git reset --hard HEAD~1" } },
      { toolName: "system.run", payload: { command: "taskkill /f /pid 1234" } },
      { toolName: "system.run", payload: { command: "netsh advfirewall reset" } },
      { toolName: "system.run", payload: { command: "pfctl -f /etc/pf.conf" } },
      { toolName: "system.run", payload: { command: "systemctl disable sshd" } },
      { toolName: "system.run", payload: { command: "route delete default" } },
      { toolName: "system.run", payload: { command: "dir C:\\Users\\Public" } },
    ];

    // 先校验两套检测器在基准样本上的判定一致性
    for (const item of testCases) {
      const a = hardcodedDetector(item.toolName, item.payload);
      const b = externalDetector(item.toolName, item.payload);
      expect(a?.category).toBe(b?.category);
      expect(a?.severity).toBe(b?.severity);
    }

    const iterations = 30000;
    const warmup = 3000;

    const hardcoded = await runScenario({
      label: "hardcoded_detector",
      detector: hardcodedDetector,
      cases: testCases,
      iterations,
      warmup,
    });

    const externalCached = await runScenario({
      label: "external_cached_detector",
      detector: externalDetector,
      cases: testCases,
      iterations,
      warmup,
    });

    const deltaPct = ((externalCached.avgMs - hardcoded.avgMs) / hardcoded.avgMs) * 100;
    console.log(
      `[destructive-ab] delta_avg_pct=${deltaPct.toFixed(2)} hardcoded_avg=${hardcoded.avgMs.toFixed(4)} external_cached_avg=${externalCached.avgMs.toFixed(4)}`,
    );

    expect(hardcoded.avgMs).toBeGreaterThan(0);
    expect(externalCached.avgMs).toBeGreaterThan(0);
  });
});
