# Matcha 设计

可信应用插件：画板在聊天右侧工作区打开，React/Konva 页面与 Node 后台共用场景定义。文档、素材、历史与生成记录归插件持久化，关闭页面不取消已受理工具；不依赖 OpenClaw，也没有专属 Rust owner。

## 构建与安装

在目标平台安装本仓库依赖及 `skia-canvas`、`ffmpeg-static` 的原生构建依赖，然后从仓库根目录执行：

```sh
pnpm build:design
pnpm pack:design
```

构建只使用已存在的依赖；缺少 Skia、FFmpeg 或其许可文件时明确失败。每个 ZIP 只适用于构建时的平台和架构，不能把 Windows 原生文件装到 macOS/Linux。安装端不执行 npm、编译或下载。

在 Matcha「应用」的插件管理入口导入 `apps/design/design.matcha.zip`，确认信任后，进入聊天，打开右侧工作区的「设计画板」标签。画板不提供独立主导航页。完整 ZIP 更新必须增加 manifest 版本号；打包器不会覆盖已有输出，可先把旧 ZIP 移至其他位置。包含原生文件的包不能通过 UTF-8 源码编辑接口更新。

插件后台是可信 Node 代码，具有当前用户权限；页面的 opaque iframe 不是后台的本机文件/网络沙箱。

## 工作区使用

- 当前会话直接打开空画板，不经过创建表单或全局文档选择。完整 `SessionIdentity` 的 endpoint、agentId、sessionKey 共同标识文档；重复打开恢复同一份文档，切换运行时、Agent 或会话不会串板。
- 自由点阵画布没有固定白色画板边界。左侧竖排选择、手形、上传、框选修改和文字工具，左上撤销／重做／生成记录，右上缩放与适应内容；支持拖放、粘贴、框选、移动、缩放、旋转、文字、自动保存及持久化撤销/重做。
- 图片上沿显示名称和尺寸。选图后浮动显示局部修改、抠图、高清、编辑文字、消除、更多、导出和删除；白底图、水印擦除、涂抹重绘、翻译、尺寸和图层属性按需展开，不占用常驻三栏。
- 底部黑色工具条提供复制原图、商品场景图、商品换色、模特展示图、Logo 效果图、场景视频和多镜头视频推荐，其他既有能力收在更多。添加到对话的动作将本项提示词、参考图片和操作标签作为一组暂存；标签显示“商品换色 · 1 张图片”等摘要，展开后可编辑本项要求并查看精确参数。相同文档／action 更新原组，不同 action 并存，保留用户独立正文和附件；不自动发送。发送指令以本项当前要求作为 request.prompt、用户独立正文仅作补充；清空时保持空值，不回填旧 prompt 或借另一项要求，动作必填要求时先请用户补充、不执行。Chat 不解析 Design JSON，精确参数不伪装成 JSON 附件。[VERIFY: apps/design/src/ui/Editor.tsx:288-318] [VERIFY: src/plugins/chat/composer-drafts.ts:11-17] [VERIFY: src/plugins/chat/components/ComposerContextChip.tsx:52-58]
- 商品贴标需选择商品源图并单独上传 Logo。最多15张源图加1张 Logo；其他动作最多16张输入图。对话附件单张5 MiB、合计20 MiB，含已有草稿附件。大图可用参考预览入聊，执行仍读取插件资产及当前有效裁剪画面。普通源图／独立参考／人物图可经插件纯工具 `compose_edit` 减图并重算参数；移除必需 Logo、标注图或其配对源图，或减图后动作无效时，撤下整项操作，不能留下缺参请求。[VERIFY: apps/design/src/ui/Editor.tsx:234-318] [VERIFY: apps/design/src/backend/compose.ts:98-142]
- 局部修改／涂抹重绘先在画布绘制紫色选区，确认后按源图、标注图顺序暂存聊天，补充要求后手动发送；消除则确认选区后直接走默认图片模型。标注保存为原资产同尺寸 PNG，后台按源图同一 crop 裁剪再作为第二张普通参考图，不使用透明度蒙版，不保证选区外像素完全不变。[VERIFY: apps/design/src/ui/Editor.tsx:299-318,327-347] [VERIFY: apps/design/src/backend/generation.ts:96-129]
- AI 生成、OCR 和推荐读取 image layer 的有效 crop，而非整张原件，也不合成旋转、调整、描边或阴影。OCR 红框图使用裁剪后尺寸，`text_extract` 返回 `sourceCrop`（无裁剪为 null）；改字必须带回 `expectedSourceAssetId/expectedSourceCrop`，源资产或 crop 变化会在付费前报 `source_changed`。推荐的 UI 失效 key 与后台缓存 key 均纳入 crop。[VERIFY: apps/design/src/backend/image-input.ts:13-34] [VERIFY: apps/design/src/backend/analysis.ts:185-230] [VERIFY: apps/design/src/backend/generation.ts:96-110] [VERIFY: apps/design/src/backend/validation.ts:202-211] [VERIFY: apps/design/src/ui/Generation.tsx:63-69]
- 新导入、会话归集、预览插层、`image_open` 及生成图片默认锁定宽高比，不批量改写旧层。粘贴只用仍在有效画布区域的 pointer，否则按选中图／最右图片右侧或视口中心放置；批次一次提交后适应整批边界。复制原图区分准备失败与写入失败，可重新准备或再次点击写入。变换视角先选九种视角之一，再点“确认生成”，不因选项点击收费或旋转原图。[VERIFY: apps/design/src/activate.ts:76-79] [VERIFY: apps/design/src/ui/Editor.tsx:194-204,371-374] [VERIFY: apps/design/src/ui/useSessionMedia.ts:23-32] [VERIFY: apps/design/src/backend/generation.ts:226-228] [VERIFY: apps/design/src/ui/useCanvasTransfers.ts:177-235,265-305] [VERIFY: apps/design/src/ui/Canvas.tsx:184-205,512-539] [VERIFY: apps/design/src/ui/AnglePresets.tsx:10-15] [VERIFY: apps/design/src/ui/Generation.tsx:139-143,241]
- 界面导出选中图片的本地编辑成品为 PNG/JPG，按当前已保存 revision 渲染裁剪、调整、描边和阴影等效果；多选逐图渲染后打包 ZIP，不是下载原件。后台 `document_export` 另支持 WebP，按真实内容边界渲染；UI 与后台共用 `src/scene.ts`，不是浏览器截图。原件下载另读原 asset，不合成图层编辑效果。[VERIFY: apps/design/src/ui/Export.tsx:37-52,121-158] [VERIFY: apps/design/src/backend/export.ts:21-66] [VERIFY: apps/design/src/backend/validation.ts:150-156] [VERIFY: apps/design/src/scene.ts:25-118] [VERIFY: apps/design/src/ui/Editor.tsx:418-429]
- 生成记录保留图片、视频和分镜结果。`storyboard` 的名称为「多镜头生成与合成」（逐镜独立生成＋本地拼接）：每镜独立提交视频任务，原媒体先持久化，再由包内 FFmpeg 归一化尺寸／帧率／音轨并本地拼接；不是原生整任务联合分镜，不承诺跨镜头人物、商品或场景一致性。「多镜头视频推荐」则将推荐提示词交给单次 `video` 请求，不是这条拼接链。[VERIFY: apps/design/src/ui/tools.ts:4-5] [VERIFY: apps/design/src/ui/Generation.tsx:164-180,198-200] [VERIFY: apps/design/src/backend/generation.ts:300-347] [VERIFY: apps/design/src/backend/generation-video.ts:16-21,45-58] [VERIFY: apps/design/src/backend/video.ts:38-66]

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

