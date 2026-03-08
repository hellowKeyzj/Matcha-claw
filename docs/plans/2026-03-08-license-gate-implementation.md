# License Gate & Auto-Renew Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在不破坏现有 `/v1/activate` 协议的前提下，实现“无授权仅可停留设置页 + 缓存过期自动续校 + 本地 AES 密文存储 + 同硬件换绑”的完整闭环。

**Architecture:** 授权门禁状态统一收敛到主进程（单一事实源），渲染层只做路由守卫与 UI 展示。License Key 采用本地 AES-256-GCM 密文文件存储（`<userData>/license-secret.enc.json`），启动与定时任务自动续校。服务端 `license_server.py` 兼容扩展 `hardwareId/installId`，支持同硬件替换旧安装绑定并保留旧 `deviceId` 路径。

**Tech Stack:** Electron main/preload/renderer、TypeScript + Zustand + React Router、Vitest、Python 3（单文件授权服务）。

---

### Task 1: 门禁决策纯函数与测试

**Files:**
- Create: `electron/utils/license-gate-policy.ts`
- Create: `tests/unit/license-gate-policy.test.ts`
- Test: `tests/unit/license-gate-policy.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { decideGateState } from '../../electron/utils/license-gate-policy';

describe('decideGateState', () => {
  it('returns blocked when no valid evidence exists', () => {
    expect(decideGateState({ setupComplete: true, hasValidCache: false, hasDecryptableKey: false }))
      .toBe('blocked');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/unit/license-gate-policy.test.ts -r`
Expected: FAIL with module/function not found.

**Step 3: Write minimal implementation**

```ts
export type GateState = 'checking' | 'granted' | 'blocked';

export function decideGateState(input: {
  setupComplete: boolean;
  hasValidCache: boolean;
  hasDecryptableKey: boolean;
}): GateState {
  if (input.hasValidCache || input.hasDecryptableKey) return 'granted';
  return input.setupComplete ? 'blocked' : 'checking';
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/unit/license-gate-policy.test.ts -r`
Expected: PASS.

**Step 5: Commit**

```bash
git add electron/utils/license-gate-policy.ts tests/unit/license-gate-policy.test.ts
git commit -m "test: add license gate policy unit baseline"
```

### Task 2: 本地 AES 密文存储模块

**Files:**
- Create: `electron/utils/license-secret.ts`
- Create: `tests/unit/license-secret.test.ts`
- Modify: `electron/utils/license.ts`

**Step 1: Write the failing test**

```ts
it('round-trip encrypt/decrypt license key', async () => {
  const key = 'MATCHACLAW-ABCD-EFGH-IJKL-MNPQ';
  const secret = await encryptLicenseKeyForFile(key, 'device-material');
  const plain = await decryptLicenseKeyFromFile(secret, 'device-material');
  expect(plain).toBe(key);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/unit/license-secret.test.ts -r`
Expected: FAIL with missing exports.

**Step 3: Write minimal implementation**

```ts
// AES-256-GCM + HKDF-SHA256
export async function encryptLicenseKeyForFile(plain: string, material: string): Promise<LicenseSecretFileV1> { /* ... */ }
export async function decryptLicenseKeyFromFile(file: LicenseSecretFileV1, material: string): Promise<string> { /* ... */ }
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/unit/license-secret.test.ts -r`
Expected: PASS.

**Step 5: Commit**

```bash
git add electron/utils/license-secret.ts electron/utils/license.ts tests/unit/license-secret.test.ts
git commit -m "feat: add local AES license secret storage helpers"
```

### Task 3: 硬件指纹采集模块（客户端）

**Files:**
- Create: `electron/utils/hardware-id.ts`
- Create: `tests/unit/hardware-id.test.ts`
- Modify: `electron/utils/license.ts`

**Step 1: Write the failing test**

```ts
it('hashes raw machine id into stable hardwareId', () => {
  expect(normalizeAndHashHardwareId('ABC-123')).toMatch(/^[a-f0-9]{64}$/);
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/unit/hardware-id.test.ts -r`
Expected: FAIL with missing file/function.

**Step 3: Write minimal implementation**

```ts
export function normalizeAndHashHardwareId(raw: string): string {
  return createHash('sha256').update(`matchaclaw-hwid-v1:${raw.trim().toLowerCase()}`).digest('hex');
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/unit/hardware-id.test.ts -r`
Expected: PASS.

