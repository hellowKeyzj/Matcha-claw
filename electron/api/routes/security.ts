import type { IncomingMessage, ServerResponse } from 'http';
import {
  readSecurityPolicyFromFile,
  writeSecurityPolicyToFile,
} from '../../utils/security-policy';
import { logger } from '../../utils/logger';
import type { HostApiContext } from '../context';
import { parseJsonBody, sendJson } from '../route-utils';

type RuleCatalogItem = {
  platform: 'universal' | 'linux' | 'windows' | 'macos' | 'powershell';
  command: string;
  category: 'file_delete' | 'git_destructive' | 'sql_destructive' | 'system_destructive' | 'process_kill' | 'network_destructive' | 'privilege_escalation';
  severity: string;
  reason: string;
};

const DESTRUCTIVE_RULE_CATALOG: RuleCatalogItem[] = [
  { platform: 'universal', command: 'rm -rf', category: 'file_delete', severity: 'critical', reason: '递归强删目录树' },
  { platform: 'universal', command: 'kill/pkill/killall', category: 'process_kill', severity: 'medium|high', reason: '终止进程（-9 提升风险）' },
  { platform: 'universal', command: 'shutdown/reboot/halt/poweroff/init', category: 'system_destructive', severity: 'critical', reason: '系统关机/重启' },
  { platform: 'universal', command: 'format/fdisk/mkfs/dd/parted/gdisk', category: 'system_destructive', severity: 'critical', reason: '磁盘/分区破坏' },
  { platform: 'universal', command: 'ip route * / route *', category: 'network_destructive', severity: 'high|critical', reason: '路由表变更（flush 为 critical）' },
  { platform: 'universal', command: 'sudo/doas/pkexec/su', category: 'privilege_escalation', severity: 'high', reason: '提权执行命令' },
  { platform: 'linux', command: 'iptables/firewall-cmd/ufw/nft', category: 'network_destructive', severity: 'high', reason: '防火墙策略改动' },
  { platform: 'linux', command: 'chmod/chown/chgrp -R (系统路径)', category: 'system_destructive', severity: 'critical', reason: '递归权限改动可能破坏系统' },
  { platform: 'linux', command: 'systemctl stop/disable/mask/...', category: 'system_destructive', severity: 'high|critical', reason: '系统服务停用（关键服务为 critical）' },
  { platform: 'linux', command: 'service <name> stop/disable', category: 'system_destructive', severity: 'high|critical', reason: '服务停用（关键服务为 critical）' },
  { platform: 'windows', command: 'rmdir/rd /s', category: 'file_delete', severity: 'critical', reason: '递归删除目录树' },
  { platform: 'windows', command: 'del/erase /f /s /q /p', category: 'file_delete', severity: 'high', reason: '强制/递归删除文件' },
  { platform: 'windows', command: 'taskkill [/f]', category: 'process_kill', severity: 'medium|high', reason: '终止进程（/f 提升风险）' },
  { platform: 'windows', command: 'reg delete /f', category: 'system_destructive', severity: 'critical', reason: '删除注册表键值' },
  { platform: 'windows', command: 'diskpart', category: 'system_destructive', severity: 'critical', reason: '磁盘分区破坏' },
  { platform: 'windows', command: 'netsh advfirewall add/set/delete/import/export', category: 'network_destructive', severity: 'high', reason: '防火墙策略改动' },
  { platform: 'windows', command: 'netsh advfirewall reset', category: 'network_destructive', severity: 'critical', reason: '防火墙重置' },
  { platform: 'windows', command: 'route delete/change', category: 'network_destructive', severity: 'high', reason: '路由表变更' },
  { platform: 'windows', command: 'icacls /t (系统路径)', category: 'system_destructive', severity: 'critical', reason: '递归 ACL 改动' },
  { platform: 'windows', command: 'takeown /r (系统路径)', category: 'privilege_escalation', severity: 'critical', reason: '接管系统文件所有权' },
  { platform: 'windows', command: 'sc stop/delete/config start=disabled', category: 'system_destructive', severity: 'high|critical', reason: '服务停用/删除' },
  { platform: 'macos', command: 'diskutil erase/partition', category: 'system_destructive', severity: 'critical', reason: '磁盘抹除/重分区' },
  { platform: 'macos', command: 'launchctl bootout/unload/disable/remove/kill', category: 'system_destructive', severity: 'high', reason: '系统/用户服务停用' },
  { platform: 'macos', command: 'csrutil disable', category: 'privilege_escalation', severity: 'critical', reason: '关闭 SIP 保护' },
  { platform: 'macos', command: 'pfctl -e/-d', category: 'network_destructive', severity: 'high', reason: '启停 PF 规则' },
  { platform: 'macos', command: 'pfctl -f', category: 'network_destructive', severity: 'critical', reason: '重载 PF 规则文件' },
  { platform: 'macos', command: 'route delete/change', category: 'network_destructive', severity: 'high', reason: '路由表变更' },
  { platform: 'powershell', command: 'Remove-Item -Recurse -Force', category: 'file_delete', severity: 'critical', reason: '递归强删目录树' },
  { platform: 'powershell', command: 'Stop-Process -Force', category: 'process_kill', severity: 'high', reason: '强制终止进程' },
  { platform: 'powershell', command: 'New/Set/Remove-NetFirewallRule', category: 'network_destructive', severity: 'high', reason: '防火墙规则变更' },
  { platform: 'powershell', command: 'netsh advfirewall *', category: 'network_destructive', severity: 'high', reason: '防火墙策略变更' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function createEmergencyLockdownPayload(current: Record<string, unknown>): Record<string, unknown> {
  const runtime = isRecord(current.runtime) ? current.runtime : {};
  const monitors = isRecord(runtime.monitors) ? runtime.monitors : {};
  const logging = isRecord(runtime.logging) ? runtime.logging : {};
  const allowlist = isRecord(runtime.allowlist) ? runtime.allowlist : {};
  const destructive = isRecord(runtime.destructive) ? runtime.destructive : {};
  const secrets = isRecord(runtime.secrets) ? runtime.secrets : {};
  const nextVersionRaw = Number(current.securityPolicyVersion);
  const nextVersion = Number.isFinite(nextVersionRaw) && nextVersionRaw > 0
    ? Math.floor(nextVersionRaw) + 1
    : 2;
  return {
    ...current,
    preset: 'strict',
    securityPolicyVersion: nextVersion,
    runtime: {
      ...runtime,
      enabled: true,
      runtimeGuardEnabled: true,
      auditOnGatewayStart: true,
      enablePromptInjectionGuard: true,
      blockDestructive: true,
      blockSecrets: true,
      monitors: {
        ...monitors,
        credentials: true,
        memory: true,
        cost: true,
      },
      logging: {
        ...logging,
        logDetections: true,
      },
      allowDomains: [],
      allowlist: {
        ...allowlist,
        tools: [],
        sessions: [],
      },
      destructive: {
        ...destructive,
        action: 'block',
        severityActions: {
          critical: 'block',
          high: 'block',
          medium: 'block',
          low: 'block',
        },
        categories: {
          fileDelete: true,
          gitDestructive: true,
          sqlDestructive: true,
          systemDestructive: true,
          processKill: true,
          networkDestructive: true,
          privilegeEscalation: true,
        },
      },
      secrets: {
        ...secrets,
        action: 'block',
        severityActions: {
          critical: 'block',
          high: 'block',
          medium: 'block',
          low: 'block',
        },
      },
    },
  };
}

function buildAuditQueryParams(url: URL): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (!value) continue;
    output[key] = value;
  }
  return output;
}

