# Windows x64 本地打包

面向本机已有开发依赖与资源缓存的日常打包；在项目根目录执行：

```sh
pnpm run package:win:x64:local
```

前置：Node/pnpm、Rust MSVC 工具链、Visual Studio C++ x64 Build Tools、64 位 Python 3、已安装的根目录与 matcha-agent 依赖，以及 `pnpm run download:wiki-assets -- --platform win32 --arch x64` 准备的 Wiki 资产。下载缺失资源仍需要网络，不能保证离线首次准备。

- 自动初始化 MSVC，无需打开 Developer Command Prompt；失败时显示阶段与日志目录。
- 串行完成两个 Rust 程序、桌面/CLI、OpenClaw/插件、SearXNG 与 EasyTier 资源准备，再生成 NSIS；准备失败不会继续出包。
- Host 使用已验证的本地低内存优化 `ThinLTO + codegen-units=1`，不是 CI x64 默认的完整 LTO；NSIS 资源归档使用压缩级别 5，减少本机压缩内存。CI 与 Cargo 配置不变。
- uv/Bun/Git 复用版本匹配的本地缓存；预装技能显式复用原锁定远程快照，本地技能源每次更新。无缓存时沿原下载入口获取。
- 每阶段使用 Windows Job 整树内存硬限、超时和 owned 清理；Cargo 退出后仅回收本次 Job 内、与所选 MSVC 路径精确匹配的遥测进程，其他后代仍须正常退出。不终止已有应用，不覆盖开发态原生 dist，不安装或发布。
- 网络编译保留原 Cargo 缓存，产物通过 `--artifact-dir` 发布到 `build/local-win-x64/network`，打包器只从该目录取网络组件，不替换开发版正在使用的 `resources/bin/win32-x64/easytier`；网络发布临时目录不进入安装包。
- 生成后实加载包内 node-pty/ConPTY 与 Koffi，核对安装包 CRC、更新清单摘要、两个原生程序及网络组件与本次产物的一致性。
- 输出：`release/local-win-x64/MatchaClaw-<version>-win-x64.exe`。
- 阶段日志与本次原生工件：`build/local-win-x64/`。重新执行会更新该入口自己的输出，重建 NSIS 中间归档以免复用中断残件；复用 Cargo 缓存，但不是跳过失败阶段或复用旧 EXE 冒充新编译。
