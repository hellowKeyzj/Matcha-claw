import { randomUUID } from "node:crypto";
import { runSecureClawAudit } from "../vendor/secureclaw-runtime-bridge.js";
import type { SecurityAuditFinding, SecurityAuditSummary, SecurityCoreRuntimeConfig, SecurityStartupAuditReport } from "../core/types.js";

const DISABLED_FINDING_IDS = new Set(["SC-KILL-001"]);

function summarize(findings: SecurityAuditFinding[]): SecurityAuditSummary {
  const summary: SecurityAuditSummary = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  for (const finding of findings) {
    if (finding.severity === "CRITICAL") summary.critical += 1;
    if (finding.severity === "HIGH") summary.high += 1;
    if (finding.severity === "MEDIUM") summary.medium += 1;
    if (finding.severity === "LOW") summary.low += 1;
    if (finding.severity === "INFO") summary.info += 1;
  }
  return summary;
}

export async function runStartupAudit(params: {
  stateDir: string;
  runtimeConfig: SecurityCoreRuntimeConfig;
}): Promise<SecurityStartupAuditReport> {
  const upstream = await runSecureClawAudit(params.stateDir, params.runtimeConfig);
  const ts = Date.now();
  const findings: SecurityAuditFinding[] = upstream.findings
    .filter((finding) => !DISABLED_FINDING_IDS.has(finding.id))
    .map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      description: finding.description,
      evidence: finding.evidence,
      ts,
    }));

  if (!params.runtimeConfig.runtimeGuardEnabled) {
    findings.push({
      id: "SC-RUNTIME-GUARD-000",
      severity: "MEDIUM",
      title: "Runtime guard disabled",
      description: "before_tool_call runtime guard is disabled in security-core.",
      evidence: "runtimeGuardEnabled=false",
      ts,
    });
  }

  const summary = summarize(findings);
  return {
    id: randomUUID(),
    ts,
    version: upstream.secureclawVersion,
    score: upstream.score,
    findings,
    summary,
  };
}