async function proxySecurityRpc(
  ctx: HostApiContext,
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15000,
): Promise<unknown> {
  return ctx.gatewayManager.rpc(method, params, timeoutMs);
}

export async function handleSecurityRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: HostApiContext,
): Promise<boolean> {
  if (url.pathname === '/api/security' && req.method === 'GET') {
    sendJson(res, 200, readSecurityPolicyFromFile());
    return true;
  }

  if (url.pathname === '/api/security' && req.method === 'PUT') {
    try {
      const payload = await parseJsonBody<Record<string, unknown>>(req);
      const normalized = writeSecurityPolicyToFile(payload);
      if (ctx.gatewayManager.getStatus().state === 'running') {
        await ctx.gatewayManager.rpc(
          'security.policy.sync',
          normalized,
          8000,
        );
      }
      sendJson(res, 200, { success: true, policy: normalized });
    } catch (error) {
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/destructive-rule-catalog' && req.method === 'GET') {
    const platform = (url.searchParams.get('platform') ?? '').toLowerCase();
    const supportedPlatforms = new Set(['universal', 'linux', 'windows', 'macos', 'powershell']);
    const items = supportedPlatforms.has(platform)
      ? DESTRUCTIVE_RULE_CATALOG.filter((item) => item.platform === platform || item.platform === 'universal')
      : DESTRUCTIVE_RULE_CATALOG;
    sendJson(res, 200, { success: true, items, total: items.length });
    return true;
  }

  if (url.pathname === '/api/security/audit' && req.method === 'GET') {
    try {
      const queryParams = buildAuditQueryParams(url);
      const result = await ctx.gatewayManager.rpc(
        'security.audit.query',
        queryParams,
        8000,
      );
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn(`Failed to query security audits: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/quick-audit' && req.method === 'POST') {
    try {
      const result = await proxySecurityRpc(ctx, 'security.quick_audit.run', {}, 45000);
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn(`Failed to run quick audit: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/emergency-response' && req.method === 'POST') {
    try {
      const current = readSecurityPolicyFromFile() as unknown as Record<string, unknown>;
      const emergencyPayload = createEmergencyLockdownPayload(current);
      const normalizedPolicy = writeSecurityPolicyToFile(emergencyPayload);
      const gatewayRunning = ctx.gatewayManager.getStatus().state === 'running';
      if (gatewayRunning) {
        await ctx.gatewayManager.rpc('security.policy.sync', normalizedPolicy, 8000);
      }

      let emergencyResult: unknown = null;
      let emergencyError: string | null = null;
      if (gatewayRunning) {
        try {
          emergencyResult = await proxySecurityRpc(ctx, 'security.emergency.run', {}, 45000);
        } catch (error) {
          emergencyError = String(error);
          logger.warn(`Emergency runtime action failed after lockdown applied: ${emergencyError}`);
        }
      }

      sendJson(res, 200, {
        success: true,
        lockdownApplied: true,
        policy: normalizedPolicy,
        emergency: emergencyResult,
        emergencyError,
      });
    } catch (error) {
      logger.warn(`Failed to run emergency response: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/integrity' && req.method === 'GET') {
    try {
      const result = await proxySecurityRpc(ctx, 'security.integrity.check');
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn(`Failed to check integrity: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/integrity/rebaseline' && req.method === 'POST') {
    try {
      const result = await proxySecurityRpc(ctx, 'security.integrity.rebaseline');
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn(`Failed to rebuild integrity baseline: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/skills/scan' && req.method === 'POST') {
    try {
      const payload = await parseJsonBody<Record<string, unknown>>(req);
      const scanPath = typeof payload.scanPath === 'string' ? payload.scanPath : undefined;
      const result = await proxySecurityRpc(ctx, 'security.skills.scan', scanPath ? { scanPath } : {});
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn(`Failed to scan skills: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/advisories' && req.method === 'GET') {
    try {
      const feedUrl = url.searchParams.get('feedUrl');
      const result = await proxySecurityRpc(
        ctx,
        'security.advisories.check',
        feedUrl ? { feedUrl } : {},
      );
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn(`Failed to check advisories: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/remediation/preview' && req.method === 'GET') {
    try {
      const result = await proxySecurityRpc(ctx, 'security.remediation.preview');
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn(`Failed to preview remediation: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/remediation/apply' && req.method === 'POST') {
    try {
      const payload = await parseJsonBody<Record<string, unknown>>(req);
      const actions = Array.isArray(payload.actions)
        ? payload.actions.filter((item): item is string => typeof item === 'string')
        : [];
      const result = await proxySecurityRpc(
        ctx,
        'security.remediation.apply',
        actions.length > 0 ? { actions } : {},
        20000,
      );
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn(`Failed to apply remediation: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  if (url.pathname === '/api/security/remediation/rollback' && req.method === 'POST') {
    try {
      const payload = await parseJsonBody<Record<string, unknown>>(req);
      const snapshotId = typeof payload.snapshotId === 'string' ? payload.snapshotId : undefined;
      const result = await proxySecurityRpc(
        ctx,
        'security.remediation.rollback',
        snapshotId ? { snapshotId } : {},
      );
      sendJson(res, 200, result);
    } catch (error) {
      logger.warn(`Failed to rollback remediation: ${String(error)}`);
      sendJson(res, 500, { success: false, error: String(error) });
    }
    return true;
  }

  return false;
}
