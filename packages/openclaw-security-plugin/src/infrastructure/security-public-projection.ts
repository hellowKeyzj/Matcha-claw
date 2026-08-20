import type {
  SecurityAuditItem,
  SecurityRisk,
  SecurityStartupAuditReport,
} from "../core/types.js";

const MAX_AUDIT_ITEMS = 200;
const MAX_INTEGRITY_ITEMS = 200;
const MAX_SKILLS = 32;
const MAX_SKILL_ISSUES = 16;
const MAX_ADVISORIES = 200;
const MAX_REMEDIATION_ACTIONS = 64;
const MAX_TEXT_LENGTH = 256;
const MAX_OPAQUE_LENGTH = 128;

const SAFE_TEXT = /^[A-Za-z0-9._-]+$/;
const SAFE_OPAQUE = /^[A-Za-z0-9._-]+$/;
const SAFE_STATUSES = new Set(["intact", "tampered", "missing", "no-baseline"]);
const SAFE_SEVERITIES = new Set(["critical", "high", "medium", "low", "info"]);

export type PublicAuditItem = {
  ts: number;
  toolName: string;
  risk: SecurityRisk;
  action: "audit" | "allow" | "block";
  decision: string;
  ruleId?: string;
};

export type PublicAuditResponse = {
  page: number;
  pageSize: number;
  total: number;
  items: PublicAuditItem[];
  backend: "security-core";
};

export type PublicStartupAudit = {
  ok: boolean;
  checks: number;
  issues: number;
};

export type PublicQuickAuditResponse = {
  startupAudit: PublicStartupAudit;
  integrity: PublicIntegrityResponse;
  skillScan: PublicSkillScanResponse;
  advisories: PublicAdvisoriesResponse;
  backend: "security-core";
};

export type PublicIntegrityResponse = {
  checked: number;
  tampered: number;
  missing: number;
  noBaseline: number;
  items: Array<{ file: string; status: "intact" | "tampered" | "missing" | "no-baseline" }>;
};

export type PublicSkillScanResponse = {
  total: number;
  suspicious: number;
  clean: number;
  skills: Array<{
    name: string;
    safe: boolean;
    issues: Array<{ id: string; severity: "critical" | "high" | "medium" }>;
  }>;
};

export type PublicAdvisoriesResponse = {
  reachable: boolean;
  advisories: Array<{ id: string; severity: string; title: string; action?: string }>;
  criticalOrHigh: Array<{ id: string; severity: string; title: string; action?: string }>;
};

export type PublicRemediationPreview = {
  actions: Array<{ id: string; title: string; risk: "critical" | "high" | "medium" | "low" }>;
};

export type PublicRemediationApply = {
  actions: string[];
  snapshotId: string;
  applied: boolean;
};

export type PublicRemediationRollback = {
  snapshotId: string;
  restored: number;
};

function safeText(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > maxLength
    || !SAFE_TEXT.test(normalized)
  ) {
    return "unknown";
  }
  return normalized;
}

function safeDisplayText(value: unknown, maxLength = MAX_TEXT_LENGTH): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > maxLength
    || [...normalized].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
    || /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(normalized)
  ) {
    return "unknown";
  }
  return normalized;
}

function safeOpaque(value: unknown): string {
  if (value == null) return "none";
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= MAX_OPAQUE_LENGTH && SAFE_OPAQUE.test(normalized)
    ? normalized
    : "unknown";
}

function boundedCount(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, maximum);
}

function projectPublicAuditItem(item: SecurityAuditItem): PublicAuditItem {
  const projected: PublicAuditItem = {
    ts: Number.isSafeInteger(item.ts) && item.ts > 0 ? item.ts : 1,
    toolName: safeText(item.toolName),
    risk: SAFE_SEVERITIES.has(item.risk) ? item.risk : "info",
    action: item.action === "allow" || item.action === "block" ? item.action : "audit",
    decision: safeText(item.decision),
  };
  if (item.ruleId !== undefined) {
    const ruleId = safeText(item.ruleId);
    if (ruleId !== "unknown") projected.ruleId = ruleId;
  }
  return projected;
}

export function projectPublicAudit(
  page: number,
  pageSize: number,
  records: SecurityAuditItem[],
): PublicAuditResponse {
  const boundedPage = Number.isSafeInteger(page) && page > 0 ? page : 1;
  const boundedPageSize = Math.min(200, Number.isSafeInteger(pageSize) && pageSize > 0 ? pageSize : 20);
  const ordered = [...records].sort((left, right) => right.ts - left.ts);
  const offset = (boundedPage - 1) * boundedPageSize;
  return {
    page: boundedPage,
    pageSize: boundedPageSize,
    total: Math.min(ordered.length, 5_000),
    items: ordered.slice(offset, offset + Math.min(boundedPageSize, MAX_AUDIT_ITEMS)).map(projectPublicAuditItem),
    backend: "security-core",
  };
}

export function projectPublicStartupAudit(report: SecurityStartupAuditReport): PublicStartupAudit {
  const checks = boundedCount(report.findings.length, 500);
  const issues = Math.min(checks, boundedCount(report.findings.filter((finding) => finding.severity !== "INFO").length, 500));
  return { ok: issues === 0, checks, issues };
}