`document_create({sessionIdentity})` 幂等打开或创建会话画板；不传身份时显式新建文档。`documents_list({sessionIdentity})` 精确过滤，不传则列出全部。工具不会把 sessionKey 当跨运行时的全局 ID。

Matcha MCP 按 `app__matcha_ddesign__<本地工具名>` 动态公布；标准 UI 资源为 `ui://app-plugins/matcha.design/editor`。`image_open({sessionIdentity,name,mimeType,data})` 复用资产导入和会话文档，成功后由宿主打开同一工作区面板，页面不接收图片 URL、路径或凭据。Matcha 内使用注入的 `window.matchaApp`，完整会话上下文在一次 iframe 生命周期内不变；`compose({text,attachments?,context?})` 等真实附件暂存提交后才成功，关闭或切会话回收未提交的本批，不撤掉已进入用户草稿的内容。Design 使用 `context.groupKey=<documentId>:<action>` 与 `attachmentRemoval:{tool:'compose_edit'}`；可信 AppFrame 绑定 pluginId/digest，Chat原草稿store持本项prompt、opaque context、staged IDs及附件metadata／custody，切A→B→A仍保组；减图复用现有`hostAppPluginCall`，image减至无参考可保有效text-only组，不要求iframe留开，不新增 native owner 或 server route。[VERIFY: src/plugins/chat/ChatInput.tsx:510-524,1189-1238,1253-1331] [VERIFY: src/plugins/chat/composer-drafts.ts:160-234,359-430] [VERIFY: apps/design/src/ui/Editor.tsx:307-318] [VERIFY: src/types/desktop/app-plugin-sdk.ts:156-182] [VERIFY: src/plugins/application-plugins/AppFrame.tsx:28-35] [VERIFY: src/plugins/chat/composer-drafts.ts:11-17]

界面自带独立 i18next 实例和 zh/en/ja/ru 资源，读取宿主初始 `context.language` 并订阅 `locale.changed`，切语言不重建画板。用户输入、原始文件名和工具 ID 不翻译。

外部 MCP Apps 使用官方 SDK，`context` 为 `{}`，不猜客户端会话、不打开全局最近文档。外部「添加到客户端对话」调用 `ui/message`，宿主可能立即开始模型响应，不承诺只暂存草稿；外部客户端互操作须单独实测。

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

构建保留 `THIRD-PARTY-NOTICES.txt`、`bin/FFMPEG-LICENSE.txt` 和 `bin/FFMPEG-README.txt`。当前 FFmpeg 二进制启用了 GPL；公开分发前必须核实对应源码及适用的完整许可义务，不能将附带许可证文本当作已经完成合规。