**Step 5: Commit**

```bash
git add electron/utils/hardware-id.ts tests/unit/hardware-id.test.ts electron/utils/license.ts
git commit -m "feat: add stable hardware id hashing"
```

### Task 4: 主进程授权门禁服务

**Files:**
- Create: `electron/main/license-gate.ts`
- Modify: `electron/main/index.ts`
- Modify: `electron/main/ipc-handlers.ts`
- Create: `tests/unit/license-gate-runtime.test.ts`

**Step 1: Write the failing test**

```ts
it('emits blocked when cache expired and renew failed', async () => {
  const service = createLicenseGateService(/* mocked deps */);
  await service.bootstrap();
  expect(service.getState()).toBe('blocked');
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/unit/license-gate-runtime.test.ts -r`
Expected: FAIL with missing service.

**Step 3: Write minimal implementation**

```ts
export class LicenseGateService {
  getState(): GateState { /* ... */ }
  async bootstrap(): Promise<void> { /* read cache+secret then renew */ }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/unit/license-gate-runtime.test.ts -r`
Expected: PASS.

**Step 5: Commit**

```bash
git add electron/main/license-gate.ts electron/main/index.ts electron/main/ipc-handlers.ts tests/unit/license-gate-runtime.test.ts
git commit -m "feat: add main-process license gate service"
```

### Task 5: Preload 与类型声明扩展

**Files:**
- Modify: `electron/preload/index.ts`
- Modify: `src/types/electron.d.ts`

**Step 1: Write the failing test**

```ts
// 在现有 IPC typing test 中增加：
// window.electron.ipcRenderer.invoke('license:getGateState')
```

**Step 2: Run test to verify it fails**

Run: `pnpm run typecheck`
Expected: FAIL with missing channel typing/white-list error。

**Step 3: Write minimal implementation**

```ts
// preload allowlist 增加：
'license:getGateState', 'license:storeKey', 'license:clearStoredKey', 'license:forceRevalidate'
```

**Step 4: Run test to verify it passes**

Run: `pnpm run typecheck`
Expected: PASS.

**Step 5: Commit**

```bash
git add electron/preload/index.ts src/types/electron.d.ts
git commit -m "chore: expose license gate ipc channels to renderer"
```

### Task 6: App 路由门禁（仅限制离开设置页）

**Files:**
- Modify: `src/App.tsx`
- Create: `tests/unit/license-route-guard.test.tsx`

**Step 1: Write the failing test**

```tsx
it('redirects non-settings routes to /settings?section=license when blocked', async () => {
  // render router at /chat, mock gateState=blocked
  // expect location pathname '/settings' and query section=license
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/unit/license-route-guard.test.tsx -r`
Expected: FAIL (no guard behavior).

**Step 3: Write minimal implementation**

