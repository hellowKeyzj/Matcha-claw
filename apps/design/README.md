# Matcha 设计

可信应用插件：画板在聊天右侧工作区打开，React/Konva 页面与 Node 后台共用场景定义。文档、素材、历史与生成记录归插件持久化，关闭页面不取消已受理工具；不依赖 OpenClaw，也没有专属 Rust owner。

## 构建与安装

应用打包时，`electron-builder` 的 `beforePack` 按实际 `context.electronPlatformName/context.arch` 读取可信源码清单 `apps/bundled.json`，逐个调用插件的 `buildPlugin({platform,arch,outputDirectory,packager})`，再由 SDK `packDirectory` 生成并校验 ZIP、核对清单 ID，调用可选的插件专属 `validatePlugin(contents,platform,arch)`。全部成功后才替换 `build/app-plugins/<platform>-<arch>/`，目录中只有 `<id>.zip` 和统一 `index.json`，索引为严格 `[{id,version,digest}]` 数组，不生成每包 JSON；当前清单包含 Design。既有 `extraResources` 仍复制到安装包 `app-plugins/bundled/`；`afterPack` 核对索引与可信清单精确匹配、逐 ZIP 重验 digest／version／id，并运行插件专属校验。正式安装复用宿主唯一应用插件安装／归档链，不需要手工导入。已处理的同一包不会在每次启动时强装；用户卸载、回滚或手动安装的版本由宿主管理。

新增随包插件只需在 `apps/bundled.json` 追加 `{id,build}` 并提供对应构建模块；清单最多128项，ID 遵循 SDK 规则且不得重复，`build` 是仓库相对模块路径。`buildPlugin` 返回实际构建目录；仅有目标专属校验时才导出 `validatePlugin`。Design 的构建、包内校验与 macOS ZIP 前签名归 `apps/design/build.mjs`，原生文件头校验由 `apps/design/native.mjs` 供构建与依赖准备共用；公共打包脚本不包含 Design 分支，不修改 bootstrap 或增加第二打包器。

既有 `pnpm install` 通过根 `onlyBuiltDependencies` 允许 `skia-canvas`／`ffmpeg-static` 自带安装脚本准备本机原生文件；已安装但缺原生文件的缓存工作区可执行 `pnpm --filter @matcha/design rebuild skia-canvas ffmpeg-static`。`ffmpeg-static 5.3.0` 不提供 Windows ARM64，不能以本机 x64 文件替代。

打包阶段只读取已有依赖，不下载、不安装、不编译原生依赖。目标与构建主机平台／架构一致时可读取本机 `skia-canvas`、`ffmpeg-static`；跨目标必须预先提供 `build/design-native/<platform>-<arch>/`，包含 `skia.node`、`ffmpeg.exe`（Windows）或 `ffmpeg`（其他平台），以及同名 `.LICENSE`、`.README`。目标目录存在时必须完整，不回退本机。PE／Mach-O／ELF 的实际架构与文件类型必须匹配，不能只改目录名或 `BUILD.txt`；缺文件、错架构或生产验包失败即阻止打包。

Windows ARM64 在 Windows x64／ARM64 主机的仓库根目录、已有 `pnpm install` 依赖后单独准备；准备入口不支持其他主机平台，发布 workflow 在 Windows 双架构 builder 之前执行同一命令：

```sh
node apps/design/prepare-win-arm64.mjs
```

准备目标 `build/design-native/win32-arm64/` 包含8个文件：`skia.node`、`ffmpeg.exe`、`ffmpeg.exe.LICENSE`、`ffmpeg.exe.README`、`msvcp140.dll`、`vcruntime140.dll`、`vcrt.LICENSE.rtf`、`vcrt.README`。固定来源为 Skia Canvas 官方 3.0.4 `win32-arm64.gz`，以及 BtbN `autobuild-2026-10-31-12-59` 的 `n8.1.3-27-g8dca1586f4`、`winarm64-gpl-8.1` 静态 FFmpeg；该 ZIP 的 SHA-256 为 `40029da82e02abf0d12491e23666e710b7a8943d13501594cf38e6135b95efba`。

Skia 所需的两个 ARM64 VC runtime DLL 来自 Microsoft 官方 `VC_redist.arm64.exe` 14.44.35211.0（11,722,336 B），SHA-256 固定为官方 winget 所列 `5139e1440c3a20b92153a4db561c069a0175aaf76c276c3e5b6f56099edcf4b0`；不使用 LLVM 目录中的文件。准备阶段仅用 Windows 自带 `expand.exe` 静态解固定 CAB，不执行微软 EXE、不调用 `/layout` 或 `/install`、不全局安装。DLL 与 `skia.node` 同放 ZIP 的 `vendor/`，同时保留 `vendor/VCRUNTIME-LICENSE.rtf` 与 `vendor/VCRUNTIME-README.txt`。

