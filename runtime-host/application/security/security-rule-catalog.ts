import type {
  SecurityRuleCatalogItem,
  SecurityRuleCatalogPlatform,
} from './security-policy-types';

const SECURITY_RULE_CATALOG: SecurityRuleCatalogItem[] = [
  {
    platform: 'universal',
    command: 'rm -rf <系统路径>',
    category: 'file_delete',
    severity: 'critical',
    reason: '递归强删目录树',
  },
  {
    platform: 'universal',
    command: 'git reset --hard',
    category: 'git_destructive',
    severity: 'critical',
    reason: '强制/递归删除文件',
  },
  {
    platform: 'linux',
    command: 'systemctl disable <关键服务 critical>',
    category: 'system_destructive',
    severity: 'critical',
    reason: '系统服务停用（关键服务为 critical）',
  },
  {
    platform: 'linux',
    command: 'service <service> stop',
    category: 'system_destructive',
    severity: 'high',
    reason: '服务停用/删除',
  },
  {
    platform: 'linux',
    command: 'ip route flush table main（flush 为 critical）',
    category: 'network_destructive',
    severity: 'critical',
    reason: '路由表变更（flush 为 critical）',
  },
  {
    platform: 'windows',
    command: 'rmdir /s /q C:\\temp\\demo',
    category: 'file_delete',
    severity: 'critical',
    reason: '递归删除目录树',
  },
  {
    platform: 'windows',
    command: 'del /f /s <系统路径>',
    category: 'file_delete',
    severity: 'high',
    reason: '强制/递归删除文件',
  },
  {
    platform: 'windows',
    command: 'taskkill /f /pid 1234',
    category: 'process_kill',
    severity: 'high',
    reason: '终止进程（/f 提升风险）',
  },
  {
    platform: 'windows',
    command: 'reg delete HKLM\\Software\\Demo /f',
    category: 'system_destructive',
    severity: 'critical',
    reason: '删除注册表键值',
  },
  {
    platform: 'windows',
    command: 'diskpart clean',
    category: 'system_destructive',
    severity: 'critical',
    reason: '磁盘分区破坏',
  },
  {
    platform: 'windows',
    command: 'netsh advfirewall reset',
    category: 'network_destructive',
    severity: 'critical',
    reason: '防火墙重置',
  },
  {
    platform: 'windows',
    command: 'route delete 0.0.0.0',
    category: 'network_destructive',
    severity: 'high',
    reason: '路由表变更',
  },
  {
    platform: 'powershell',
    command: 'Remove-Item C:\\temp\\x -Recurse -Force',
    category: 'file_delete',
    severity: 'critical',
    reason: '递归强删目录树',
  },
  {
    platform: 'powershell',
    command: 'Remove-NetFirewallRule -DisplayName DemoRule',
    category: 'network_destructive',
    severity: 'high',
    reason: '防火墙规则变更',
  },
  {
    platform: 'powershell',
    command: 'Stop-Process -Id 1234 -Force',
    category: 'process_kill',
    severity: 'high',
    reason: '强制终止进程',
  },
  {
    platform: 'powershell',
    command: 'Set-Acl -Path <系统路径> -AclObject <acl>',
    category: 'privilege_escalation',
    severity: 'high',
    reason: '递归 ACL 改动',
  },
  {
    platform: 'macos',
    command: 'diskutil eraseDisk APFS Demo /dev/disk3',
    category: 'system_destructive',
    severity: 'critical',
    reason: '磁盘抹除/重分区',
  },
  {
    platform: 'macos',
    command: 'launchctl bootout system/com.apple.sshd',
    category: 'system_destructive',
    severity: 'high',
    reason: '系统/用户服务停用',
  },
  {
    platform: 'macos',
    command: 'csrutil disable',
    category: 'privilege_escalation',
    severity: 'critical',
    reason: '关闭 SIP 保护',
  },
  {
    platform: 'macos',
    command: 'pfctl -e / pfctl -d',
    category: 'network_destructive',
    severity: 'high',
    reason: '启停 PF 规则',
  },
  {
    platform: 'macos',
    command: 'pfctl -f /etc/pf.conf',
    category: 'network_destructive',
    severity: 'critical',
    reason: '重载 PF 规则文件',
  },
  {
    platform: 'macos',
    command: 'route delete default',
    category: 'network_destructive',
    severity: 'high',
    reason: '路由表变更',
  },
];

function normalizeRuleCatalogPlatform(value: unknown): SecurityRuleCatalogPlatform | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === 'universal'
    || normalized === 'linux'
    || normalized === 'windows'
    || normalized === 'macos'
    || normalized === 'powershell'
  ) {
    return normalized;
  }
  return null;
}

export function listSecurityRuleCatalog(platform?: string | null) {
  const normalizedPlatform = normalizeRuleCatalogPlatform(platform);
  const items = normalizedPlatform
    ? SECURITY_RULE_CATALOG.filter((item) => item.platform === 'universal' || item.platform === normalizedPlatform)
    : SECURITY_RULE_CATALOG;

  return {
    success: true,
    total: items.length,
    items,
  };
}
