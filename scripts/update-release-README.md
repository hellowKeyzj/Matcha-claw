# 发布流程说明（MatchaClaw）

本文件记录仓库当前的发布链路与常用操作，面向维护者。

## 1. 触发方式

- 自动触发：推送 `v*` tag（例如 `v0.1.25`、`v0.1.25-alpha.1`）
- 手动触发：GitHub Actions `Release` workflow_dispatch
  - `version`：版本号（不含前缀 `v`）
  - `platform`：`win | mac | linux | all`

## 2. 工作流结构

- `resolve-matrix`：根据触发来源与 `platform` 生成构建矩阵
- `release`：分平台构建并上传 artifacts
- `publish`：聚合 artifacts，创建 GitHub Release
- `upload-oss`：上传渠道目录与归档目录到 OSS
- `finalize`：仅对稳定版（非 alpha/beta）将 GitHub Release 提升为 latest

## 3. 版本与通道规则

- tag 规则：`vX.Y.Z` 或 `vX.Y.Z-alpha.N` / `vX.Y.Z-beta.N`
- 通道识别：
  - 含 prerelease 标记（`alpha`/`beta`）→ 对应通道目录
  - 否则 → `latest`

## 4. 产物命名约定

当前产物前缀为 `MatchaClaw-`，示例：

- `MatchaClaw-<version>-win-x64.exe`
- `MatchaClaw-<version>-mac-arm64.dmg`
- `MatchaClaw-<version>-linux-x86_64.AppImage`

`upload-oss` 生成的 `release-info.json` 会按该命名规则输出下载地址。

## 5. 常用发布命令（本地）

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run package:win   # 或 package:mac / package:linux
```

## 6. 调试安装包（Windows）

使用 `Debug Installer (Windows)` workflow：

- 输入可选 `artifact_name`
- 产物会以 artifact 形式上传（默认保留 7 天）

适用于排查签名、安装器脚本、打包产物缺失等问题。

## 7. 发布前检查清单

- 版本号与 tag 一致
- `pnpm-lock.yaml` 与依赖变更一致
- `electron-builder.yml` 的 publish 配置与当前环境一致
- 关键文档（`README*`、`CHANGE.md`）已同步
- 至少一次完整回归（`typecheck + test`）通过