准备阶段校验固定工件、缓存到 `build/design-native/downloads/`，通过空 staging 准备完整目标后再发布，不能将半包或 x64 工件交给打包器；下载与准备不属于打包或运行期。原视频业务、libx264／AAC 参数不变。

当前发布目标是 Windows x64／arm64 与 macOS arm64。2026-11-02 已核微软安装包及两 DLL 的 Microsoft Authenticode 为 Valid、DLL 版本均为14.44.35211.0且 PE 架构为 ARM64；递归 imports 无额外非系统依赖，FFmpeg 仅依赖系统／UCRT。

同日含 VC runtime 的8文件目标准备及重复执行通过；损坏 VC 缓存明确拒绝，旧完整目标摘要不变、缓存恢复且无 staging 残留。最终 Windows ARM64 bundle 与生产 validator 通过：ZIP **55,573,579 B**，解包121,084,076 B／14文件，manifest 保留18个工具，SHA-256 为 `3c1ab12f213b871e3a14840ec72acd09e653d43d620e72b213b7a008b7618a26`。从真实验包 files 删除 `msvcp140.dll` 或将其 PE machine 改成 x64 均被目标 validator 拒绝，恢复后通过。Windows x64 重新构建摘要仍为 `5027937f436f802e192e36840bdae65c4481bc30cd9ef764a89db26d8979ce87`，与此前一致。

2026-11-03 媒体读取修复构建为 v1.0.6：独立 x64 ZIP 为 `apps/design/design-1.0.6.matcha.zip`（41,400,487 B，SHA-256 `db299d1223c9d2f92329567b5639f7a72b438d3246d8e8bce4db2a2a2b0f36c2`）；双架构随包目录均已重建并生产验包，ARM64 ZIP 为55,573,599 B，SHA-256 `4fb9cd1834173bce6026c70f22f263dc2b78b789149fa2ab8efa9fbe845cb38a`。旧 `design.matcha.zip` 保留，不能将其误当本次修复包。无会话时不调用媒体列表，历史图片协议适配位于应用的Rust integration，单独升级插件不包含该宿主修复。未安装到实际profile，真实媒体归集未验。详见[本轮记录](../../.scratch/design-interaction-20261031/session-media-20261103.md)。

同日媒体质量复核构建为 **v1.0.7**：`apps/design/design-1.0.7.matcha.zip`（x64，41,400,550 B，SHA-256 `ca1cec6b66f5751ec5252700e1a3c34fa16c506726a33db783eadeb5aabc7053`）；x64随包摘要相同，ARM64随包55,573,662 B，SHA-256 `e77fd1559355243fba27b35a5a1b7f45551ccbefcf2a69517c63b17ea8b1fbe2`。补齐隐藏后的媒体恢复与错误条显式媒体重读；大图有界短连接和AppFrame恢复还需要同步交付宿主代码，单独ZIP不包含。双架构生产验包、Design／Renderer类型、限定lint及Rust库check通过，真实页面与大图native读取仍未验。

同日草稿交接构建为 **v1.0.8**：`apps/design/design-1.0.8.matcha.zip`（x64，41,401,399 B／10文件，SHA-256 `707245b1e3c92c8214af8fd31932206814b40287590c324f999821d3c5f1146f`）；x64随包摘要相同，ARM64随包55,574,511 B／14文件，SHA-256 `5a1d06537e135c86332b4ca542b7a987b7267b910fa515460fc0d6a86f294880`。SDK及Design目标校验、双架构统一索引验包、Renderer／Design类型通过；Host严格lint仍有2个改前已存warning，既有两suite为9通过／10失败，未改旧fixture求绿。Chat／Workspace／AppFrame晋升接线必须随宿主交付，单导入此ZIP不足覆盖整条链。未安装至实际profile，真实自动交接与媒体首扫未验；完整结果见[交接记录](../../.scratch/design-interaction-20261031/draft-handoff-20261103.md)。

同日空草稿 compose／推荐状态修复构建为 **v1.0.9**：`apps/design/design-1.0.9.matcha.zip`（x64，41,401,961 B／10文件，SHA-256 `431f4d1f317dbbfbfe7087ee5ae7822771ef364ca6bfa0ade823a18949062f3a`）；x64随包摘要相同，ARM64随包55,575,073 B／14文件，SHA-256 `cab4df6f2b7873206ded59b85f3fe0dddab9e02942c6ae18f807b63f7d9ec4df`。三包18工具均经SDK／Design目标校验，双架构索引生产验包通过，保留原版本化ZIP；完整Renderer、Electron Main及Design noEmit通过。十二源码严格lint为0 errors／1个HEAD已存Fast Refresh warning，未关闭规则；无新增tests／probe。空草稿添加与推荐缺配置分类均依赖同步宿主代码，不能只升级此ZIP；未安装、启动应用或请求模型，真实交互未验，见[本轮记录](../../.scratch/design-interaction-20261031/draft-compose-20261103.md)。

