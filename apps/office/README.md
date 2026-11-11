# Matcha Office

Matcha Office（`matcha.office`）把 [GenOffice](https://github.com/genspark-ai/genoffice) 的文档引擎接入 MatchaClaw 应用插件体系。文档保存在插件自己的本地库，不依赖 GenOffice 桌面端安装。

**当前安装（2026-11-11）**：用户当前Profile已正常升级Office **0.2.7**、Design **1.0.12**，catalog revision29。左侧仅统一应用管理入口，工作区显示独立图标；真实点击Docs并确认编辑器与页签已生效。文库／画板数据未迁移或清理，下方版本与未安装状态均为历史阶段，精确收据见HANDOFF顶部。

**历史版本状态（2026-11-11）**：**0.2.6 已经正常应用管理界面安装到用户当前 Profile**，catalog revision27，digest `68f7198d…cab6`，最低 SDK1.5.0。当前包已完成 Markdown→Docs 页面导航／singleton／dirty取消与保存、HTML动态 module／fetch／图片预览与演示／保存重开，以及 PDF／Word／PNG／资源ZIP导出独立读回；Slides真实H264视频插入、封面、保存重开与PPTX媒体字节核验通过。**不宣称全部非打印能力100%实机闭合**；512 MiB整件Docs、其它codec、PDF复杂页面操作及其余未逐项运行的交互仍待验，详见 [HANDOFF.md](HANDOFF.md)。

**完整性核对（2026-11-11）**：逐功能报告后的七owner并发实施已补齐本轮确证接入差异，包括六编辑器入口、原文档动作、资源生命周期、原生CSV、导航与保存语义。最终全Office类型／严格overlay、独立构建、canonical SDK打包读回验包通过；未安装或复验正式UI，不宣称全部实机完成。新包 [matcha.office-0.2.6-functional-final.zip](../../.scratch/office-functional-closure-20261111/matcha.office-0.2.6-functional-final.zip)，digest `4629c24f…00b5e`。各报告末节为实施证据，旧差异清单属于历史；失败记录及未验边界见 [实施记录](../../.scratch/office-functional-closure-20261111/implementation.md) 与 [HANDOFF.md](HANDOFF.md)。

**后续工程质量修订**：已修选区退役、HTML保存期间编辑保护／资源GC与undo、Markdown Wiki真实解析一致性；完整类型、严格overlay、定向lint、独立构建与验包通过。当前新工件为 [matcha.office-0.2.6-quality-final.zip](../../.scratch/office-functional-closure-20261111/matcha.office-0.2.6-quality-final.zip)，digest `59d55c8a…3d1f`；未安装／实机复验，上述functional-final不含本次修订，详见HANDOFF顶部。

**最新接入续改**：最后确认的Markdown手工隐去入口、Slides URL图片与脚本编辑、Sheets语言事件、HTML无扩展名CSS图片保存已修；原算法行为判据、类型／严格overlay、构建与验包通过。当前工件为 [matcha.office-0.2.6-integration-final.zip](../../.scratch/office-functional-closure-20261111/matcha.office-0.2.6-integration-final.zip)，digest `0c708839…87de`，未安装／实机复验；旧quality-final不含这五项修订。详见HANDOFF顶部。

**最新工程收敛**：Slides动作改为请求独享的三方法接口，删除全局劫持；HTML共享遍历覆盖模板、正确编码CSS路径；Sheets语言订阅即时交付当前值。原算法内联、完整类型／严格overlay、定向lint、独立构建及canonical读回通过。最新包 [matcha.office-0.2.6-structure-final.zip](../../.scratch/office-functional-closure-20261111/matcha.office-0.2.6-structure-final.zip)，digest `8f36e82b…9890`，未安装／实机复验；下方integration-final等为历史工件，详见HANDOFF顶部。

**工作区入口与图标（最新源码）**：六编辑器各自声明单色线性图标，支持工作区打开并保留原路由，最低SDK1.6.0；宿主不再逐项占左侧菜单，工作区列表与页签共用图标。Renderer类型、SDK构建、原贡献工厂、独立图标渲染及Office／Design完整构建验包通过；新包matcha.office-workspace-icons.zip未安装，业务版本未升，不作为同版不同digest更新安装。正式应用／Profile未验，详见HANDOFF顶部。

### 0.2.6 源码与验证（最低 SDK 1.5.0）

**安装后源码续改**：工程复核进一步修正Docs并发上传准入、HTML资源确认代次与无扩展名资源MIME，以及PDF业务名称／稳定阅读身份；完整Office类型／严格overlay、独立构建与canonical验包通过，新包为 `.scratch/office-complete-20261111/matcha.office-0.2.6-engineering-review.zip`，digest `a5ac7ae0…5902`。**尚未安装或复验新修订正式UI**，不能沿用此前GUI成绩认领，精确结果见HANDOFF顶部。

- 正式后台复用 SDK `context.desktop.openExternal/revealFile/pickFile`，CJS 与 stdio 同一通用服务；UI 不直接取得本机路径或任意 Host API。可信后台仍非 OS 沙箱。[VERIFY: sdk/app-plugins/src/services.ts:132-162] [VERIFY: electron/main/app-plugins/desktop.ts:18-46]
- `src/settings/store.ts` 单写 `app-settings.json` 中的文档页面主题、默认自动保存、作者名三项公共偏好；`browser-preferences.json` 按六编辑器 namespace 持久化原 `localStorage` 偏好。六 entry 先 hydrate、再动态加载 page；headless 与 `sessionStorage` 仅内存。正常受控关闭等待偏好写入，强退不保证最后一笔落盘。[VERIFY: apps/office/src/settings/store.ts:9-74] [VERIFY: apps/office/src/platform/browser-preferences.ts:7-67] [VERIFY: apps/office/src/platform/browser-storage.ts:4-48] [VERIFY: apps/office/build.mjs:343]
- 已接回 Docs 页面／headless 字体度量，Sheets 外链选源 token 在后台保存时还原真实 file URL、定位原件及打开外链，Slides 剪贴板 unknown 状态／随机 metadata token，以及文档外链、Markdown Ctrl+K／主题、PDF 指定衍生产物入库后自动打开。均是源码实现，不是 GUI／真实落盘验收。[VERIFY: apps/office/src/docs/session.ts:40] [VERIFY: apps/office/src/docs/headless-worker.tsx:43-50] [VERIFY: apps/office/src/sheets/session.ts:226-245] [VERIFY: apps/office/src/sheets/session.ts:354-362] [VERIFY: apps/office/src/slides/bridge.ts:154-174] [VERIFY: apps/office/patches/genoffice/apps--slides--src--main--slides-main.ts.patch:83-86] [VERIFY: apps/office/patches/genoffice/apps--markdown--src--renderer--components--Ribbon.tsx.patch:136] [VERIFY: apps/office/src/pdf/session.ts:130-145]
- Markdown→Docs 已改为生成 DOCX 入库后，通过同插件 `openApplication` 打开真正应用页；既有目标页复用 singleton，Docs 走原替换确认和保存生命周期，不再用独立 presentation 窗口代替编辑页。真实 Profile 已验页面导航、singleton复用、dirty取消保稿与保存原稿后替换；放弃／关闭分支仍待补验。

设置入口通过 App／Ribbon 的 `trailingActions` 声明式接入，不再查询 DOM 或外挂 portal；HTML／PDF 外链由实际 handler 走显式 API，不覆盖 `window.open` 或捕获整页链接。偏好写盘按 key 保留失败，后续无关写入成功不能让正常关闭误放行。[VERIFY: apps/office/src/docs/page.tsx:29-63] [VERIFY: apps/office/src/slides/page.tsx:34-65] [VERIFY: apps/office/src/html/page.tsx:55] [VERIFY: apps/office/patches/genoffice/apps--pdf--src--preload--index.ts.patch:14] [VERIFY: apps/office/src/platform/browser-storage.ts:9-33]

**历史构建与差异排查**：SDK1.4、早期包超限、Electron stream类型失败及API补齐阶段的旧记录保留在 HANDOFF；这些均不是当前工件状态。公共包限额已统一为ZIP256 MiB、解压512 MiB、单文件384 MiB、4096文件，不裁字体／资源。当前SDK／Renderer／Electron／Office全上下文检查与应用构建均通过，正式patch严格SHA／apply通过。

**当前实现与工件**：Docs复用原lazy ZIP及编辑器私有二进制传输，53.5 MB实件打开／保存／跨session恢复通过；512 MiB为解析输入边界，不是整件应用实测，原materialize仍用Buffer，headless大件未验。OS locale来自真实Electron；PDF普通保存自动命名按明确持久未命名事实与CAS提交，已有生产链验证而非正式UI。HTML动态导出及Slides H264的当前Profile成绩见顶部。最终工件为 `.scratch/office-complete-20261111/matcha.office-0.2.6-closure-final.zip`，1027文件、134367178内容bytes、53746015 ZIP bytes；已安装digest与该工件一致。完整边界、失败历史和未验项见 [HANDOFF.md](HANDOFF.md)。

## 编辑器与范围

| 编辑器 | 文档 | 实现基础 |
| --- | --- | --- |
| Docs | `.docx` | 原 Docs App、Tiptap、DOCX 引擎与分页 |
| Sheets | `.xlsx`、保宏 `.xlsm` | 原 Sheets App、Univer、Rust `xlsx-sidecar` |
| Slides | `.pptx` | 原 Slides App、Konva、PPTX 引擎 |
| PDF | `.pdf` | 原 PDF App、PDFium／PDF.js 与保存校验 |
| Markdown／文本 | `.md`、`.txt`、`.json` | 原 Markdown App、原文本模式；Wiki 仅索引 Markdown |
| HTML | `.html` | 原 HTML App、CodeMirror、隔离预览 |

本次接入目标为上游非打印文档能力，包括导入转换、PDF／图片导出、资源、剪贴板、密码、原有恢复、邮件合并、拼写、Zotero、工作簿合并及演示／媒体录制。**物理打印、打印机选择及 Markdown 自备图床上传不在范围内；本地文档图片／资源与 PDF 导出保留。** 各项真实运行验收仍需分别完成，不能把页面或桥接代码存在视作功能通过。

AI 由 MatchaClaw agent 通过公开工具调用。GenOffice 自带 Agent、provider／账号流程、独立桌面壳、CLI 和 MCP 服务入口不启动；复用其中的文档算法不等于运行这些入口。

## 目录

```text
apps/office/
  genoffice/          # 原样上游白名单快照，仅 sync 生成，禁止手改
  src/
    activate.ts       # 唯一路径初始化、装配、停止接单、drain、释放
    documents/        # model、单写 store、service、公开 tools、页面 client
    docs/             # Docs page、desktop bridge、快照、恢复、导出
    sheets/           # Sheets page、native session、保存、PDF 布局
    slides/           # Slides page、native session、保存、演示、导出
    pdf/              # PDF page、session、编辑／保存、转换、OCR
    markdown/         # Markdown page、session、资源、转换
    html/             # HTML page、session、资源投影、转换
    settings/         # 公共三偏好、四语言设置 UI 与通知
    conversion/       # 复用原 HTML 布局转换算法的后台渲染入口
    ui/               # 文档选择、命名、确认、文件选择与下载
    platform/         # 环境、IPC、临时资源；不拥有文档保存决策
  scripts/
    sync.mjs          # 原样同步上游
    patches.mjs       # 严格校验并应用临时 overlay
    typecheck.mjs     # 按后台／各页面／worker 的真实全局环境检查
  patches/            # 上游与依赖的显式适配补丁
  test/               # 既有引擎和三页面烟测，不是六页完整验收
  build.mjs           # 后台 ESM、共享浏览器 ESM 图与 native 资源
  manifest.json       # 六 applications、12 public、11 app-only tools
```

不保留 `adapter/`、`src/backend/` 或旧路径 reexport。`genoffice/` 不是完整仓库：完整本地上游在 `.scratch/genoffice`，当前快照来源提交为 `d8eb53baed18327b83d8655147c4759b8c44639c`。白名单包括六编辑器、被引用的共享包、转换算法、字体及 xlsx-engine 源码；保留源码不代表启动该包的独立运行入口。

## 公开工具

| Tool | 作用 |
| --- | --- |
| `documents_list` | 列出本地文档库 |
| `document_create` | 创建六编辑器支持的八种文档类型；PDF 仅创建空白 A4 页 |
| `document_import` | 导入文件字节，支持已接通的旧格式真实转换 |
| `document_read` | 文档预览；PDF 可指定密码与页范围 |
| `document_edit` | CAS 编辑：文档 ops、表格 cells、文本 source 或 PDF 编辑请求 |
| `document_check` | 调用对应文档检查 |
| `document_export` | 导出原文件，以及既有 DOCX→Markdown／XLSX→CSV |
| `document_write` | CAS 替换完整正文及可选资源 |
| `document_delete` | 删除文库文档 |
| `document_guide` | 返回 Docs／Sheets／Slides 原操作指南 |
| `document_convert` | 新建转换结果文档，保留源稿 |
| `document_render` | 渲染为 PNG 页图，页码输入／输出均从 1 开始 |

Markdown／HTML 的 create、import、write、edit 可携带 `resources: [{path,data}]`，其中 `data` 为 canonical base64。read／export 返回可回写的资源数组。其它封闭文档格式不接受外置资源。

`document_convert` 接收 `{documentId,to,name?,password?,sheet?}`，返回源文档、新文档与 warnings；不是任意六种格式两两互转。当前源码路由包括 DOCX→PDF／HTML／Markdown、XLSX／PPTX→PDF、Markdown→DOCX／HTML／PDF、HTML→DOCX／Markdown／PDF，以及原 PDF 转换链。

旧格式导入包含 Word `.doc/.dot/.odt/.ott/.hwp/.hwpx`、表格 `.xls/.csv/.tsv/.ods/.ots`、演示 `.ppt/.odp/.otp`。转换后生成真实目标格式，不只改扩展名；`.xlsm` 保留原宏包与文件名。上游本身不提供 `.xlsm`→`.xlsx` 跨格式另存，插件不冒称支持。

另有 **11 个 app-only 工具**，均声明 `_meta.ui.visibility: ["app"]`：

- `office_docs_ipc`
- `office_sheets_ipc`／`office_sheets_open`
- `office_slides_ipc`／`office_slides_open`
- `office_pdf_ipc`／`office_pdf_open`
- `office_markdown_ipc`／`office_markdown_open`
- `office_html_ipc`／`office_html_open`

它们只供插件页面调用，不应进入 agent 工具目录。IPC 输入统一为 `{channel,arguments?,editorId?}`，结果为 `{result}`；open 按文库身份打开，不是任意本机路径入口。新版本目录隔离尚待实际 Host 验证。

## 数据与责任边界

- **Documents 单写**：`storagePath/office/` 保存索引及不可变正文／资源；`documents.json` 原子 rename 为唯一提交点。编辑以打开或最近成功保存的 revision 做 CAS，冲突不覆盖较新版本。`libraryPath` 是虚拟库路径，不是物理路径。
- **资源与正文同提交**：resources 缺省保留，`[]` 清空，显式集合整套替换；资源路径为 canonical 相对路径，资源物理根始终属于文档。资源写入和 move 同样推进 revision。
- **导入来源不等于文库身份**：Sheets 本地导入的 `sourcePath` 仅供后台解析原相对外链，与正文同索引提交，公开 record／工具结果不暴露；工作簿 picker／tabs 使用 opaque 文库身份。显式选文库源才写入文库引用，不按文件名猜绑定。
- **各编辑器自持会话**：Docs 自持打开快照；Sheets／Slides 自持 native session 与保存事务；PDF／Markdown／HTML 自持对应编辑与资源状态。另存副本产生新文库身份，不覆盖原稿。
- **提交与通知分开**：提交前检查取消，成功提交后不因通知失败或迟到取消伪报保存失败。Sheets 在库提交前准备新 generation，失败保留旧 session。
- **统一环境配置**：activate 一次初始化原 Electron 环境路径；三项公共偏好由 `settings/store.ts` 单写 `app-settings.json`，其余编辑器专有设置／workbook／临时目录各自隔离；`browser-preferences.json` 只承接编辑器 namespace 下的浏览器偏好。
- **显式退役**：停止接单并注销工具，解除 Docs／PDF 对话与 Sheets 恢复等待，drain 在途操作后释放六类 session；不提前销毁已开始保存所需状态。
- **Host 只提供通用能力**：opaque iframe、MessagePort、已验证包资源、隔离文档渲染、演示、原生剪贴板／拼写／媒体授权。不把 Office channel、文档模型、保存策略或资源库搬入 Host。

页面共用浏览器ESM图、字体和资源；后台布局worker独立打成无外部imports的自包含ESM。`renderDocument`只读取当前真实plugin digest的已验证包入口；动态作者文档在独立snapshot origin运行，可信worker从Host内存装入隔离world，通过有限端口提供ready／viewport／screenshot／print／结果消息，不向作者发布包资源端点。不启动GenOffice桌面壳，不开放任意RPC；PDF复用唯一原生owner。

已知待验边界包括PDF页面副本／复杂操作与普通保存命名的正式UI、Slides其它codec／录屏／双屏，以及复杂文档分页与字体、密码／异常退出恢复和其它未逐项执行的交互；不能据此认定无其他遗漏。HTML module／fetch、三格式与资源ZIP导出真实落盘、Slides已知H264插入保存重开本轮已验，证据见HANDOFF。Markdown后端Word转换保留上游CLI限制：图片仅PNG／JPEG／GIF，diagram退回源代码；UI转换沿原canvas路径。限制不能解释为全功能已验。

## 构建

### 同步源码

```powershell
$env:GENOFFICE_SOURCE='E:\code\Matcha-claw\.scratch\genoffice'
node apps/office/scripts/sync.mjs
```

只由此脚本生成 `genoffice/`。上游适配必须更新 `patches/` 与登记：包名／版本、原文件 SHA-256 和 patch 上下文不匹配即失败。构建只在临时 overlay 应用补丁，沿原 source path／resolveDir 提供 patched bytes，保留 module identity；不回写上游或 node_modules。

### Native 资源与插件

xlsx sidecar 的构建输出必须放在 `genoffice/` 外；如已有匹配二进制，直接复用，避免重复 Rust 构建。

```powershell
$env:XLSX_SIDECAR_BIN='E:\code\Matcha-claw\apps\office\.build\xlsx-target\release\xlsx-sidecar.exe'
$env:OFFICE_OCR_HELPER_BIN='E:\path\to\win-ocr.exe'
node apps/office/build.mjs
```

Windows OCR helper 由原上游 C# 源码及系统 WinRT 引用编译；`OFFICE_OCR_HELPER_BIN` 可指定预编译结果。不得用空 helper 替代。

构建成功后 `dist/` 包含 CJS activate facade、后台 ESM 分块、六个 HTML、`renderer/` 共享 ESM／字体／worker、PDF.js 资源、xlsx sidecar、HarfBuzz、PDFium、HWP、OCR、Sharp native 闭包、jsdom 与许可文件。不能只复制 HTML 或依赖根仓 node_modules。构建强制遵守 SDK 的 4096 文件／512 MiB 内容限制（ZIP ≤256 MiB、单文件 ≤384 MiB），失败清理临时产物，不裁字体、不设 Office 特例。

```powershell
node scripts/bundle-app-plugins.mjs --platform win32 --arch x64
```

成功后应用插件 ZIP 位于 `build/app-plugins/win32-x64/matcha.office.zip`；源码版本号并不证明该 ZIP 已更新。

## 验证

类型检查按真实后台、六页面及 worker 分别建立 Program，避免把不同 App 的 `Window.desktopApi` 混成一个全局：

```powershell
node apps/office/scripts/typecheck.mjs
```

既有引擎／浏览器烟测位于 `test/`，部分旧 harness 与现在 editorId／工具合同不同，且使用注入桥，不能替代正式 opaque iframe、当前 Profile 保存重开、隔离 ZIP／无根依赖、原生交互或模型闭环。不得为了跑绿恢复旧共享会话或空返回。

0.1.9 至 0.2.5 的检查与实机成绩仅覆盖对应版本。0.2.6 必须独立验证六编辑器、原格式转换、输出内容／字体／分页、资源／CAS／副本、原有恢复、12 个公开工具与 11 个内部桥隔离。gpt-6-luna 闭环须由模型实际完成，不能以直接 gateway 工具调用冒充。具体结果以 [HANDOFF.md](HANDOFF.md) 中的原始证据为准。

## 许可

GenOffice 采用 Apache-2.0；`LICENSE`、`NOTICE` 与所需第三方许可随插件包保留。GenOffice 和 Genspark 是 Mainfunc, Inc. 的商标；本插件不使用其品牌、Logo 或应用图标。
