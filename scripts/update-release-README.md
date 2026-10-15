# 发布与更新源运维（MatchaClaw）

> 2026-10-16：客户端、打包配置及发布接线已按源码核对。未生产发布、未真实安装，macOS 原生更新待验；源码接线与隔离传输验证不代表发布验收完成。

## 1. 范围与目录

沿用 Electron Main `AppUpdater` + `electron-updater` generic，唯一新更新源：

```text
https://www.senluopan.com/dav/
├─ MatchaClaw-<version>-win-x64.exe
├─ MatchaClaw-<version>-win-arm64.exe
├─ MatchaClaw-<version>-mac-arm64.dmg
├─ MatchaClaw-<version>-mac-arm64.zip
└─ <channel>.yml / <channel>-mac.yml
```

该 WebDAV 账号根已是 `claw-update`，URL 后不得再加 `claw-update/`。稳定通道为 `latest`，预发布按版本中的 `alpha`／`beta` 识别；以 builder 生成的 channel 文件为准，不手改文件名、包地址或哈希。

- Windows 发布 x64/arm64 NSIS；macOS 发布 arm64 DMG/ZIP，ZIP 用于自动更新，不可只传 DMG。
- Linux 与 macOS x64 安装包暂停发布，不代表删除这些平台的 runtime 支持；保留历史安装包。
- Main `disableDifferentialDownload = true`、builder `nsis.differentialPackage: false` 与 `useMultipleRangeRequest: false`，下载完整包；UI、IPC、状态及用户点击下载／安装不变。
- GitHub Release 仅作手动下载镜像，不是新客户端 fallback；不涉及 runtime-host／组件升级、自定义 Provider 或客户端 JWT。

本地 `pnpm run package:win`／`package:win:x64`／`package:mac` 只打包（`--publish never`），不走发布；Linux 与 Intel Mac 不作为当前发布命令。不要用本地 package 代替 CI 的发布器。[VERIFY: electron-builder.yml:56-79] [VERIFY: electron-builder.yml:125-137] [VERIFY: package.json:92-98]

## 2. 凭据与 Secrets

| 用途 | 配置 | 权限与边界 |
| --- | --- | --- |
| 客户端读取 | Main 内置只读账号，不打印值 | 更新根只读，禁止上传／覆盖／删除；app ready 后仅在 updater 专用 `netSession` 为新源 HTTPS origin 的 `/dav/` 请求注入认证，不进 Renderer 或默认 session |
| CI 发布 | `UPDATE_WEBDAV_USERNAME`、`UPDATE_WEBDAV_PASSWORD` | GitHub Actions Secrets 中配置独立发布账号，仅授权更新根读取／PUT；不要使用只读账号或无关目录的管理权限，不授予删除历史包权限 |
| macOS 签名／公证 | `MAC_CERTS`、`MAC_CERTS_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID` | 沿用现有 macOS 构建所需 Secrets，与 WebDAV 发布账号分离 |

在仓库 GitHub Actions Secrets 配置两项 `UPDATE_WEBDAV_*`，二者缺一即发布失败，不降级为只发 GitHub。它们只注入 CI 发布步骤，不放入客户端、builder publish 配置、产物或日志。不把密码、认证头、编码认证串放入文档或命令示例；排障日志也须脱敏。Main 单例构造不访问 Electron session，hook 由 app ready 后的原注册入口安装。[VERIFY: electron/main/updater.ts:52-79] [VERIFY: electron/main/updater.ts:290-306] [VERIFY: electron/main/index.ts:203-217] [VERIFY: electron/main/app-bootstrap.ts:183-196] [VERIFY: .github/workflows/release.yml:763-767] [VERIFY: scripts/publish-update-webdav.mjs:130-135]

## 3. 发布顺序

```text
v* tag
  → 构建 Windows x64/arm64 + macOS arm64 → 聚合 deploy-bundle
  → 校验本地包 SHA-512 / size
  → PUT 全部安装包 → 逐包 GET 读回核对
  → PUT channel 清单（最后）
  → 可选旧源迁移同步（先包后清单）→ GitHub Release 手动镜像

workflow_dispatch → 仅构建 artifacts，不发布
```

1. 配齐发布 Secrets，确认版本号与 `vX.Y.Z`、`vX.Y.Z-alpha.N` 或 `vX.Y.Z-beta.N` tag 一致；确认本次包及清单来自同一次构建，不混入旧 artifacts。
2. 日常验证用 GitHub Actions `Release` 的 `workflow_dispatch`，选择 `win`／`mac`／`all`，仅留存构建产物。需要对外发布时由维护者推送 `v*` tag；只有 tag push 且构建及 Windows ARM64 package-proof job 成功才发布。不要把手动构建或配置了 proof 步骤当成已发布／已验收；同一更新根发布串行，勿手工取消正在上传的任务。[VERIFY: .github/workflows/release.yml:7-24] [VERIFY: .github/workflows/release.yml:701-713]
3. tag 的发布 job 只取 artifacts 根层的包／清单／证据聚合 `deploy-bundle`，排除 unpacked 内部文件与 builder 调试配置；同名不同内容则失败。WebDAV 发布器只处理安装包与 channel 清单，证据保留给 GitHub 手动镜像。由 CI Secrets 提供认证并执行唯一发布入口。[VERIFY: .github/workflows/release.yml:744-767] [VERIFY: scripts/publish-update-webdav.mjs:27-33]

   ```bash
   node scripts/publish-update-webdav.mjs <deploy-bundle>
   ```