export function projectPublicQuickAudit(result: {
  startupAudit: SecurityStartupAuditReport;
  integrity: Parameters<typeof projectPublicIntegrity>[0];
  skillScan: Parameters<typeof projectPublicSkillScan>[0];
  advisories: Parameters<typeof projectPublicAdvisories>[0];
}): PublicQuickAuditResponse {
  return {
    startupAudit: projectPublicStartupAudit(result.startupAudit),
    integrity: projectPublicIntegrity(result.integrity),
    skillScan: projectPublicSkillScan(result.skillScan),
    advisories: projectPublicAdvisories(result.advisories),
    backend: "security-core",
  };
}

export function projectPublicIntegrity(result: {
  checked: number;
  tampered: number;
  missing: number;
  noBaseline: number;
  items: Array<{ file: string; status: string }>;
}): PublicIntegrityResponse {
  return {
    checked: boundedCount(result.checked, MAX_INTEGRITY_ITEMS),
    tampered: boundedCount(result.tampered, MAX_INTEGRITY_ITEMS),
    missing: boundedCount(result.missing, MAX_INTEGRITY_ITEMS),
    noBaseline: boundedCount(result.noBaseline, MAX_INTEGRITY_ITEMS),
    items: result.items.slice(0, MAX_INTEGRITY_ITEMS).flatMap((item) => {
      const file = safeDisplayText(item.file);
      const status = item.status;
      return file !== "unknown" && SAFE_STATUSES.has(status)
        ? [{ file, status: status as PublicIntegrityResponse["items"][number]["status"] }]
        : [];
    }),
  };
}

export function projectPublicSkillScan(result: {
  total: number;
  suspicious: number;
  clean: number;
  skills: Array<{ name: string; safe: boolean; issues: Array<{ id: string; severity: string }> }>;
}): PublicSkillScanResponse {
  return {
    total: boundedCount(result.total, MAX_SKILLS),
    suspicious: boundedCount(result.suspicious, MAX_SKILLS),
    clean: boundedCount(result.clean, MAX_SKILLS),
    skills: result.skills.slice(0, MAX_SKILLS).flatMap((skill) => {
      const name = safeText(skill.name);
      if (name === "unknown") return [];
      return [{
        name,
        safe: skill.safe === true,
        issues: skill.issues.slice(0, MAX_SKILL_ISSUES).flatMap((issue) => {
          const id = safeText(issue.id);
          const severity = issue.severity.toLowerCase();
          return id !== "unknown" && (severity === "critical" || severity === "high" || severity === "medium")
            ? [{ id, severity }]
            : [];
        }),
      }];
    }),
  };
}

function projectAdvisory(item: { id: string; severity: string; title: string; action?: string }) {
  const id = safeText(item.id);
  const title = safeText(item.title);
  if (id === "unknown" || title === "unknown") return null;
  const projected: { id: string; severity: string; title: string; action?: string } = {
    id,
    severity: safeText(item.severity).toLowerCase(),
    title,
  };
  if (item.action !== undefined) {
    const action = safeText(item.action);
    if (action !== "unknown") projected.action = action;
  }
  return projected;
}

export function projectPublicAdvisories(result: {
  reachable: boolean;
  advisories: Array<{ id: string; severity: string; title: string; action?: string }>;
  criticalOrHigh: Array<{ id: string; severity: string; title: string; action?: string }>;
}): PublicAdvisoriesResponse {
  return {
    reachable: result.reachable === true,
    advisories: result.advisories.slice(0, MAX_ADVISORIES).flatMap((item) => {
      const projected = projectAdvisory(item);
      return projected ? [projected] : [];
    }),
    criticalOrHigh: result.criticalOrHigh.slice(0, MAX_ADVISORIES).flatMap((item) => {
      const projected = projectAdvisory(item);
      return projected ? [projected] : [];
    }),
  };
}

export function projectPublicRemediationPreview(result: {
  actions: Array<{ id: string; title: string; risk: "critical" | "high" | "medium" | "low" }>;
}): PublicRemediationPreview {
  return {
    actions: result.actions.slice(0, MAX_REMEDIATION_ACTIONS).flatMap((action) => {
      const id = safeText(action.id);
      const title = safeText(action.title);
      return id !== "unknown" && title !== "unknown" ? [{ id, title, risk: action.risk }] : [];
    }),
  };
}

export function projectPublicRemediationApply(result: {
  snapshotId: string;
  applied: string[];
}): PublicRemediationApply {
  return {
    actions: result.applied.slice(0, MAX_REMEDIATION_ACTIONS).flatMap((action) => {
      const id = safeText(action);
      return id === "unknown" ? [] : [id];
    }),
    snapshotId: safeOpaque(result.snapshotId),
    applied: result.applied.length > 0,
  };
}

export function projectPublicRemediationRollback(result: {
  restored: number;
  snapshotId: string | null;
}): PublicRemediationRollback {
  return {
    snapshotId: safeOpaque(result.snapshotId),
    restored: boundedCount(result.restored, MAX_REMEDIATION_ACTIONS),
  };
}