同日工程复核修正并精简提示为 **v1.0.11**：`apps/design/design-1.0.11.matcha.zip`（x64，41,402,873 B／10文件，SHA-256 `579f696ce06ef8e0e36df76421997ed80a6effba85e373c641b4bd81281d7688`）；x64随包摘要相同，ARM64随包55,575,984 B／14文件，SHA-256 `467d822bee8b41782c464942f21eadd5352b508d95e9c4b46aa7d937fdb0ceb8`。修正 v1.0.9 把已知凭据等失败一概显示“稍后重试”的遗漏：沿原工具错误结果保留 code，UI 显示短句，不恢复内部英文直出。最终 Design 类型、三源码严格 lint、三包及双索引生产验包通过；旧版本化ZIP（含复核中构建的1.0.10）保留。空草稿结构未额外重写，仍须同步宿主修改，真实应用未验；详见[复核记录](../../.scratch/design-interaction-20261031/draft-compose-20261103.md#工程复核与简短提示)。

**ARM64 真机、完整安装包、正式 release 与公开发布未验**，依赖闭合和 ZIP 校验不代表可运行或合规已完成。Linux 构建必须使用对应目标原生文件，不因存在打包配置而宣称已支持 Linux 发布。macOS 生产打包有既有 Developer ID 身份时，先签包内原生文件再生成 ZIP；安装端不签名、不下载。

独立构建／手动导入仍可从仓库根目录执行（需已有 SDK dist 及本机原生依赖）：

```sh
pnpm build:design
pnpm pack:design
```

构建只使用已存在的依赖；缺少 Skia、FFmpeg 或其许可文件时明确失败。每个 ZIP 只适用于构建时的平台和架构，不能把 Windows 原生文件装到 macOS/Linux。安装端不执行 npm、编译或下载。

在 Matcha「应用」的插件管理入口导入 `apps/design/design.matcha.zip`，确认信任后，进入聊天，打开右侧工作区的「设计画板」标签。画板不提供独立主导航页。完整 ZIP 更新必须增加 manifest 版本号；打包器不会覆盖已有输出，可先把旧 ZIP 移至其他位置。包含原生文件的包不能通过 UTF-8 源码编辑接口更新。

插件后台是可信 Node 代码，具有当前用户权限；页面的 opaque iframe 不是后台的本机文件/网络沙箱。

## 工作区使用

- 当前会话直接打开画板，不经过创建表单或全局文档选择。完整 `SessionIdentity` 的 endpoint、agentId、sessionKey 共同定位文档；重复打开恢复同一份文档，普通切换运行时、Agent 或会话仍隔离。空草稿中已打开的画板，只在该草稿真实创建正式会话且仍持有当前选择时承接：保留页签和原文档 ID、已保存内容、历史及媒体消费事实，新 iframe 冻结正式身份后由原媒体 hook 自动首扫，无需重开或手动刷新。每个新草稿有独立实例 ID，不把前一张独立画板接到另一会话；未确认裁剪／标注等临时手势不属于已保存内容。源码链与实机未验边界见[交接记录](../../.scratch/design-interaction-20261031/draft-handoff-20261103.md)。
- 空草稿也可将提示词、操作标签及图片添加到当前输入区，无需先发消息建会话；用户手动发送时才沿原初始化创建正式会话。当前页准确匹配草稿实例，切换后旧请求不能写入另一个输入框。此修正需要同步宿主 Chat／AppFrame 代码，不是仅升级插件。[VERIFY: src/plugins/application-plugins/application-workspace.tsx] [VERIFY: src/plugins/chat/composer-actions.ts] [VERIFY: src/plugins/chat/ChatComposer.tsx] [VERIFY: src/plugins/chat/ChatInput.tsx]
- 推荐缺少理解图片模型或路由时显示中性“请配置图片理解模型。”；无候选仍为空态。凭据、权限、限流和无效输出按已有错误码显示简短四语言提示；未知失败保错误＋手动重试，不透传内部英文，不自动重发模型请求。错误分类依赖宿主 CJS 私有链保留 native code，旧宿主只升级插件不能补齐分类。[VERIFY: apps/design/src/backend/analysis.ts] [VERIFY: apps/design/src/ui/Recommendations.tsx] [VERIFY: electron/main/app-plugins/media.ts] [VERIFY: electron/main/app-plugins/runtime.ts] [VERIFY: electron/main/app-plugins/worker.ts]
- 自由点阵画布没有固定白色画板边界。左侧竖排选择、手形、上传、框选修改和文字工具，左上撤销／重做／生成记录，右上缩放与适应内容；支持拖放、粘贴、框选、移动、缩放、旋转、文字、自动保存及持久化撤销/重做。
- 图片上沿显示名称和尺寸。选图后浮动显示局部修改、抠图、高清、编辑文字、消除、更多、导出和删除；白底图、水印擦除、涂抹重绘、翻译、尺寸和图层属性按需展开，不占用常驻三栏。
- 底部黑色工具条提供复制原图、商品场景图、商品换色、模特展示图、Logo 效果图、场景视频和多镜头视频推荐，其他既有能力收在更多。添加到对话的动作将本项当前额外要求、参考图片和操作标签作为一组暂存；标签显示“商品换色 · 1 张图片”等摘要，展开只编辑本项当前要求，opaque 业务参数不展示。相同文档／action 更新原组，不同 action 并存，保留用户独立正文和附件；不自动发送。所选推荐／模板／模特描述留在本项 request.prompt，context.prompt 只存当前自由要求；执行逐项合并两者，不回填旧自由输入、不借其他组要求，合并后仍缺必填要求时先请用户补充、不执行。Chat 不解析 Design JSON，完整业务参数仍归 Design，不伪装成 JSON 附件。本轮合同回放与静态检查已通过，真实应用／模型未验。[VERIFY: .scratch/design-interaction-20261031/accio-prompt-alignment-20261104.md] [VERIFY: apps/design/src/ui/Editor.tsx] [VERIFY: apps/design/src/compose-operation.ts] [VERIFY: apps/design/manifest.json] [VERIFY: src/plugins/chat/components/ComposerContextChip.tsx]
- 商品贴标需选择商品源图并单独上传 Logo。最多15张源图加1张 Logo；其他动作最多16张输入图。对话附件单张5 MiB、合计20 MiB，含已有草稿附件。大图可用参考预览入聊，执行仍读取插件资产及当前有效裁剪画面。普通源图／独立参考／人物图可经插件纯工具 `compose_edit` 减图并重算参数；移除必需 Logo、标注图或其配对源图，或减图后动作无效时，撤下整项操作，不能留下缺参请求。[VERIFY: apps/design/src/ui/Editor.tsx:234-318] [VERIFY: apps/design/src/backend/compose.ts:98-142]
- 局部修改／涂抹重绘先在画布绘制紫色选区，确认后将源图与标注图暂存聊天，补充要求后手动发送；消除仍在确认选区后直接走默认图片模型。标注保存为原资产同尺寸 PNG，后台按源图同一 crop 裁剪。模型输入合同改为 annotated edit「标记图→原图」、erase 只送紫色标记图、edit-text 只送 OCR 标记图；对话附件顺序不等于模型图序，原 asset／crop 身份门禁保留。不使用透明度蒙版，不保证选区外像素完全不变；本轮真实图片准备回放已通过，真实模型未验。[VERIFY: .scratch/design-interaction-20261031/accio-prompt-alignment-20261104.md] [VERIFY: apps/design/src/ui/Editor.tsx] [VERIFY: apps/design/src/backend/generation.ts] [VERIFY: apps/design/src/backend/validation.ts]
- AI 生成、OCR 和推荐读取 image layer 的有效 crop，而非整张原件，也不合成旋转、调整、描边或阴影。OCR 红框图使用裁剪后尺寸，`text_extract` 返回 `sourceCrop`（无裁剪为 null）；改字必须带回 `expectedSourceAssetId/expectedSourceCrop`，源资产或 crop 变化会在付费前报 `source_changed`。推荐的 UI 失效 key 与后台缓存 key 均纳入 crop。[VERIFY: apps/design/src/backend/image-input.ts:13-34] [VERIFY: apps/design/src/backend/analysis.ts:185-230] [VERIFY: apps/design/src/backend/generation.ts:96-110] [VERIFY: apps/design/src/backend/validation.ts:202-211] [VERIFY: apps/design/src/ui/Generation.tsx:63-69]
- 新导入、会话归集、预览插层、`image_open` 及生成图片默认锁定宽高比，不批量改写旧层。粘贴只用仍在有效画布区域的 pointer，否则按选中图／最右图片右侧或视口中心放置；批次一次提交后适应整批边界。复制原图区分准备失败与写入失败，可重新准备或再次点击写入。变换视角先选九种视角之一，再点“确认生成”，不因选项点击收费或旋转原图。[VERIFY: apps/design/src/activate.ts:76-79] [VERIFY: apps/design/src/ui/Editor.tsx:194-204,371-374] [VERIFY: apps/design/src/ui/useSessionMedia.ts:23-32] [VERIFY: apps/design/src/backend/generation.ts:226-228] [VERIFY: apps/design/src/ui/useCanvasTransfers.ts:177-235,265-305] [VERIFY: apps/design/src/ui/Canvas.tsx:184-205,512-539] [VERIFY: apps/design/src/ui/AnglePresets.tsx:10-15] [VERIFY: apps/design/src/ui/Generation.tsx:139-143,241]
- 界面导出选中图片的本地编辑成品为 PNG/JPG，按当前已保存 revision 渲染裁剪、调整、描边和阴影等效果；多选逐图渲染后打包 ZIP，不是下载原件。后台 `document_export` 另支持 WebP，按真实内容边界渲染；UI 与后台共用 `src/scene.ts`，不是浏览器截图。原件下载另读原 asset，不合成图层编辑效果。[VERIFY: apps/design/src/ui/Export.tsx:37-52,121-158] [VERIFY: apps/design/src/backend/export.ts:21-66] [VERIFY: apps/design/src/backend/validation.ts:150-156] [VERIFY: apps/design/src/scene.ts:25-118] [VERIFY: apps/design/src/ui/Editor.tsx:418-429]
- 生成记录保留图片、视频和分镜结果。`storyboard` 的名称为「多镜头生成与合成」（逐镜独立生成＋本地拼接），保持 direct 入口：request.prompt 为整体风格，scenes 各自保留镜头要求与时长，每镜独立提交视频任务，原媒体先持久化，再由包内 FFmpeg 归一化尺寸／帧率／音轨并本地拼接；不是原生整任务联合分镜，不承诺跨镜头人物、商品或场景一致性。「多镜头视频推荐」则将推荐提示词交给单次 `video` 请求，不是这条拼接链。[VERIFY: apps/design/src/ui/Generation.tsx] [VERIFY: apps/design/src/backend/generation.ts] [VERIFY: apps/design/src/backend/generation-video.ts] [VERIFY: apps/design/src/backend/video.ts]

### 操作 JSON 字段

`context.text` 保存 `DesignComposeOperation` JSON，由 Design 解释，Chat 不解析业务字段。以下是本地字段约定，不是 Accio 远端 schema。[VERIFY: apps/design/src/compose-operation.ts] [VERIFY: apps/design/src/ui/Editor.tsx:256-346] [VERIFY: apps/design/src/backend/compose.ts:36-150]

| 字段 | 含义 |
| --- | --- |
| `toolName` | 含插件命名空间的 `generate` 工具名。 |
| `document.id / revision / sessionIdentity` | 目标文档 ID、组装时的修订快照及可选会话关联；revision 不作执行版本门禁，sessionIdentity 不授予权限。 |
| `summary.name / imageCountNames` | 展示用操作名与数量标签；`imageCountNames[n]` 对应 n 张附件，`[0]` 为操作名。 |
| `sources[]` | 按 `sourceLayerIds` 排列的源图，`layerId / name` 为图层 ID／名称；`crop` 是原资产像素坐标的半开矩形，省略为整图，不含其他图层效果。 |
| `references[]` | video／storyboard 的独立参考图，对应 `referenceAssetIds`。 |
| `model` | 人物参考图，对应 `modelAssetId`；模型选择另用 `selectionId`。 |
| `logo` | Logo 图，对应 `logoAssetId`。 |
| `annotation` | 首张源图的紫色选区标注 PNG，对应 `annotationAssetId`。 |
| 共有 `assetId / attachmentName` | 生成读取的插件图片资产 ID，以及暂存到对话的附件名。 |
| 共有 `attachmentIndex` | 本组附件索引，从 0 开始，减图后重排；与模型输入顺序无关。 |
| 共有 `isPreview / originalMimeType` | 是否为格式／大小适配的预览，以及原资产 MIME；`false` 仍可能是裁剪后的 PNG，原 MIME 也可能与附件不同。 |
| `requests[]` | 完整生成参数，保留模型、输出及业务设置；通常一项，多图 upscale 按源图拆项。 |

`request.prompt` 保存所选推荐／模板／模特描述，外层 `context.prompt` 保存本组当前自由要求。执行逐项以 `[request.prompt, context.prompt].filter(Boolean).join('\n\n')` 合并，其余参数原样保留；清空的要求不回填，也不借用其他组内容。合并后仍缺必填要求时先补充，再执行。完整参数说明见 `generate` 的 inputSchema。[VERIFY: apps/design/src/document.ts:120-144] [VERIFY: apps/design/src/ui/Generation.tsx:162-182] [VERIFY: apps/design/src/ui/Editor.tsx:332-346] [VERIFY: apps/design/manifest.json:208-295]

### 2026-11-04 提示词与操作上下文（静态／回放通过，实机未验）

- `DesignComposeOperation.requests` 恢复完整 `GenerationRequest[]`，保留模型、数量、尺寸、时长、颜色、工艺、引用与源图绑定等业务参数；内层 prompt 只放所选推荐／模板／模特描述，当前自由要求独立进入外层 context.prompt。manifest 指导执行方逐项以 `[request.prompt, context.prompt].filter(Boolean).join('\n\n')` 调用原 generate，不覆盖所选正文，不混入旧自由输入或跨组借用。[VERIFY: apps/design/src/compose-operation.ts] [VERIFY: apps/design/src/document.ts] [VERIFY: apps/design/src/ui/Editor.tsx] [VERIFY: apps/design/manifest.json]
- compose parser 使用 `generationRequest(..., 'draft')`，只放宽尚未填写的自由要求，不放宽源图／附件／结构参数校验；真实 image／edit／video／product-scene 等仍需非空要求。recolor／logo／model-display 按结构参数生成业务规则，允许空附加要求；UI 不再自写 businessPrompt，人物照片规则仅由后端 modelAssetId 决定。snapshot 模式保原历史读取语义；原 direct／compose 分流不变。[VERIFY: .scratch/design-interaction-20261031/accio-prompt-alignment-20261104.md] [VERIFY: apps/design/src/backend/compose.ts] [VERIFY: apps/design/src/backend/validation.ts] [VERIFY: apps/design/src/backend/generation-snapshot.ts] [VERIFY: apps/design/src/ui/Generation.tsx] [VERIFY: apps/design/src/backend/generation-instructions.ts]
- 可取得的高清／白底／水印／erase／改字／标注清理／尺寸／翻译／换色／Logo／模特规则由插件后端按真实结构参数套用 Accio 可得原文；商品场景和视频推荐使用所选正文，不额外套旧保护模板。远端逐任务上下文 JSON、透明抠图、全图去字及 angle 远端原文未取得；`analysis.ts` 的 OCR extractionPrompt 与三类 recommendationInstructions 仍为本地模型适配，本轮保留分析合同、未改远端推荐服务。本地 operation／tool 字段不是 Accio 远端 schema，不宣称全部 prompt 逐字或全部字段一致。[VERIFY: .scratch/design-interaction-20261031/accio-prompt-alignment-20261104.md] [VERIFY: apps/design/src/backend/generation-instructions.ts] [VERIFY: apps/design/src/backend/analysis.ts]
- 具体 context tag 仅由 Design manifest 声明，经安装 adapter 贡献给通用 `{name,text,prompt?}` 信封；Host、Sessions 与两类原生 Agent 无 Design 专用适配。聊天只显示名称与当前要求，业务 JSON 保持 opaque；隐藏不等于保密。Design noEmit、定向 lint、18 项 schema 与合同／原文／真实图片准备／UI 入口／四语回放已通过，均不等于真实应用／模型验收，本轮未启动、安装或重启应用、未请求模型；验证统一见[冻结合同与主线程记录](../../.scratch/design-interaction-20261031/accio-prompt-alignment-20261104.md)。[VERIFY: apps/design/manifest.json] [VERIFY: src/plugins/application-plugins/plugin.ts] [VERIFY: src/plugins/message-rendering/tagged-context.ts] [VERIFY: src/plugins/chat/components/ComposerContextChip.tsx]

## 已批准产品边界（2026-10-31）

- 取消原生整任务 `storyboard` 目标，保留上述逐镜独立生成＋FFmpeg 本地合成，不以本地拼接冒充原生联合生成。
- 取消预置有许可图库目标；素材入口为用户提供的上传／拖入图片与当前会话可读历史原图，不承诺所有历史原件均可读。已有用户导入本地 `templates` 仍走 `asset_import → templates(save/list/remove) → storagePath/templates.json`，不删除、不迁移，也不另造「我的素材库」；模板图片不是平台预置授权素材，AI 推荐也不是图库。[VERIFY: apps/design/src/ui/Editor.tsx:474-475,504] [VERIFY: apps/design/src/ui/useSessionMedia.ts:80-161] [VERIFY: src/plugins/application-plugins/session-media.ts:52-105,108-144] [VERIFY: apps/design/src/ui/TemplatePicker.tsx:96-134] [VERIFY: apps/design/src/backend/templates.ts:37-108]
- 取消持久分享目标，保留上述本地成品 PNG/JPG／逐图 ZIP 导出、原件下载，以及现有原 bytes 保存到 Agent workspace。保存经 `SaveWorkspaceFile → saveWorkspaceFile → AppFrame` 身份／手势和相对路径／覆盖确认，再进入原 signed Workspace 二进制写入链；不拿下载代替保存。当前下载使用的本地 blob URL 随下载／页面生命周期回收，不是持久分享 URL；本次不新增或删除 share API。[VERIFY: apps/design/src/ui/SaveWorkspaceFile.tsx:32-88] [VERIFY: src/plugins/application-plugins/AppFrame.tsx:243-253,294-315,378-381] [VERIFY: electron/main/runtime-host-delivery/transport/workspace/write-binary.ts:58-94] [VERIFY: apps/design/src/ui/Export.tsx:87-98,150-154] [VERIFY: apps/design/src/ui/MediaPreview.tsx:193-204] [VERIFY: apps/design/src/ui/useAssets.ts:21-38]

云反馈此前已取消；调整后的范围不再被上述三项旧目标阻塞，但这是产品范围变更，不是新增验收成绩。类型检查／build 不等于真实模型或应用验收，不据此宣称第3组整体完成、已安装最新版或改写下列历史验证事实；当前统一进度见[第3组台账](../../.scratch/design-accio-third-20261031/README.md)。

## 工具与宿主

当前18个本地工具声明于 `manifest.json`，后台注册于 `src/activate.ts`；其中 `compose_edit` 的 MCP UI visibility 仅为 app，用于草稿减图，不调用模型或修改文档。[VERIFY: apps/design/manifest.json:12-387] [VERIFY: apps/design/src/activate.ts:125-146] [VERIFY: apps/design/src/backend/compose.ts:98-142]

```text
documents_list    document_create    document_get
document_edit    document_undo      document_redo
asset_import     asset_read         document_export
media_models     generate           generations_list
image_open       text_extract       recommendations
templates        generation_cancel  compose_edit
```

`document_create({sessionIdentity})` 幂等打开或创建会话画板；可选 `workspaceDraftId` 幂等打开原草稿文档，与正式身份一同传入时绑定原文档，双方已有不同归属则明确冲突、不合并或覆盖。两者均不传才新建独立文档。绑定属于归属事实、不增加内容 revision，undo／redo保留当前身份；先原子保存文档身份，再写 `sessions/<sessionhash>.json` 派生定位索引，索引失败不报成功。普通正式会话打开优先索引／原默认 hash 文件，仅缺二者时按完整身份查原文档并修复索引；首次查找可能遍历历史，未测性能、不宣称常数时间。`documents_list({sessionIdentity})` 仍按文档真实身份精确过滤，不传则列全部。工具不会把 sessionKey 当跨运行时的全局 ID。

Matcha MCP 按 `app__matcha_ddesign__<本地工具名>` 动态公布；标准 UI 资源为 `ui://app-plugins/matcha.design/editor`。`image_open({sessionIdentity,name,mimeType,data})` 复用资产导入和会话文档，成功后由宿主打开同一工作区面板，页面不接收图片 URL、路径或凭据。Matcha 内使用注入的 `window.matchaApp`，完整会话上下文在一次 iframe 生命周期内不变；`compose({text,attachments?,context?})` 等真实附件暂存提交后才成功，关闭或切会话回收未提交的本批，不撤掉已进入用户草稿的内容。Design 使用 `context.groupKey=<documentId>:<action>` 与 `attachmentRemoval:{tool:'compose_edit'}`；可信 AppFrame 绑定 pluginId/digest，Chat原草稿store持本项prompt、opaque context、staged IDs及附件metadata／custody，切A→B→A仍保组；减图复用现有`hostAppPluginCall`，image减至无参考可保有效text-only组，不要求iframe留开，不新增 native owner 或 server route。[VERIFY: src/plugins/chat/ChatInput.tsx:510-524,1189-1238,1253-1331] [VERIFY: src/plugins/chat/composer-drafts.ts:160-234,359-430] [VERIFY: apps/design/src/ui/Editor.tsx:307-318] [VERIFY: src/types/desktop/app-plugin-sdk.ts:156-182] [VERIFY: src/plugins/application-plugins/AppFrame.tsx:28-35] [VERIFY: src/plugins/chat/composer-drafts.ts:11-17]

界面自带独立 i18next 实例和 zh/en/ja/ru 资源，读取宿主初始 `context.language` 并订阅 `locale.changed`，切语言不重建画板。用户输入、原始文件名和工具 ID 不翻译。

外部 MCP Apps 使用官方 SDK，`context` 为 `{}`，不猜客户端会话、不打开全局最近文档。含操作参数时要求宿主广告 `updateModelContext.text`，先更新隐藏参数，再通过 `ui/message` 发送简文与附件；两次调用非原子，后一次上下文可覆盖前一次，原生多组草稿语义不外推。宿主可能立即开始模型响应，不承诺只暂存草稿；外部客户端互操作须单独实测。[VERIFY: apps/design/src/ui/api.ts]

## 模型与运行边界

`models.generate` 只传请求和媒体，不传 Provider 凭据。省略 `selectionId` 时使用 Matcha 已配置的图片/视频路由；显式选择必须使用 canonical `model-selection:v1:*` ID。API key、鉴权 URL 和上游任务不交给插件。

当前 Provider 实现 OpenAI 图片生成/编辑、OpenAI 视频提交/查询/下载，以及 Google Gemini 图片生成；其他协议、鉴权方式或不支持的参数明确报错，不保证任意配置模型都有媒体能力。OpenAI 视频时长支持4/8/12秒，界面默认4秒。

生成工作流在任何异步准备前原子占位，含准备阶段最多4单；文档与素材只准备一次，校验完成后才持久化真实 `running` 记录，再调用模型。关闭时拒绝新接单，取消并等待全部已接单任务，不自动重提。模型可能收费。取消仅停止本地等待/后续请求，不保证撤销已提交的远端任务；中断记录不会自动重试。重启后未完成记录标为 `interrupted`，已得到的媒体保留。页面关闭不取消后台，停用/更新会拒绝新调用并等待旧调用退出；非协作、永不返回的可信插件可能需要重启应用。

默认使用系统字体，不承诺跨平台字形与换行逐像素一致。未提供矢量 PDF/SVG 导出。

## 代码定位与验证

2026-10-31 本轮两批交互源码同步如上，仅作静态读源、引用与 diff 核对；集中验证结果见[本轮台账](../../.scratch/design-interaction-20261031/README.md)，真实新版本业务仍未验。未据此确认重新打包、安装新版、真实应用交互或模型成功；下列记录保留各自历史状态，不覆盖本轮。

```text
manifest.json          安装贡献与工具 schema
build.mjs              CJS、内联 HTML、原生依赖的目标平台构建
src/document.ts        文档、修订、图层、生成输入输出
src/scene.ts           浏览器/Node 共用场景
src/backend/           文档、资产、导出、模型生成、视频拼接
src/ui/                自由画布、浮动工具、业务弹窗、选区标注、历史
```

检查：`pnpm --dir apps/design typecheck`。2026-10-30 本轮 noEmit、定向 lint、Windows x64 构建与真实 ZIP 生产校验通过，精确命令和工件摘要见[验证记录](../../.scratch/design-final-form-20261030/verification.md)。真实应用安装、会话隔离、画布手势、草稿填入、下载与收费模型生成分别验收，编译或后台导出通过不等于使用与视觉一致。

2026-10-31 已从当前源码构建 Windows x64 v1.0.4，生产 ZIP validator、完整 noEmit 与版本入口 lint 通过；`design.matcha.zip` 与 `design-v1.0.4.matcha.zip` 内容相同，SHA-256 为 `ebd9f6cfe05cb519cfeddf744d4075d7bb46081b124f9717a0d9284274785a78`。在实际登录应用的插件详情中提交 ZIP 检查后，页面停在检查阶段，随后调试 target 关闭且入口不可连接；未确认更新、未重启应用，安装 catalog 仍为 v1.0.3。原57个插件数据文件共5,411,570B的路径／大小／SHA-256前后一致。该 ZIP 只包含 Design UI／backend，不包含 Chat、Electron Host 或 Rust Provider／Search／Wiki 修改；不把源码修复或打包成功当作已安装。详见[升级记录](../../.scratch/design-canvas-20261030/verification.md#2026-10-31-v104-打包与实际升级尝试)。

2026-10-31 后续源码已将局部编辑替换为“先绘制选区，再将原图与紫色标注图加入聊天”。完整 Design noEmit、八源 lint、12个工具 schema 的 Ajv strict 编译，以及隔离 Edge 中真实组件和插件后台的绘制／合成／失败重试／平移检查通过；未发模型请求。实际登录应用的9222调试入口连接被拒，尚未完成新版实机验收，未重启应用。上述 v1.0.4 ZIP 不含这次局部编辑与此前紧凑标签摘要更新，本轮未重新打包或安装。详见[局部编辑验证记录](../../.scratch/design-canvas-20261030/verification.md#2026-10-31-局部编辑改为原图与选区标注图)。

2026-10-30 已在实际登录 profile 安装 v1.0.2，实测独立设计导航撤下、右侧画板激活、自然尺寸图片导入、PNG/JPG 下载、逐图 ZIP、撤销/重做、关闭重开恢复，以及追加既有聊天草稿并聚焦；未发送模型请求，生成记录为空。半像素位置导出多 1px 已修复，真实下载 PNG/JPG 均为原图 2560×1600，ZIP 两项各自保持该尺寸，验收副本已撤回。

体验参考此前来自 Accio 提取包中的本地 ImageCanvas。2026-10-30 用户提供新版画布截图后，v1.0.3 源码补齐点阵、垂直工具、图片标签、图片预览进画板、图文草稿、操作上下文与画布原位蒙版，并统一四语言资源；本段记录实现范围，不代表该版本已经安装或真实交互验收通过。远端新设计中台 HTML 不在提取包内；云端场景/模特/工艺模板和图片文字自动识别仍未实现，真实收费模型调用和外部客户端互操作未验，不宣称已完全对齐或超越。

## 分发许可

构建保留 `THIRD-PARTY-NOTICES.txt`、`bin/FFMPEG-LICENSE.txt` 和 `bin/FFMPEG-README.txt`；Windows ARM64 另保留 `vendor/VCRUNTIME-LICENSE.rtf` 与 `vendor/VCRUNTIME-README.txt`。当前 FFmpeg 二进制启用了 GPL，Windows ARM64 使用上述固定 BtbN GPL 构建，对应源码／构建材料的分发与完整 GPL 义务仍待落实。Microsoft VC runtime 的再分发权须基于发布方有效的 Visual Studio 许可并遵守[官方再分发条款](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution)，runtime EULA 本身不等于再分发授权；完整分发许可仍须发布方确认。准备成功、ZIP 校验通过或附带 LICENSE／来源说明，均不代表公开分发合规已完成。