4. 发布器先校验本地包的相对文件引用与 SHA-512，并核对清单中已声明的 size（非差分 NSIS 清单可能省略 size）；再上传全部安装包，逐包 GET，按本地实际字节数与 SHA-512 严格核对。任一包上传或读回失败立即停止，不进入清单发布，也不靠异步重试掩盖失败。全部通过才逐个 PUT channel 清单；若清单阶段失败，需核对哪些通道已覆盖，不能称多清单原子发布。保留旧包，不做远端目录清空或镜像删除。[VERIFY: scripts/publish-update-webdav.mjs:27-72] [VERIFY: scripts/publish-update-webdav.mjs:117-141]
5. 检查当次 Actions 日志与远端清单引用是否完整，再在已安装客户端验证检查、用户下载、进度、下载完成与安装重启。macOS 还须确认签名／公证及原生更新安装；构建或上传成功不替代这些步骤。

## 4. 旧客户端迁移

```text
旧版（仍读 www.supercnm.top/claw-update）
  → 旧源发布一次含新源配置的迁移版 → 用户下载并安装
  → 迁移版开始读取 https://www.senluopan.com/dav/
```

修改新源码不会自动修改已安装旧版的更新源。迁移版必须版本更高、处于旧客户端可见的通道，且为其平台／架构提供可用安装包；先让新源具备有效包与清单，再在旧源发布这次迁移版。暂停安装包的平台不能假称已迁移，可保留旧源并提示手动安装受支持版本。

旧源可选 rsync 路径保留，仅供存量客户端过渡：

- `UPDATE_SERVER_HOST`、`UPDATE_SERVER_USER`、`UPDATE_SERVER_PATH`、`UPDATE_SERVER_SSH_KEY` 为必需；`UPDATE_SERVER_PORT` 可选，默认 `22`。
- 缺少旧源 Secrets 可以跳过旧源同步，但这也意味着未替旧客户端完成迁移发布；不能拿新源或 GitHub Release 代替旧版可见的清单。
- 旧源同步先包后清单，不删历史安装包、不使用 `rsync --delete`；不得把旧源加回新客户端 fallback。旧源步骤排在 WebDAV 发布之后、GitHub 镜像之前，其失败需排查，不能据此断言新源尚未发布。[VERIFY: .github/workflows/release.yml:763-817]

## 5. 失败定位与验证边界

| 现象 | 维护动作 |
| --- | --- |
| 新源 401／403 | 区分客户端只读与 CI 发布账号；核对 Secrets／更新根权限，不输出凭据 |
| 404／找不到 channel | 检查 URL 恰为 `/dav/`、通道及清单文件名，确认没有重复拼目录 |
| 包哈希／size 不符 | 停止发布清单，核对同次构建产物及读回结果，不手改清单绕过 |
| 旧版仍访问旧源 | 核对是否真正安装迁移版，以及旧源对应通道／平台是否发布过该版 |
| 需要 Windows 调试安装包 | 使用现有 `Debug Installer (Windows)` workflow；产物是调试 artifact，不代表更新发布 |

当前主协调报告已通过隔离 HTTPS 下 Electron 44.3 的 512 KiB 完整包下载／SHA-512 及认证边界验证，并得到真实 WebDAV 只读 PROPFIND 207；具体范围见 [模块验证记录](../docs/architecture-knowledge/modules/runtime-delivery/dev.md#2026-10-16-webdav-整包更新)。OPEN：生产 tag 发布、数百 MB 真实安装包的新源下载／安装重启、旧客户端迁移、macOS 原生更新安装。源码 VERIFY 只证明接线；认证连通、隔离传输、package smoke 或旧 updater 用例不等于这次端到端通过。

## 6. GitHub 到网盘的连通性测试

1. 在仓库 Actions Secrets 配好 `UPDATE_WEBDAV_USERNAME`、`UPDATE_WEBDAV_PASSWORD`，使用发布账号。
2. 将 [.github/workflows/test-update-webdav.yml](../.github/workflows/test-update-webdav.yml) 推送到仓库默认分支；不用打 tag，不运行 Release。
3. 打开仓库 **Actions → Test Update WebDAV → Run workflow → Run workflow**。
4. 打开运行日志，确认出现 `PASS: GitHub runner uploaded, downloaded, verified, and removed a 64 KiB file.`；失败则查看对应步骤的 HTTP 状态，不要输出密码。

该入口仅手动运行：上传随机命名的 64 KiB 文件、逐字节校验下载、删除并确认 404；不构建安装包，不读写 channel 清单，不发布版本。失败时也会尝试清理本次测试文件，清理失败须按日志中的确切文件名处理，禁止清空目录。连通性通过不代表大包上传或正式发布验收通过。[VERIFY: .github/workflows/test-update-webdav.yml]