```tsx
if (licenseGateState === 'blocked' && !location.pathname.startsWith('/settings')) {
  navigate('/settings?section=license');
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/unit/license-route-guard.test.tsx -r`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/App.tsx tests/unit/license-route-guard.test.tsx
git commit -m "feat: enforce settings-only navigation when license blocked"
```

### Task 7: 设置页新增 License 区块（含二次确认清除）

**Files:**
- Modify: `src/lib/settings/sections.ts`
- Modify: `src/pages/Settings/index.tsx`
- Modify: `src/i18n/locales/zh/settings.json`
- Modify: `src/i18n/locales/en/settings.json`
- Modify: `src/i18n/locales/ja/settings.json`
- Create: `tests/unit/settings-license-section.test.tsx`

**Step 1: Write the failing test**

```tsx
it('shows license section with validate, revalidate, clear actions', () => {
  // render Settings with section=license
  // expect input + buttons + confirm dialog before clear
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/unit/settings-license-section.test.tsx -r`
Expected: FAIL with missing section/content.

**Step 3: Write minimal implementation**

```tsx
{ key: 'license', label: t('license.title') }
// section card: input / validate / revalidate / clear(with confirm)
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/unit/settings-license-section.test.tsx -r`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/lib/settings/sections.ts src/pages/Settings/index.tsx src/i18n/locales/zh/settings.json src/i18n/locales/en/settings.json src/i18n/locales/ja/settings.json tests/unit/settings-license-section.test.tsx
git commit -m "feat: add license section to settings with confirmable clear action"
```

### Task 8: License 客户端请求扩展与自动续校调度

**Files:**
- Modify: `electron/utils/license.ts`
- Modify: `electron/utils/license-config.ts`
- Create: `tests/unit/license-auto-renew.test.ts`

**Step 1: Write the failing test**

```ts
it('schedules next renew from refreshAfterSec and revalidates automatically', async () => {
  // mock server response refreshAfterSec=60
  // expect scheduler armed and validate called again on tick
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest tests/unit/license-auto-renew.test.ts -r`
Expected: FAIL with missing scheduler logic.

**Step 3: Write minimal implementation**

```ts
export function scheduleAutoRevalidate(/* ... */): () => void { /* setTimeout + invoke validate */ }
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest tests/unit/license-auto-renew.test.ts -r`
Expected: PASS.

**Step 5: Commit**

```bash
git add electron/utils/license.ts electron/utils/license-config.ts tests/unit/license-auto-renew.test.ts
git commit -m "feat: add automatic online license revalidation scheduler"
```

### Task 9: 服务端兼容扩展（hardwareId/installId + 同硬件换绑）

**Files:**
- Modify: `scripts/license_server.py`
- Create: `tests/license_server/test_hardware_rebind.py` (若仓库无 python 测试框架则改为命令脚本验证文档)
- Modify: `doc/license-release.md`

**Step 1: Write the failing test / case**

```py
def test_same_hardware_can_replace_install_id():
    # first activate with hw=A, install=I1
    # second activate with hw=A, install=I2
    # expect valid and no device_limit
```

**Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/license_server/test_hardware_rebind.py -q`
Expected: FAIL (no new fields logic).

**Step 3: Write minimal implementation**

```py
# 请求读取 hardwareId/installId (optional)
# 同 hardwareId 命中时更新 installId
# 旧 deviceId 逻辑保留兼容
```

**Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/license_server/test_hardware_rebind.py -q`
Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/license_server.py tests/license_server/test_hardware_rebind.py doc/license-release.md
git commit -m "feat: support same-hardware install rebind while keeping legacy device flow"
```

### Task 10: 人工解绑命令（按 key 清空绑定）

**Files:**
- Modify: `scripts/license_server.py`
- Modify: `doc/license-server-README.md`

**Step 1: Write the failing test / case**

```py
def test_manual_unbind_by_key_clears_bindings():
    # add key with bound devices/bindings
    # run unbind command
    # expect devices/bindings empty
```

**Step 2: Run test to verify it fails**

Run: `python3 -m pytest tests/license_server/test_manual_unbind.py -q`
Expected: FAIL (command missing).

**Step 3: Write minimal implementation**

```py
# 新增子命令:
# license_server.py unbind --db ... --key MATCHACLAW-...
# 行为: 清空 devices/bindings 并写 audit code=manual_unbind
```

**Step 4: Run test to verify it passes**

Run: `python3 -m pytest tests/license_server/test_manual_unbind.py -q`
Expected: PASS.

**Step 5: Commit**

```bash
git add scripts/license_server.py doc/license-server-README.md tests/license_server/test_manual_unbind.py
git commit -m "feat: add manual unbind command by license key"
```

### Task 11: 全量验证与交付说明

**Files:**
- Modify: `doc/license-server-README.md`
- Modify: `doc/license-release.md`

**Step 1: Run frontend/unit verification**

Run: `pnpm run typecheck && pnpm test`
Expected: 全部 PASS。

**Step 2: Run server smoke verification**

Run:

```bash
python3 scripts/license_server.py serve --host 127.0.0.1 --port 3187 --db ./tmp-license-db.json --audit ./tmp-audit.jsonl
curl -i http://127.0.0.1:3187/health
```

Expected: `200 {"ok": true}`。

**Step 3: Document release checklist**

```md
- 升级前无 license 用户验证
- 已授权用户升级验证
- 同硬件重装换绑验证
- 人工解绑验证
```

**Step 4: Commit**

```bash
git add doc/license-server-README.md doc/license-release.md
git commit -m "docs: finalize license gate rollout and verification checklist"
```

---

## 风险与回滚要点

1. 若路由门禁异常导致误锁，临时禁用 `blocked -> /settings` 重定向开关。
2. 若密文解密失败率异常，回滚到“仅依赖旧缓存+手动输入”模式。
3. 服务端保留旧 `deviceId` 路径，确保老客户端可继续激活。
