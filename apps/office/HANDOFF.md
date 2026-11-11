# Matcha Office 移植适配交接文档

> 更新时间：2026-11-11
> 仓库：`E:\code\Matcha-claw`  
> 上游：`genspark-ai/genoffice`，当前快照对应提交 `d8eb53baed18327b83d8655147c4759b8c44639c`  
> 本地上游 checkout：`E:\code\Matcha-claw\.scratch\genoffice`（干净状态见历史核验，不代表持续监测）

## 0. 先看结论

### 当前 Profile 安装完成（2026-11-11）

用户明确授权后，经当前运行应用的正常管理页文件检查／更新确认安装Office0.2.7与Design1.0.12，catalog revision29，enabled均true，分别保留previous0.2.6／1.0.11；没有卸载、手改catalog或迁移业务数据。实际Main PID31912归本仓dev Electron，读取app.getPath确认Profile为C:/Users/Mr.Key/AppData/Roaming/matchaclaw，未起第二实例。新包digest分别为`45744c827d85895926fbd70994da6217c1a008601df2c171253b3d563bf263d0`、`8ef2f776e3898c639f4b3bda15ac815b96bc14744dd4d2a5d4f1d2e19369ebdb`，收据package-workspace-install.json及profile-workspace-installed.json。

当前真实页面已核：左侧只剩统一#/applications管理入口，工作区可见六Office入口与设计画板独立图标；点击Docs后原编辑器实际渲染、页签图标存在，两张实际截图已查看，最终停在工作区Docs。没有编辑或保存文档，不把本次入口验收称为全部Office功能通过。临时Main inspector已关闭。载具错误如实保留：Playwright远程setInputFiles对50MiB包拒绝，改原生DOM.setFileInputFiles；更新成功后按钮仍有同名入口，等待detached超时，以catalog回读确认已提交，不重装；页签accessible name含关闭按钮导致exact匹配超时，改实际tab与iframe验证，产品无修订。

### 工作区入口与独立图标（2026-11-11，安装前记录）

- 六编辑器各自声明24x24线性图标，placement为both、scope仍workspace、最低SDK1.6.0。宿主删除安装应用的逐项左侧导航贡献，工作区列表／加号菜单／页签共用图标；应用管理入口及原独立路由保留。管理页对both优先进入工作区，空列表不再截断前六项，短窗可滚动。设计画板同步独立图标，未改文档业务或权限。
- 完整Renderer类型、SDK1.6构建／声明／tgz、真实贡献工厂和page描述符检查通过；7图标16/24px深浅主题Chromium独立渲染通过，截图已查看，非正式Profile验收。定向新逻辑lint0errors／原1refresh warning；services.ts仅版本变更，其原两处控制字符正则lint errors保留，不伪称全清。宪法§26四项门禁完成，SDK／插件声明两低冲突切片并发，主线程收口Renderer及验证；架构与知识库同步。
- Office包 `.scratch/office-functional-closure-20261111/matcha.office-workspace-icons.zip` digest `f33bbb8e5ed5a9896ca401ef1285d2492f85f1e9917d3b033620b62d2acd35b4`；Design包同目录matcha.design-workspace-icons.zip digest `9a64475a8ff1ca2f9a0f25ba337f5fa8e032b5c32fb0dc9d6377d1bdc4ab0313`。独立完整构建及canonical pack／Buffer读回／平台验包b1tr68gom exit0，peak2.256GiB／Job0，无强杀。SDK tgz为本地分发物；新包未安装、版本号仍原业务版本，不能直接作为同版本不同digest更新安装。真实Profile未操作，Host实际运行版本未更新，不声称界面已生效；下方structure-final等为本次之前工件。

### 请求级接口与资源解析收敛（2026-11-11，新包未安装）

- Slides动作不再靠全局runningAction改写window.slidesApi；每请求持三个窄编辑方法，直接注入原createSlidesSkill，原session仍核请求／文档／editor／工作path，删除无consumer的generation。HTML同次parse5遍历覆盖template.content，CSS MIME／GC共用编码路径URL；Sheets订阅即时交付当前语言，堵住Provider挂载前漏事件。Markdown本轮未发现新缺陷，未改。
- 命中宪法§26，四项门禁完成，未增Host业务／manager／第二writer。真实函数内联判据通过，完整类型／84登记及特殊严格overlay b934m1ycv exit0（peak2.897GiB），定向lint0errors／HTML既有2warnings。独立构建、canonical pack／Buffer读回验包及1053文件逐字节比对b2ths1v3l exit0（peak2.071GiB），均Job0／无强杀；上游2243文件未变。
- 最新工件 `.scratch/office-functional-closure-20261111/matcha.office-0.2.6-structure-final.zip`，digest `8f36e82b8df7cb7a04ef3b8f8433985334b6bc7c1678c11c9076c9137b469890`，1053文件／133253149内容bytes／52877352 ZIP bytes。未安装／操作Profile／提交；完整live动作链与GUI未验，不沿用旧包成绩。失败记录及输入指纹见implementation.md请求级接口节、source-structure.json、package-structure.json。下方integration-final及更早工件不包含本轮修改。

### 最后确认的五项接入续改（2026-11-11，新包未安装）

- 四处接入缺口及一处保存错误已落地：Markdown原手工隐去／恢复菜单与偏好；Slides URL插图／换图及受限脚本编辑，公开document_slides_action仅四项原算法，精确文档／editor／request／工作代回执；Sheets宿主语言变更同步原UI与后台；HTML快照与GC共用资源MIME遍历，递归无扩展名CSS不再丢图片。两独占模块并发实施，主线程共享登记／另外两项及最终验证，未新增Host业务、解释器或第二writer，§26四项门禁完成。
- 原Markdown标记序列化／解析／模型占位、Sheets原locale消费者、HTML CSS／ZIP原字节判据通过。Slides真实原图片handler配引擎／history及原解释器→原子事务→保存重开／撤销通过，传输与renderer rebuild部分边界隔离；完整live action信封／GUI未验，不伪报端到端。首次新增ai-ipc patch因CRLF严格apply失败，修LF后通过，未放宽校验。
- 最终全Office类型／严格overlay b6aq6bx9l exit0（peak2.838GiB），定向lint0errors／HTML既有2warnings，独立构建b5y79ilda exit0（peak1.823GiB），canonical pack／Buffer读回验包bltslp9ox exit0（peak0.364GiB），均Job0／无强杀。27工具schema严格编译通过；222输入见source-complete.json，上游2243文件逐字节不变。
- 当前工件 `.scratch/office-functional-closure-20261111/matcha.office-0.2.6-integration-final.zip`，1053文件／133253133内容bytes／52877412 ZIP bytes，digest `0c70883949f0b6fff91acbc646e374916ee1d44c8452f3c628adb6dc8a7b87de`。没有覆盖旧dist／已安装包、启动Profile、新增测试／probe、提交或推送。本节只确认这五项源码与工件收口，不是全部非打印功能实机签署；详细证据见implementation.md五项闭合节。

### 工程质量续改收口（2026-11-11，新工件未安装）

- 相对上一轮仅六个生产输入修订：Sheets选区关闭竞态与回调异常清理；HTML在原App关闭消费者区分写入成功与安全离开，资源收集使用HTML专用扫描，已有会话资源状态保留undo字节而持久／导出继续GC；Markdown资源计划复用原Wiki resolver，不再猜basename。未新增通用manager、Host业务owner或第二writer，宪法§26四项门禁完成。
- 生产函数内联判据通过；完整Office类型／严格overlay bq8i8y06j exit0（peak2.933GiB），五文件定向ESLint exit0，独立build-quality bog9f2290 exit0（peak1.858GiB）；canonical打包后Buffer读回／validatePlugin btihe2e1s exit0（peak0.261GiB），均JobActive0。初次读回误传平台参数导致失败，修验证调用后通过，未改产品充绿。全src既有lint问题未重跑或冒称清零。
- 新包 `.scratch/office-functional-closure-20261111/matcha.office-0.2.6-quality-final.zip`，1049文件／133233438内容bytes／52869298 ZIP bytes，digest `59d55c8ae5f1093085beb113674e950793ceea3655c6ea3151b8882a7bb13d1f`；source-quality.json绑定220输入。未覆盖旧包／dist、未安装／启动／操作Profile、新增测试或probe、提交／推送。内联DOM／I/O隔离不等于GUI验收，完整证据和失败记录见implementation.md工程质量节。下方functional-final是本次修订前工件。

### 全范围缺口实施收口（2026-11-11，新工件未安装）

- 用户批准后按七个独占owner实施，不重做编辑器。Docs入口／剪贴板／字体／Zotero确认／恢复／原件归档／读投影／图片／人工冲突覆盖及导入偏好；Sheets原生CSV／后台locale／文档动作／只读跨本与两阶段dirty快照；Slides稳定身份与name／测宽／媒体／保存flush；PDF产物／副本／语言／导航；Markdown原动作／资源GC与undo／Wiki／静态headless；HTML原动作／MIME传递／资源／单文件／预览快捷键均已落源码。详细状态、证据和限制见 `.scratch/office-functional-closure-20261111/implementation.md` 及各编辑器报告末节。
- 主线程额外修正真实application.open嵌套信封、HTML inspector的raw overlay消费、三个动作工具schema、关闭时先终结页面等待再drain。上游2243文件逐字节未变，82项登记无遗漏或重复，正式适配只经严格overlay；未新增测试／probe文件、Host业务owner或第二正文writer。命中宪法§26，读取边界／原owner／最终单一路径／旧错误路径清理均按功能块收口。
- 最终完整构建 `b06255vo4` exit0，peak1.861GiB／JobActive0；canonical pack＋Buffer读回＋validatePlugin `bnmk30zgt` exit0，peak0.354GiB／JobActive0。新工件 `.scratch/office-functional-closure-20261111/matcha.office-0.2.6-functional-final.zip`，1049文件／133235363内容bytes／52869515 ZIP bytes，digest `4629c24fd267f8998c9cd0af5a03e371444667a360249c96e2c3bdc8c4300b5e`。未覆盖旧dist、未安装。源码manifest72099bytes，构建只压JSON空白为30679bytes，合同deepEqual，未放宽64KiB验包门槛。
- 最终工件实际含`gx:keyCommand`正式inspector改动，renderer无Ajv依赖；生产backend注册26工具，真实native CSV原字节进出、前导零／`=literal`读取、单元格修改及stale CAS拒绝通过（bd4vwt90r，peak0.148GiB／JobActive0）。Docs真实split ESM图片插入／保存重开／ZIP媒体字节、Sheets真实native两阶段move-rows＋held definedName、PDF真实签名副本／dirty保源／拆分另有各owner证据，不是GUI。
- 最终全Office类型／严格overlay `bdk8r7wf7` exit0（peak2.977GiB／JobActive0／无强杀），覆盖最后session fence修订。全src ESLint仍exit1：唯一error是HEAD已存在store控制字符正则（no-control-regex），另7 warnings；本轮新增错误已清，未关规则或修改安全校验充绿。源码／文档diff-check通过，保留既有CRLF提示。真实UI、完整selection IPC／journal/dirty观察、Chromium转换成品、OS剪贴板／拖放、Mac及全部格式保真未逐项验，不宣称全功能实机通过。
- 本轮未启动应用、未操作Profile、未暂存／提交／推送。下方均为历史阶段记录，其旧缺口列表与旧构建成绩不覆盖本节实现。

### 逐功能闭环核对续改（2026-11-11，未安装）

- 六编辑器及公共链报告见`.scratch/office-functional-closure-20261111/README.md`，按入口→原实现→适配→consumer→保存／恢复／关闭核对。**当前仍有范围内接入差异及未核支路，不能签署完整移植；不是仅差实机回执。** 原样快照2243文件与固定checkout逐字节一致，额外matcha-sync.json是同步元数据。
- 本轮窄修：Docs邮件合并复用私有upload→consume内lazy媒体实体化→handoff后下载／ZIP；Sheets DSL补当前buffer的临时sourcePath；HTML仅已接受外改资源触发预览新快照，图片引用相对作者base；PDF bridge接Host语言事件及规范化、回放、取消与清理。没有改raw、Host、SDK或文库owner，没有新增测试／probe文件。
- Docs真实媒体算法、HTML代次／路径、PDF语言桥内联判据通过，均非真实UI回执；Docs传输为内存适配，Sheets实际sidecar公式行为未验。七个适配文件集中eslint exit0（`bjylmf6qu`，peak0.359 GiB／JobActive0），diff-check通过；当前全Office类型／严格overlay检查exit0（`bui4afwg5`，peak2.980 GiB／JobActive0／无强杀），覆盖本轮最终修订，未构建或安装新包。
- 未修项包括多页文件快捷键／文档拖放、部分文档算法consumer、资源清理与交付；Sheets真实locale须覆盖headless导入，Slides稳定身份须正式分离path／name，PDF转换须先补各目标打开consumer，PDF语言仅bridge部分修复。详细证据与未核项以各报告为准，不按差异条数算完整率。
- 本轮不操作Profile、不启动应用、不安装工件、不暂存／提交／推送。下面engineering-review包与已安装closure-final均不含本轮修订，其历史类型／构建／UI成绩不能覆盖本轮源码。

### 工程质量复核续改（2026-11-11，源码修订，未覆盖已安装包）

- 按宪法§26复核真实owner／调用链，不以`.patch`格式、文件长度或验收通过代替质量判断。正式overlay仍是唯一上游适配载体；raw genoffice不改，Host不新增Office业务owner。
- Docs上传准入原先在异步创建目录前检查，inline生产实现并发调用实收2项（约定1项）。现把检查移至目录就绪后的同步登记边界，并复用同一transferDirectory，关闭后不再登记上传／恢复文件；20轮×8并发、真实HTTP POST→consume、拒replay、后续上传、close期间目录清理均通过。初次完整Office上下文检查exit0／peak2.937 GiB，定向lint通过。
- HTML快照对无扩展名CSS／JS原返回octet-stream；现由唯一documentSnapshot按作者base和明确script／stylesheet引用确定未知MIME，预览／演示／转换共用，不改作者或资源字节、不在Host猜Office语义。inline覆盖base／query／hash、已知及二进制MIME、外部地址与未引用资源，通过；定向lint0 errors，原有2项any警告保留。
- HTML资源确认现区分明确本地新增与已提交基线，read不提前推进基线，ack整体接纳该代name／path／revision／resources；后台observed同样持完整Binding。原删除资源被保存复活已inline复现，修后生产bridge→session链覆盖dirty／CAS、keep-mine、本地新增、保存中新增及精确ack，通过。未新增测试文件，未复验这些修订的正式UI。
- PDF原生默认名称不再取临时backing basename，由RuntimePaths直接读取既有binding业务名；redaction／compare／reduce／sign共用，不搬动物理文件。页面以单份`{id,name}`投影替换旧namedFile补偿，原view-state store以稳定documentId保存／恢复。实际consumer表达式修前默认Untitled、修后Budget；原view-state函数跨临时路径恢复page7并隔离其他document，通过。仅改session与四份既有正式patch，源hash／strictapply与定向lint通过；未改偏好关闭失败语义。
- ready对懒图片的潜在等待问题仅静态线索，未确证运行失败，本轮未改；偏好落盘失败是否允许关闭涉及既定数据语义，也未以“辅助功能”为由吞错放行。
- 最终集成Office全上下文typecheck `b9v24rrxe` exit0，peak3.612 GiB／JobActive0／无强杀，含全部严格overlay。独立完整构建 `bh6kgkmsc` exit0，peak1.861 GiB，1027文件／134368453内容bytes，未覆盖原dist。canonical pack已写出新ZIP；首次读回命令误传Uint8Array（reader合同为Buffer）失败，改用readFile原Buffer后 `b20i7p3s2` 验包通过，peak0.270 GiB。工件 `.scratch/office-complete-20261111/matcha.office-0.2.6-engineering-review.zip`，53746359 ZIP bytes，digest `a5ac7ae0d50add323378f583cc7bb0482d277c62f905bce832e1fbc11cec5902`。
- 以下已安装digest与UI成绩只属于此前closure-final工件；上述新工件未安装、修订后正式UI未验。源码／文档diff-check与patch外层空白检查通过，raw genoffice／test／e2e／tests未改；未新增测试、暂存、提交或推送。

### 当前 Profile 正式 UI 回执（2026-11-11）

- 用户明确授权接管既有真实 Profile 后，经正常应用管理界面更新到 Office 0.2.6；catalog revision27，digest `68f7198dbed53b04881682d6021b3ee94f49a4e73a15efc4993ed6560265cab6`，最低 SDK1.5.0。未另起实例、未杀进程、未调用模型。
- Markdown→Docs 正常页面导航通过；目标 singleton iframe 未重建。Docs dirty 替换时“取消”保留修改，“保存修改”后原稿 revision1 的 OOXML 含 `DIRTY_KEEP_1111`，随后目标新稿正常打开。放弃／关闭 guard 分支未在本次补验。
- HTML 经正常多文件 picker 导入 index.html／main.mjs／data.json／pixel.png，真实独立 scheme 的 module、fetch、图片均200，MIME 分别为 text/javascript、application/json、image/png；页面显示 `DYNAMIC_UI_1111_VERIFIED` 和40×40图片。源码编辑 Ctrl+S 后库 revision1，原文与期望逐字一致、三资源原字节不变；从文库重开保留修改。新标签页演示显示同一动态结果，已关闭该自有演示窗口。
- HTML 正式 UI 导出并完成原生另存为：PDF 用 pdfjs 读到动态标记；Word 的 word/document.xml 含动态标记且无 LOADING；PNG 2880×1800，红块28800像素／绿图6400像素；HTML ZIP 的正文及三资源与导入原件逐字节一致。实际文件保存到用户下载目录 index.pdf／index.docx／index.png／index.zip，并以不覆盖方式复制到 `.scratch/office-complete-20261111/ui-exports/`。最初漏看原生保存弹窗，用户指出后立即完成；此前无下载回执不应归因为产品卡死。
- Slides 正式 UI 插入上游已知 H264 样本，画布可见真实彩条封面及播放标记；点击保存按钮后文库 `doc_4326b0a661864a2d` revision1。PPTX 媒体原字节一致，封面 PNG SHA256 `4b55212c9a3269ec7c0457171e26362619887f9dc9786d21b8f54d9a1f7dff18`，image／video／media关系齐全；文库重新打开后封面仍可见。证据 `closure-slides-ui.json`、`closure-slides-video.png`、`closure-slides-video-reopen.png`，不代表其它 codec／录屏／双屏已验。
- HTML截图 `closure-html-dynamic.png`、`closure-html-presentation.png` 与上述 Slides 截图均已实际查看；未伪造焦点或生命周期。CDP连接可能改变可见性，驱动时用已核实原生窗口真实前台，不将驱动时序／隐藏等待冒充产品缺陷。下载行为已恢复默认，picker拦截已关闭；未删除验证文档或下载产物。
- **仍未全量实机闭合**：512 MiB 整件 Docs、headless 大件、PDF 页面副本／复杂编辑与普通保存命名的正式 UI、其它视频 codec／双屏及其余未逐项执行的非打印交互。此前算法／生产链证据不冒充这些 GUI 回执。

### 最终源码与工件回执（2026-11-11，已安装，UI 范围见上）

- 六个并发切片均已完成实现并释放；遵循宪法 §26，读取边界、真实 owner、最终单一路径及旧整件正文传输清理已复核，raw genoffice／既有测试未改，没有新增测试文件、暂存、提交或推送。
- SDK build／pack `bc7xyh1w9` exit0；Renderer tsc `bp82n0i4d`、Electron tsc `bse33mc6t` exit0；Office 全上下文 `basyg0y6k` exit0，冻结后末次 `bpmrsy5u3` exit0，peak2.981 GiB／JobActive0／无强杀。真实应用 Main／preload／Renderer 构建 `bowhw744f` exit0。
- Docs 最后生命周期修订后完整 Office 构建 `br081a80s` exit0，peak1.929 GiB／JobActive0；1027文件，内容量见 `artifact-closure-final.json`。明确指定既有 sidecar 与 OCR binary，未改上游或重新下载依赖。
- canonical SDK 打包→wx写盘→按精确digest读回→`validatePlugin` 通过（`b5dunhj7w`，peak0.482 GiB）：`.scratch/office-complete-20261111/matcha.office-0.2.6-closure-final.zip`，53746015 ZIP bytes，digest `68f7198dbed53b04881682d6021b3ee94f49a4e73a15efc4993ed6560265cab6`，最低SDK1.5.0。早于末次构建的 `closure.zip` 仅中间态，勿安装它。
- **接管前的历史状态**：既有开发实例已占用9222／5173，故未另起实例、未杀进程；曾因界面并发操作暂停GUI。随后用户明确授权接管，已正常安装并取得顶部正式 UI 回执，此前“未安装／仍为0.2.5”不再是当前事实。运行内404只证明资源protocol新分支，不能证明整份Main源码指纹。

### 剩余闭环续做（2026-11-11，源码已实现，实机范围见上）

- 系统地区已由 `desktop.systemLocale({})` 接真实 Electron `app.getSystemLocale()`，Docs 原纸张选择 consumer 不再以 navigator 代替 OS；真实 Electron owner／service dispatcher 均核得 `zh-CN`。
- PDF 普通保存自动命名已接明确持久 `autoNamePending`，只在缺省名称创建空白 PDF 时设置；显式名称／导入／副本不猜未命名。库 CAS 与唯一名称同索引事务，native backing path 不变，原 UI 仅投影已提交名称。真实 PDFium 文本写入、保存、命名、再次保存、重开与冲突保护已有生产链证据，非 GUI。
- Documents 文件输入复用唯一 `commitContent`，`copyFile` stage 后同索引 rename 提交；只读 hardlink snapshot 在原件更新／删除后仍有效。64 MiB 文件禁整件 read 的 create／update、资源保留、snapshot 生命周期及取消验证通过。
- Electron 全量类型检查 `ba5y0226j` exit0，peak0.928 GiB／JobActive0；原 cloud-account Web／Node stream 类型阻塞已按平台类型边界修复。Renderer 完整类型检查 `bp82n0i4d` exit0。
- 真实 H264 codec 已在 Electron 44.10.0／Chromium 152 的可见独立窗口核验生产视频封面：960×540 PNG、976042 bytes、175441 种像素颜色；真实 PPTX addMedia→save→reopen 核媒体／封面 SHA 与 image／video／p14 relations，通过且原视频未改。不使用焦点／生命周期模拟，不代表正式 Office 插入 UI 或其他 codec 已验。
- HTML 当前正式 overlay worker＋生产 Host 的真实 Electron 三格式验证通过：作者 `base=assets/`、module import、runtime fetch、运行时图片共同生成动态结果；PDF8630 bytes 左右的产物经 pdfjs 读到 `DYNAMIC_RESOURCE_VERIFIED`，PNG经 sharp 核红色块与绿色运行时图片，DOCX XML含动态结果且无初始 `LOADING`。原静态 html 路径回归保作者脚本不执行。各产物精确大小随 PDF 元数据变化，不以大小替代内容判据。
- Docs lazy 二进制传输已完成真实 opaque iframe 53 MiB POST／媒体 img／Blob Worker fetch，生产 store＋session 验证53477637 bytes→347 bytes→原件大小，并覆盖二次保存、CAS拒绝、取消及新 session 恢复后媒体一致；该 inline 多副本 maxRSS866032 KiB，不声称原 materialize 算法全程流式。最终生命周期修订后集中检查与新工件均已通过，精确回执见上。
- 独立自包含 conversion worker 已严格 overlay 编译通过（`bvn66mwbu`，689231 bytes、0 imports），此项只证明构建闭包。动态 DOM 与真实 Profile UI 的独立回执见顶部；以下旧工件记录仅作历史基线。

### 源码/API 对照后的缺口修复（2026-11-11，最低 SDK 1.5.0，未安装）

本轮按六编辑器原生 producer→preload→renderer→适配→Host／文库对照，不以 API 数量充当通过率。1501 个快照文件双向清点及 SHA 一致；AST 清点 632 个原生 API，分类后 420 个属于文档范围，但不代表 420 项已验证。

- Docs：URI 仍是身份，只解码显示名；原 quickActions 接 guarded 新建；恢复副本解密失败回原稿并保留副本；首次 `context.data.documentId` 与后续 `application.open` 进入原替换确认／密码／提交链，语言事件接回原 listener。
- Sheets：本地选择在后台保原来源，私有 `sourcePath` 与正文共用索引原子提交，公开 record 不含本机路径；相对外链用临时 native 读取视图解析，显式选择文库源才写 opaque 文库 URI。links／tabs／跨本选区共用文库身份，不按 basename 猜源，不重写原公式。
- Slides：选择、拖入和录屏视频共用 Blob→HTMLVideoElement→canvas 封面路径，连既有 `addMedia` 的 poster 能力；解码失败保原占位和格式警告，不建 Host 视频平台。现有正式入口为 application singleton，不扩多编辑实例。
- PDF：无 OCR helper 返回 `null`，单张识别失败返回 `[]`，原批量流程因此能区分 noEngine 并继续后续页。
- Markdown：文库加入 TXT／JSON，沿原文本模式保存，保 BOM／CRLF／扩展名；Wiki 只索引 Markdown。远程图片改走原后台 SSRF／有界读取／MIME 链，DOCX 生成入库后使用真正应用页导航，不恢复自备图床。
- HTML：位图读取复用原签名探测；预览与演示改只读、可撤销、每快照独立 URL 根的文档资源，不改作者 base／脚本相对路径、不放开 same-origin。资源与原文归档导出保原字节；PDF／PNG／Word 仍是原安全静态转换路径，不能据此认领运行时脚本结果一致。
- SDK 1.5：`openApplication` 复用原 WorkspaceProvider／controller 与原关闭 guard；`documentResources` 只服务获授权 frame 的输入快照，不读本机路径／邻居目录。开发及分发 SDK archive 路径同步为 1.5.0，旧运行中 Host 不自动获得新能力。

**已取得的独立证据**：Documents 生产 store 的 TXT／JSON 原字节、私有来源同提交、CAS／abort／公开投影验证通过；Docs 实际保存 updater／guard／OOXML 加密恢复通过；Slides 真实 PPTX 引擎的媒体及封面 parts／relations／保存重开通过；PDF 实际 Windows OCR helper 经生产 session→tools→原批处理通过。Sheets 实际 sidecar 验证原相对源结果 37、显式文库源结果 91，canonical ZIP 原字节和公式不变。Markdown 原 source serializer 的三文本类型 BOM／CRLF 保存及后台远程图片／SSRF边界通过。上述是相应生产函数／原算法证据，不是 GUI 实机验收。

**当前检查记录**：SDK 1.5 build／pack exit0（`bdaw2jorg`，48 文件，peak0.394 GiB／JobActive0）。全部已登记 overlay 严格 SHA／apply 校验通过，23 项工具 schema strict 编译通过。首轮 Office type 检出新增 DocumentType 的 PDF 目标收窄与 Markdown image loader 类型问题，已按真实合同修正；首轮 Renderer 检出资源响应类型收窄错误，修后完整 Renderer tsc exit0（`b0mbw75la`）。Electron 首次检查命令误禁 composite incremental，修正命令后检出资源 owner 两处类型收窄和既有 cloud-account ReadableStream 错误，资源 owner 已修；最终集中检查／构建结果后补，不把历史通过项覆盖本轮。

**仍有限制**：文档传输／解码目前 50 MiB，不能等同上游 Docs 512 MiB lazy open；`getSystemLocale` 仍来自 navigator，不等同 OS locale；PDF 普通保存自动命名没有明确系统未命名来源，不按文件名猜事实。HTML opaque scheme 的真实 module／fetch／可视演示、六页跨页与 dirty 操作、真实视频 codec 和全部非打印交互仍未实机验收。本轮未安装、未启动或重启日常 Profile、未新增测试文件、未暂存或提交，不能宣称完整功能 100% 对齐。

**集中检查补充**：完整 Office typecheck `bcfj6x9mc` exit0，peak2.885 GiB；完整 Renderer tsc `b0mbw75la` exit0；Electron 重跑 `bcrnmv8ag` 仅余既有 `electron/main/cloud-account/client.ts:241` ReadableStream 错误，完整检查仍失败，本轮资源 owner 类型错误已消除。完整 Office 构建 `bj47mmt33` exit0（1027 文件／134,351,570 bytes，peak1.886 GiB），后续 Sheets 同源绑定与 HTML base 图片链又作确证收口，因此该次仅记中间态，最终工件结果另记。HTML 本地 authored base 图片读写已接标准 URL，新资源用根相对引用；外部 base 本地图片编辑显式拒绝、不修改资源。真实 scheme／opaque iframe 仍未验。

**最终工件（冻结后）**：Office win32-x64 完整构建 `bsl3be9dt` exit0，1027文件／134,352,370内容bytes，peak1.880 GiB／JobActive0／无强杀；canonical SDK pack→写盘→按digest读回→Office `validatePlugin` 均通过（`bj0pnoqvt`，peak0.476 GiB）。输出 `.scratch/office-complete-20261111/matcha.office-0.2.6-api-parity.zip`，ZIP53,740,587 bytes，digest `3d63ae8151b0fc10719ede63a492817d62f5149f5c0f7a789bbf490dd12954d8`，最低SDK1.5.0。最终 SDK build／pack `bs73rcas9` exit0（48文件）；冻结后的 Renderer tsc `bbvzg0cr2` exit0。源代码／文档diff-check与正式patch严格apply通过；本轮新增共享链与已收口编辑器文件的定向lint为0 errors；包含更大既有文件范围时仍报store既有control-regex错误，另有混合export形态FastRefresh及资源投影any警告，未改规则绕过。最终Office全上下文类型检查 `byob8qh3c` exit0（peak2.944 GiB／JobActive0／无强杀），覆盖全部六页／后台／worker与正式overlay，包含最终nonce预览生命周期、base图片和Sheets同源收口。未覆盖根build分发旧包、未安装、未启动／重启日常Profile、未暂存／提交。

以下 1.4 及更早阶段保留为历史，不代表本轮当前实现／工件。

### 0.2.6／SDK 1.4：遗漏补齐与结构纠偏，尚未完成（2026-11-11）

**实现**

- manifest 为 `0.2.6`、`minSdkVersion:"1.4.0"`；仍为六编辑器、12 public／11 app-only。正式后台 `context.desktop.openExternal/revealFile/pickFile` 经既有 CJS／stdio 通用服务；UI 不直接取得本机路径／任意 Host。Workspace 仍只接受显式目标与相对路径，desktop 为可信后台的本地选择／定位能力，不是 OS 沙箱。[VERIFY: apps/office/manifest.json:4-7] [VERIFY: sdk/app-plugins/src/services.ts:132-162] [VERIFY: electron/main/app-plugins/desktop.ts:18-46]
- 新 `settings/store.ts` 单 owner 持 `app-settings.json` 的文档页面主题、默认自动保存、作者名，沿 `office:settings:get/set` 与 `office.settings.changed` 同步。`browser-preferences.json` 按六编辑器 namespace 恢复原 `localStorage` 偏好；六 entry 先 hydrate 再动态加载 page，headless／`sessionStorage` 仅内存。受控正常 close 等待偏好写入，强退不保证末笔落盘；六页 close 已接等待，仍须实机验证。[VERIFY: apps/office/src/settings/store.ts:9-74] [VERIFY: apps/office/src/activate.ts:44-62] [VERIFY: apps/office/src/platform/browser-preferences.ts:7-67] [VERIFY: apps/office/src/platform/browser-storage.ts:4-48] [VERIFY: apps/office/build.mjs:343]
- Docs 页面与 headless 接真实字体度量，headless 字体读取串行避免超过 Host 并发限额；Sheets 外链选源向 UI 返回 opaque token，后台保存时替换真实 file URL，并复用 desktop 定位原件／打开外链；Slides 剪贴板探测保 unknown，不假称可读，复制持随机 metadata token 并回读核对。[VERIFY: apps/office/src/docs/session.ts:40] [VERIFY: apps/office/src/docs/headless-worker.tsx:43-50] [VERIFY: apps/office/src/sheets/session.ts:226-245] [VERIFY: apps/office/src/sheets/session.ts:354-362] [VERIFY: apps/office/src/slides/bridge.ts:154-174] [VERIFY: apps/office/patches/genoffice/apps--slides--src--main--slides-main.ts.patch:83-86]
- 文档外链、Markdown Ctrl+K／主题及 PDF 指定衍生产物入库后自动打开已接源码；PDF 只对上游明确标记的 generated path 发打开事件，不把全部输出泛化自动打开。[VERIFY: apps/office/patches/genoffice/apps--markdown--src--renderer--components--Ribbon.tsx.patch:136] [VERIFY: apps/office/src/markdown/bridge.ts:39-77] [VERIFY: apps/office/src/pdf/session.ts:44-53] [VERIFY: apps/office/src/pdf/session.ts:130-145]
- **Markdown→Docs“在 Docs 打开”未完成**：本轮尝试的独立 presentation 窗口存在确定生命周期缺陷（窗口关闭未接 dirty guard，来源页关闭会销毁窗口），已决定撤回，不能当作原壳 tab 导航或仅 GUI 待验。需要真正应用页导航 owner，本轮不扩 Host 平台；DOCX 导出仍与此动作分开。
- **范围不变**：只排除物理打印／打印机选择和上游 Markdown 自备图床上传；本地图片／资源、PDF 导出保留。上游独立 AI／provider／账号／桌面壳／CLI／MCP 入口不启动，不能称其它能力已无遗漏。

**工程质量纠偏（2026-11-11）**

- 问题不是正式 `.patch` 格式，而是适配实现绕过真实 owner：Docs／Slides 原设置入口依赖 `querySelector('.ribbon-tabs')`＋portal；HTML／PDF 原外链覆盖全局 `window.open`，PDF 另捕获整页链接。现入口为 `page → App.trailingActions → Ribbon`；外链为 HTML 已校验版本的 handler → 显式回调、PDF OutlinePanel／LinkLayer → `pdfApi.openExternal` → 既有 preload／session → desktop。旧 DOM 外挂与全局拦截已删除，不新增通用 slot 或导航框架。[VERIFY: apps/office/src/docs/page.tsx:29-63] [VERIFY: apps/office/src/slides/page.tsx:34-65] [VERIFY: apps/office/patches/genoffice/apps--html--src--renderer--App.tsx.patch:278-289] [VERIFY: apps/office/patches/genoffice/apps--pdf--src--renderer--LinkLayer.tsx.patch:15-27] [VERIFY: apps/office/patches/genoffice/apps--pdf--src--preload--index.ts.patch:14]
- 内联生产模块先复现“写 A 失败 → 写 B 成功 → close flush 错误放行”，再修为按 key 保留失败；只允许同 key 后续成功或成功 clear 解除对应失败，失败 clear 不能被普通 set 掩盖。不加自动重试／第二套写队列。[VERIFY: apps/office/src/platform/browser-storage.ts:9-33]
- 设置三项语义偏好与编辑器浏览器偏好保持各自唯一 owner，不为统一目录强行合并。Markdown→Docs 独立窗口方案因 dirty／关闭生命周期不符已撤回；缺口仍明确保留，不以 API 接通或类型通过宣称完成。
- 最新完整 Office 类型检查 exit0（`bs6lgxbz7.output`），涵盖全部正式 overlay 与后台／六页／worker；peak2.977 GiB、JobActive0、无强杀。内联真实外链 handler→bridge／preload→session 验证版本拒绝、协议拒绝、内部目的地、左／中／右键与错误传播通过；不是 GUI 验收。
- 最新完整构建 exit1（`bd6bdjzkp.output`）：1021／1024 文件、134,328,564／134,217,728 bytes，仍超110,836 bytes；报告 `.scratch/office-complete-20261111/artifact-026-quality.json`。保持原上限、undici7、资源与功能，未安装0.2.6。旧包与旧类型检查成绩不覆盖本次结果。
- 源码 whitespace 检查通过；正式 patch 经严格 apply 校验通过。外层默认 `git diff --check` 对 patch 新增的必要空白上下文行会报 trailing whitespace，未剥除 unified diff 前缀；仅对 patch 文件用 `core.whitespace=-blank-at-eol` 检查。上游 raw、既有测试未改，无新增测试，未暂存／提交。

**首个提交适配代码复核（2026-11-11，基线 `e19b5d0a`）**

- 范围是首个提交中的 Office 自有适配、正式 patch 与构建，不是仅本窗口新增 diff；保留当前未提交改动，不回滚到历史源码。
- 确证交付合同错位：`copyJsdomTree` 已将共享图降为 CommonJS，生成 `api-bundle.cjs`／`xhr-sync-worker-bundle.cjs`，但 `validatePlugin` 仍要求 `.mjs`。`scripts/bundle-app-plugins.mjs` 在打包及复验均调用它，故实际正确包也会被拒绝。首提与当前源码均存在此错误。[VERIFY: apps/office/build.mjs:412-420] [VERIFY: scripts/bundle-app-plugins.mjs:54] [VERIFY: scripts/bundle-app-plugins.mjs:72-75]
- 直接将两项必需路径改为实际 `.cjs`，不接受双后缀、不新增兼容层。用 canonical SDK 读取历史真实 `matcha.office-0.2.5-twelfth.zip`：修前实际报缺 `api-bundle.mjs`（exit1），修后同包通过；内存移除任意一个必需 `.cjs` 均仍被拒绝（exit0）。`node --check` 与 build 文件 diff-check 通过；另外直接执行当前 `copyJsdomTree` 在 owned 临时目录生成实际依赖图，确认两份 `.cjs` 存在且真实 JSDOM 入口可创建／读取DOM，exit0（`b0jzat1ky.output`），已清临时目录。另核根 `build/app-plugins/win32-x64/matcha.office.zip` 实为0.1.9，缺当前必需依赖，验证失败；未覆盖或冒称该旧分发包已更新。该结果只证明验包合同，不证明0.2.6体积、完整打包或GUI通过。
- 本次整体判断：保留 Documents 唯一写库／CAS、编辑器各自会话、Host 通用能力与严格上游 overlay；没有为代码长度或 patch 数量重构。确证缺陷集中在临时路径与业务身份、恢复来源与 backing 状态、提交事实与后续通知、真实产物与验包合同的混淆，修复落在各自 owner，不加并行兼容实现。
- 复核另确证 Slides 随机工作路径导致恢复键漂移、Sheets 恢复来源标志与 backing 文件语义混用导致后续恢复 tick 跳过，以及 PDF 固定输出目录按路径永久去重导致第二次同名拆分结果漏入库；三项均见首提与当前源码，现已在各自owner内修改；不把函数级复现／受控边界验证当作真实应用异常退出／重开验收。
- PDF 已改为每次生成操作独立输出目录，以待扫描目录／待提交文件记录该代生命周期，移除永久路径去重；入库提交后立即确认该文件，绑定刷新与打开通知失败只记录，不重导或回滚。内存执行实际 `native/commitOutputs`＋上游 `splitPdfBytes`＋`pdf-lib`：四页PDF先split1后split2，库中为4×1页＋2×2页；二扫不重复；第二份导入失败后重试只补剩余三份；提交后binding／通知双失败仍保两份结果且不重复。未新增测试文件，不代表GUI通过。[VERIFY: apps/office/src/pdf/session.ts:131-163]

- Slides／Sheets 两项已实现：Slides恢复producer／lookup／clear统一稳定文库身份，临时工作路径仍独立，恢复确认复用上游多语言与应用内选择，不再依赖假Electron dialog；关闭／取消／退役先结算恢复等待再drain，清理等待在途恢复写。Sheets将恢复来源与实际backing分开，保留恢复后强制写回，同时独立backing允许后续30秒恢复tick。第一轮完整Office类型检查exit0（`b4g691qmf.output`，peak2.972GiB／JobActive0）；最终显式放弃事务调整后重新检查，成绩另记。
- 恢复内联关键验证通过：实际session转译＋正式overlay原生恢复owner＋真实临时文件；稳定key、恢复metaDirty、CAS失败保恢复、在途写入后清理、save-as身份及prompt取消／close／beginClose／重复dispose。引擎与提交hook是受控边界，不冒称真实PPTX或GUI崩溃恢复。Sheets真实scheduler新backing=false启用、standalone true仍跳过，原强制写回表达式未改。
- 显式放弃不提前删除恢复副本：只登记本次leave意图，成功replace／new-blank／close且旧session退出恢复producer后再清理；替换取消／失败、关闭abort／错误则取消该意图，保留旧稿和恢复，不伪造dirty已清。该事务末次内联验证与集中检查另记。[VERIFY: apps/office/src/slides/session.ts] [VERIFY: apps/office/src/slides/close.ts]
- 首提纠偏切片后的完整构建已运行，exit1（`bmo4dwc2w.output`）：1021／1024 文件、134,331,529／134,217,728 bytes，超113,801 bytes，报告 `.scratch/office-complete-20261111/artifact-initial-quality.json`。保持原门槛与全部资源，未安装新包。此结果覆盖本次恢复源码冻结，类型与内联验证另记。

- 最后冻结全上下文Office类型检查exit0（`b2gfrbc8t.output`，peak2.980GiB／JobActive0／无强杀），同时严格校验全部正式overlay。源码空白／build语法检查通过；patch外层必要上下文单空格说明不变。上游raw／测试目录无改动，未暂存／提交。
- 最终leave事务内联验证通过：标记discard不立即删恢复、取消意图后close保恢复、成功替换清旧恢复、显式discard＋close后再tick不重建。最后冻结完整构建仍exit1（`b6hoursce.output`）：1021／1024文件、134,331,860／134,217,728 bytes，超114,132 bytes，报告 `artifact-initial-quality-final.json`；不放宽上限、不裁功能，未安装。真实iframe恢复选择、完整PPTX引擎／sidecar及应用异常退出重开仍未验。

**公共包限额调整（2026-11-11）**

- 用户要求整体增大并再次调大，最终统一为 ZIP 256 MiB、解压总量512 MiB、单文件384 MiB、4096文件。`sdk/app-plugins/src/limits.ts` 为浏览器／Node 同一事实源；package 入口保留原导出，Renderer 导入校验及四语言提示共用常量，不给 Office 特例。manifest／schema 预算与路径、CRC、有界解压等校验不变。[VERIFY: sdk/app-plugins/src/limits.ts:1-4] [VERIFY: src/plugins/application-plugins/AppPluginManager.tsx:118-119]
- SDK 1.4 build／pack exit0（`bm1ug6lv5.output`）；Renderer 完整 noEmit exit0（`bflfdu6a7.output`），定向 lint／diff-check 通过。公共 SDK 与 package 导出值一致，browser bundle／四语言插值验证通过。共享常量／消费者依赖紧密，本轮单 owner 修改，未启动额外代理。
- Office 完整 win32-x64 构建 exit0（`bcakvchph.output`，peak1.854 GiB／JobActive0／无强杀）：1021／4096文件，134,331,860／536,870,912 bytes。报告 `artifact-raised-limits.json`；与此前最终失败构建的文件数／内容字节完全一致，未裁资源。
- canonical SDK 真打包、写盘读回与 Office `validatePlugin` 均通过（`bcoblvzre.output`）：`.scratch/office-complete-20261111/matcha.office-0.2.6-raised-limits.zip`，ZIP 53,730,424 bytes，digest `d4985079ffbb2af6ea642ca7f830941ebbef0228dd02b37b2aca4a29e34fe79f`。4096文件实际接受，4097文件拒绝，声明单文件超384 MiB在解压前拒绝；未新增测试文件。
- 原上限失败记录保留为历史；当前体积阻塞已解除，不代表完整功能交付。未安装、未重启当前Profile、未提交；已运行旧Host不因源码变化自动生效，GUI及真实崩溃恢复仍未验。

**验证（此前主线程回执，保留历史结果）**

- SDK 1.4 build＋pack 通过，undici `7.24.7` 离线同步成功。
- Node 本地 HTTP 已验证 undici `Agent`／pinned lookup／fetch／`EnvHttpProxyAgent`／`ProxyAgent`，并验证生产 SSRF 拒绝；不是外网、系统代理或 Electron 实机验证。
- Electron 全量 tsc 仅余既有 `cloud-account/client.ts:241` ReadableStream 类型错误，**完整检查失败**。

**未验／限制**

- Office 0.2.6 首次完整构建已执行但**包门槛失败**：1032／1024 文件、135,383,267／134,217,728 bytes；该次临时输出自动清理，未安装0.2.6。不放宽上限或裁功能；后续入口顺序／去重与首提纠偏构建结果分别保留在上文及下一项。
- 结构纠偏前的去重构建**未通过字节门槛**：1021／1024 文件、134,328,672／134,217,728 bytes，超110,944 bytes；文件数量已合规，undici7保留。最新结果见上方工程质量纠偏记录，不放宽门槛、不裁资源，0.2.6 未安装／未交付。
- 结构纠偏前 Office 0.2.6 全上下文类型检查通过：exit0，peak2.972 GiB／JobActive0／no kill，日志任务 `bxly7htx8.output`。最新类型检查另见上方记录。GUI 未验，不借0.2.5或更旧成绩认领。当前 CDP `127.0.0.1:9222` 为 `ECONNREFUSED`；未重启应用或修改 Profile，不推断当前窗口状态。
- HTML 动态相对 imports／fetch、PDF 四项页面操作／副本／OCR／复杂操作、Slides 媒体／双屏、各格式真实导出落盘仍未验；新增设置跨页／关闭持久化、字体与外链／剪贴板等也不能仅凭源码称实机通过。

### 0.2.5：已装真实 Profile，Sheets／HTML 复核通过（2026-11-11）

用户 Profile 已安装 0.2.5（digest `857d9595f3b75c92737fe303fb245bd0f833df5d96baccde995debdd77e0d6e6`）。0.2.5 包含两处实机缺陷修复：

1. **Sheets 挂载即失败**：`sheets:mcp-ready`／`sheets:mcp-result` 是原 App 的单向通知，无外部 MCP caller。`session.ts` 在 disposed 与 channel 非空校验之后、任何 editor／native／lifecycle gate 之前直接 `Promise.resolve(null)`，既不依赖首次挂载时序，也不吞真实 invoke 失败；session 关闭后仍拒绝。
2. **Slides 退出放映销页**：见 0.2.4 段落，`setShowFullScreen` catch 降级为 `console.warn`。

HTML 源码“保存污染”已撤回（自动化逐字符键入＋autoCloseTags），不进此包。六页完整验收、原生交互与模型闭环仍未完成。

**已装真实 Profile（digest `857d9595…`，经应用内“更新插件”正常安装）后复核：**

- **Sheets**：页面挂载即出完整工具栏，不再报 `sheets:mcp-ready`；真实 UI 打开 `doc_2a8327cdf8ef414c`（由 `document_create` CSV 生成），点击单元格 `Input.insertText` 写入 `0.2.5 验收值`，点“保存”后公开 `document_read` 读回 `revision 1`、`D1 = "0.2.5 验收值"`。cells A1/B1/A2/B2 仍为 `a/b/1/2`。
- **HTML**：打开 `doc_ffda05de713d49f6` 切到“源码”，鼠标点入 CodeMirror → `Control+a` → **单次 `Input.insertText`** 整段替换 → `保存 (Ctrl+S)`；公开 `document_read` 读回 `revision 1`、正文 92 字节**逐字等于**输入串，无多余闭合标签。反过来确认了 0.2.4 那次“污染”是我的逐字符键入叠加 autoCloseTags，不是保存链缺陷。
- 观测前提记录：CDP attach 的页面初始 `visibilityState === 'hidden'`，`requestAnimationFrame` 不触发，`canLeaveWorkbook` 内的 `requestAnimationFrame` 会永久挂住“Opening workbook…”。必须先 `Emulation.setFocusEmulationEnabled` + `Page.setWebLifecycleState: active`，否则会把自己的观测环境误判成产品缺陷。

### 2026-11-11 补充验收（原 Profile／已安装 0.2.5）

本轮证据目录 `.scratch/office-complete-20261111/`；下述 gateway 验收是工具与独立内容判据，不冒充模型或页面验收。

- **Host 工具边界通过**：catalog 实际仅暴露 12 个 Office public tools，11 个 app-only 全部不在模型目录；逐一构造 app-only 直调均返回 404。12 个 public 入口均有实际调用（不代表所有参数组合穷尽）；delete 只删本轮专门新建的空白 MD，删除后 list 不含且 read 返回 `not_found`。证据 `catalog-boundary.json`、`summary.json`。
- **Sheets 后台业务通过**：真实 native read 多类型 grid（布尔、数字、小数、空值、中文换行引号、前导零）；公式 `A2*B2=42`，原件 XLSX OOXML 同时含公式与缓存值；旧 revision CAS 拒绝；非法编辑后原稿 SHA 不变；副本独立；CSV 内容正确；XLS 图片／合并／列宽和 ODS 跨表／绝对引用计算正确。主线程独立检查 OOXML 与 CSV。证据 `sheets/summary.json`、`sheets/evidence.json` 及原字节文件。XLSM 因无现成授权宏样本未验。
- **资源与转换**：MD／HTML create/read/edit/write/export 保留资源及 CAS 通过；MD→DOCX 嵌图原 SHA 一致，MD→HTML 内嵌图片，HTML→MD 保留资源；MD／HTML→PDF 独立解析一页且抽出正文标记（25,672／16,583B）。HTML→DOCX 初次 1px 微图未进入结果；同一有效图片显示为 64×64 后 DOCX 含 media 与 drawing。只能认定普通可见图片通过，微图有尺寸／可见性限制，不能宣称无损转换，也未证明是迁移回归。历史初次输出保留。
- **PDF 后台通过**：无密码／错密拒绝，正确密码读到正文，同格式副本加密字节完全一致；一次 render 返回 page=1、596×843、3,920B PNG。证据 `pdf-password-render-copy.log`。
- **Slides 放映退出通过**：0.2.5 从头放映→Escape 后 iframe 和 3 个 canvas 保留、无 pageerror、无错误对话框且可继续点插入。仍存在 foreground/fullscreen/confirmation-owner warn，未隐去。证据在前一目录 `slides-evidence/ui-025-show-exit.json/png`。
- **HTML 页面通过**：重新打开源码与已保存 92B 完全一致；正常点击导出 HTML／PDF 实际进入原 API 并生成 blob（92／27,293B，PDF 头正确）。**下载未通过**：Browser 事件收满后 canceled、目录空。保存下来的 `evidence-generated-only.*` 只是生成字节证据，不代表下载落盘。
- **模型 Office 业务闭环通过（用户完成原生审批后）**：gpt-6-luna 正常口语任务实际调用 `document_create`／`document_convert`，两次工具结果均 completed／isError=false，原生审批均 resolved。创建 DOCX `doc_7572385b876345ea`（4,212B）及 PDF `doc_f4aa30f53d864b8b`（35,397B）；主线程独立公开 read 验正文含本周两项修复／下周格式转换，PDF 一页、文本一致。证据 `model-approved-history.json`、`model-output-readback.json`。会话 runtime 投影仍报 interrupted／partial_runtime，故只认领业务产物闭环，不宣称原生终态投影正常；也不把库内 PDF 转换等同系统下载落盘。

- **原生保存落盘已验证（Markdown→HTML）**：用户指出当前保存框后，主线程核实实际 Electron PID／对话框，点击其 Save（IDOK），文件真实写入 `C:/Users/Mr.Key/Downloads/verify-ui-1111-1794329294519.html`；1,462,708B，SHA256 `637fe9009057242d580c200ece4efedf2591781f9dd06ef3502ada6936ddb610`，内容包含“UI 验收”和“真实 UI 保存重开 1111”。证据 `native-save-verified.json`。此前“必须真人才能保存”及“下载已失败”的判断均撤回；其它格式尚不能借此一并认领落盘通过。
- **Markdown 页面通过**：本轮新文档 `doc_ff96c6705cb84b5f`，真实输入／保存后 revision 1，库重开正文一致；证据 `md-ui-evidence.json`、`md-ui-reopened.png`。
- **PDF 密码页面通过／副本未通过验收**：错密实际打开被拒、正确密码打开 1 页且正文可见；正常 UI 提交副本名称后未观察新文档 ID，不能认领成功。原稿 revision、大小和 SHA 不变。证据 `pdf-ui-evidence.json`、`pdf-ui-final.png`。

完整非打印能力尚未全部验完，未验的设备／录制／剪贴板／多屏与其它业务边界不能由上述通过项替代。

### 历史 0.2.0：完整非打印能力适配，开发与验证记录（2026-11-10）

**源码 manifest 已为 0.2.1（0.2.0 的 manifest schema 被宿主拒绝，见下）；**`dist`、根 Windows x64 bundle 与用户当前 Profile 仍为 0.1.9。** 新源码接入 Docs、Sheets、Slides、PDF、Markdown、HTML 六编辑器，声明 12 个公开工具与 11 个 app-only 工具。第六完整构建、正式 SDK 验包及隔离六格式基础业务已通过，当前 Profile 已通过正常 UI 更新安装 0.2.0，但插件后台启动即失败；不得把以下 0.1.9 的成绩算作新能力验收。

- **0.2.0 安装后真实启动失败（已定位并修）**：`document_create` 的 `allOf/if/then` 分支里 `source`／`sourceFormat` 只写了 `maxLength`／`const`，未写 `type`。宿主 `worker.ts:165` 与 `stdio-runtime.ts:37` 用 `new Ajv({strict:true,addUsedSchema:false})` 编译工具 schema，直接拒为 `strictTypes`；SDK `validateAppPluginManifest` 不编译 inputSchema，因此此前所有门禁都没覆盖到。日志 `C:\Users\Mr.Key\AppData\Roaming\matchaclaw\logs\matchaclaw-2026-11-10.log` 14:08:29.039Z。修法：补 `type`，条件语义不变；版本升 0.2.1（宿主拒绝同版本不同内容）。Build 加同配置 Ajv strict 编译全部工具 schema 的构建门禁，23 个工具现全部通过。

- 范围为上游非打印文档能力；PDF／图片导出保留，不启动 GenOffice 自带 Agent、provider、独立桌面壳、CLI／MCP 服务入口。
- 上游源码只由同步脚本原样生成；必要适配经正式 patch、源摘要与严格上下文校验后进入临时 overlay，不手改快照。
- 当前构建与检查原始证据位于 `.scratch/office-complete-20261110/`。第四次完整构建已通过既有字节／文件门槛：134,012,233／134,217,728 bytes、1017／1024 文件（`build-shared-fourth.log`、`artifact-shared-fourth.json`），未抬限或裁字体。第四次正式 SDK pack 拒绝 Sharp native 的 `node_modules/@img/...` 非 canonical 路径；第五次已修为 canonical 部署并通过 SDK pack：ZIP 53,489,539B，digest `b1d5b375c746846eacd81d6cb3ddbc3078350ea60d8f852a73ce3c7a76e65d8a`。但第五 ZIP 在系统临时目录隔离 activate 后，DOCX 创建实际失败：jsdom CJS shim 未暴露可静态识别的 `JSDOM` named export（`isolated-zip-fifth.log`），不能认领可用交付。根因为共享 ESM 将 CSSOM 原有非严格语义改为严格；第六改共享 CommonJS 图并静态导出原五 API，未修改第三方 setter，隔离 import／DOM／getComputedStyle／sync-XHR 通过。
- 第六完整构建与正式 SDK pack exit0：`matcha.office-0.2.0-sixth.zip` 53,456,013B，digest `029707365b926690f4c1af85d21fb47ab7e57c446d6553ebbc5e66d8f9cd7de9`；1017／1024文件，133,974,668／134,217,728B（余243,060B）。49项上游＋6项依赖 overlay 严格校验通过；日志 `build-package-sixth.log`，报告 `artifact-shared-sixth.json`。首次误指不存在 OCR helper 的构建输入错误保留在 `build-package-sixth-preflight.log`，更正为既有预制 helper 后成功，不掩盖首次失败。
- 第六正式 ZIP 经 canonical SDK 读取、校验精确 digest 后解包到新系统临时目录，child cwd在包内且清 NODE_PATH：六格式 create／read／original export、23工具注册、MD／HTML资源读回与编辑保留、revision推进及stale CAS拒绝、库计数6全部通过。日志 `isolated-zip-sixth.log`，峰值0.59GiB、exit0／active0，native进程退出后已清 owned 目录；不替代页面、原生交互或模型验收。
- 第四包复制到系统临时目录、无根依赖，PDF 引擎七阶段真实通过：原 fixture 读取／检查、空白创建、文本插入保存重开、clean redaction 副本原稿摘要不变、加密原件打开／保存保保护与错密拒绝。证据 `pdf-evidence/engine-business.json` 与实际 PDF；不代表 PDF 页面、CAS、关闭或深层红删不可恢复已验。
- 共享 renderer 构建及修复后的 `renderer-conversion-fix-build.log` 均 exit0，不是完整包通过。原 HTML 布局转换已在该共享图真实 Electron 验证：两种 DOCX 保留中英文、1 张表、3 张媒体；PNG 为 2880×2800，已看图，超视口色块像素匹配。证据 `conversion-final-evidence-c2567904-55b5-4cea-ae39-404df75e4c59/`。修复为二次加载不再用 `document.open()` 清除 JSZip 调度监听；不是用旧独立 worker 成绩替代。
- Office 第六次后台／六页／worker 独立类型检查 `typecheck-sixth.log` exit0；根 Renderer 第五次、独立 SDK 构建／声明／打包、根 Vite 桌面构建均 exit0。Electron 第七次 `electron-typecheck-seventh.log` 仅剩无关 `cloud-account/client.ts:241` 的既有 ReadableStream 类型错误；本轮 Office／原生能力相关错误已清，完整 Electron 类型检查仍是失败。
- 原 Docs App headless 在共享图真实完成 HTML／PDF／Markdown：分别 186,917／208,329／177,862B；独立 PDF 解析 1 页，可抽取中英文与表格值42、实际绘制3图。证据 `docs-headless-evidence-b76a8a9f-69ef-4cd5-a02e-166306d4d321/`。新增隔离渲染 session 允许 `connect-src 'self' data: blob:` 消费内存文档，未改原 App fetch 或放宽普通插件 iframe。
- Markdown 当前真实后台转换产物位于 `markdown-evidence/`：含 Wiki、公式、代码、PNG 的 HTML／DOCX；主线程独立解 ZIP 确认 PNG 字节一致及 OMML，HTML 包含60个内联字体和原图片。不是 UI／PDF 视觉验收。
- 第五全包已复验原 Docs 显式分页／混纸 fixture：07 为3页 A4，逐页第一／二／三页正文正确；08 为2页 A4竖向与Letter横向，尺寸及各节正文符合 OOXML。07 初次失败为快照泄漏6个无src的编辑器 separator，已在 Docs export 单点移除，未吞真实图片错误；证据 `docs-pagination-fifth-becaaec7-6a78-4548-b5bd-3eaab24419c2/`。
- 第五 Sheets 公开导入／编辑／转换→真实 native session read→原 App→PDF 已验证公式42、A4一页，以及原带图BIFF8转换的文字、合并、行列尺寸及实际图片绘制；证据 `sheets-fifth-evidence-bc5aad31-7a18-4ef2-8349-4782b99736e4/`。额外 native list-connections、teardown 未处理拒绝及非必要AI状态启动请求已定位并修源码，待第六包复验，不把第五结果算修后通过。
- 第五 Slides 整包在系统临时目录无根依赖完成25步公开／native会话链：备注保存重开、无效ops不改revision、旧会话CAS冲突、另存副本原稿不变且后续只写副本。主线程解两份PPTX独立读回原稿／副本备注；证据 `slides-evidence/`。PDF Sharp 新canonical部署的真实插图／保存／重开／PNG导出亦通过独立像素解码，见 `pdf-evidence/sharp-fifth-business.json`。
- 第六正式包已通过唯一 Electron 载具的 Sheets 两案与 Slides 字图转换复验：Sheets 公式42与原带图BIFF8的合并／行列尺寸／图片锚点保留，13次 native read 全部同各自session且成功，无AI请求、read拒绝或teardown未处理异常；Slides PDF 2页960×540pt，中英可抽字、真实PNG与矢量图形完整，主线程已看三张独立栅格。重复字体8→4，结果消息9,792,663→4,904,555B，不抬8MiB。证据 `sixth-rendering-evidence-7ac20bc5-71d7-498b-b485-e8c740b5ff06/`；peak0.842GiB、exit0／active0，未触用户Profile。
- **当前 Profile 真实页面验收（0.2.1，日常 Profile `C:\Users\Mr.Key\AppData\Roaming\matchaclaw`）**：经正常 UI 更新装到 0.2.0→0.2.1，六页依次真实打开，暴露三处只有实机才可见的缺陷，全部未修完：
  1. Docs 可打开、可读库，但真实编辑后 Ctrl+S 失败 `parse worker failed`。实测 iframe origin 为 `null`，`new Worker(matcha-app://…/renderer/docs-parse-worker.js)` 抛 SecurityError；`type:'module'` 的 blob worker 在此 origin 必然 error，而同一 blob 在顶层 Renderer 正常。属部署形态错误，不是偶发。
  2. PDF 页打开即 `Plugin handler must return a JSON AppToolResult…`；根因是 `office:open-editor` 后原 App 挂载发 `pdf:dirty-changed`，返回 `void`，`encodePdfValue(undefined)` 让 `structuredContent.result` 为 undefined，被宿主 `isToolResult` 拒。
  3. Slides 页打不开，宿主文本 `No Sheets IPC handler is registered for ai:get-settings`；原 Slides App 挂载即 invoke 该通道，而 session 只注册了 8 个 `ai:*`。
  Sheets／Markdown／HTML 三页能正常渲染真实编辑器界面（截图 `current-profile-{sheets,slides,markdown,html,pdf}-021.png`）。
- **第八／第九包修复后的当前 Profile 实测**：0.2.2（`fa073946…`）已装。PDF 页真实打开文档成功（工具栏＋1 页渲染）；Docs 真实编辑 Ctrl+S 显示“已保存”且公开 read 读回新正文。新部署形态 `renderer/docs-parse-worker.classic.js.gz` 原本在真实 iframe fetch 返回 **403**——Host `assets.ts` 的 `MIME_TYPES` 是硬白名单，无 `.gz`；补 `'.gz': 'application/gzip'` 后实测 200／233,544B／`application/gzip`，`__docsParseStats` 从 `{worker:0,inline:1}` 变为 `{worker:1,inline:0}`，即解析真正走回 classic worker，不再退化到 UI 线程 inline。第八包当时只在 Node 侧验过 gzip 字节与解压，未核 Host 白名单，属验证缺口。
- **0.2.4（`9a65b10f…`）真实 Profile 六页结果**：Docs、PDF、Markdown、HTML、Slides 均已在真实页面完成打开／编辑／保存／公开 read 读回；Sheets 打开即报 `No Sheets IPC handler is registered for sheets:mcp-ready`，页面无 iframe 内容。链路是原 App 挂载后 `signalMcpReady()` → preload `send('sheets:mcp-ready')`，而我们的 `electron-preload.ts:53` 把 `send` 实现为 `invoke`，于是变成一次未注册通道的工具调用，其异常又被 shim 抬成 window ErrorEvent。修前证据与截图见 `.scratch/office-complete-20261110/`。
- Markdown 真实保存后 `resources` 仍为 1，正文末尾追加内容读回一致（revision 1）。
- HTML 源码保存曾疑似污染（正文末尾多出 `</h1></body></html>`）。复核后确认是**测试输入方式**：自动化逐字符 `keyboard.type()` 让 CodeMirror `autoCloseTags`（`@codemirror/lang-html@6.4.12` 的 inputHandler，单字符 `>`／`/` 触发）自动插入闭合标签，随后又键入自己的闭合标签。真实 0.2.4 handler 的 `create → edit(source) → read/export` 正文逐字节一致（88B、SHA256 `0138a4c9…`），resources 完整保留；同一字符串单次插入也无污染。保存链路不改，不关闭 autoCloseTags。真实页面 `insertText` 复核仍待做。
- Slides 真实 UX 回归（0.2.4）：插入文本框并编辑、圆角矩形＋文字、备注、菜单保存、另存副本、离开再打开——公开 read 全部一致（`doc_035b32df36b94100` rev1，文本／形状文字／备注齐全），重开后 iframe 与 3 个 canvas 恢复；普通全屏放映与 Audience 窗口都真实呈现，截图 `slides-evidence/ui-024-{show,audience,presenter,final-reopen}.png`。
- **Slides 退出放映会销页（已修，待 0.2.5 复验）**：原 `SlideShowView.tsx:292` 的 `void setShowFullScreen(false)` 不 catch，presentation view 已销毁时 Host 拒绝，异常抬成 pageerror 卸掉整个 iframe。修法在 owned `src/slides/bridge.ts`：`setShowFullScreen` 内 catch 并降级为 `console.warn`（退出放映是正常收尾，不该弹错误框），不放宽 Host 权限。
- **Slides 导出下载：未验证，非已证缺陷**。经 CDP 驱动导出时 PDF／PNG 都能收满字节（17,966／102,273B）却以 `canceled(received0)` 结束、目录为空。判别实验用同一 CDP 客户端在**顶层页面**造 blob 下载，同样是收满→canceled，且宿主主 session 没有任何 `will-download` 接管（只有 IAB 有自己的），因此默认行为是弹原生“另存为”对话框；自动化无人点它才被取消。结论：观测方式无法证明落盘，需一次真实人手保存才能判定，不据此改 `ui/files.ts`。
- 六页当前 Profile 保存／重开、其它复杂格式与原生交互、公开／内部工具隔离及 gpt-6-luna 模型闭环均待本版本独立验证。
- 已通过历史三文档ID与当前索引逐项匹配，核定原live Profile为 `C:\Users\Mr.Key\AppData\Roaming\matchaclaw`，不是另一轮独立licensed Profile。
- 原 Profile 历史验收保留；本次只读连接 `127.0.0.1:9222` 返回 ECONNREFUSED，按进程名／路径的只读查询未返回匹配进程，不能声称原窗口仍运行。未关闭或重启用户应用，当前 Profile 是否能直接恢复实际应用验收仍待确认。

### 历史 0.1.9：六模块重构，检查与待验边界（2026-11-10）

以下为 0.1.9 当时源码、`dist`、根 Windows x64 bundle 与用户当前 Profile 的记录；该节“当前／本轮”均指当时。该版已通过正常 UI 更新，并在原 Profile 完成三页真实编辑／保存及独立读回，不覆盖 0.2.0。

- 源码直接归 `src/{documents,docs,sheets,slides,ui,platform}`，旧 `adapter/`／`src/backend/` 实现删除，无 reexport 兼容。Documents 唯一持 model／store／service／10 public tools／页面 client；各编辑器持 engine／page／bridge／close，Docs 快照保存归 `desktop.ts`、没有 native session，Sheets／Slides 自持 native session／保存。activate 仅装配和 drain；platform 不决定保存，Host 不改。
- 上游快照由 `scripts/sync.mjs` 原样同步；`patches/genoffice/sheets-save-runtime.patch` 与 `patches/jsdom/default-stylesheet.patch` 经包名／版本、完整源 SHA-256、`git apply --check` 校验后应用到临时 overlay。esbuild 在原源路径／resolveDir 加载 patched bytes，保留同一 Sheets module/session Map；不回写快照／依赖，不在 build 散落源码 replace。
- 主线程已断言：manifest 除 version 外不变，保持精确 10 public＋4 app-only 合同；上游 1677 文件 SHA 指纹仍为 `1e7596af22197ce09bddceb11f60a562f3837f7289288eaa98516d48eb5c67b9`。保存 CAS／generation／snapshot／副本／recovery／close 语义保留，当前链路见第 2、3 节。

**本轮已读取的检查日志**均在 `.scratch/office-modules-20261110/`；下列日志均以 exitCode=0、jobActive=0 结束，文档侧没有重复执行：

| 已完成检查 | 日志／证据范围 |
| --- | --- |
| Office noEmit、构建、engine smoke、Sheets browser smoke | `typecheck-final.log`、`build-final.log`、`engine-final.log`、`sheets-browser.log` |
| 根 typecheck、build:vite、check:e2e | `root-typecheck.log`、`root-build.log`、`root-check-e2e.log`；Vite 有 chunk size 提示，check:e2e 为结构／lint／类型／规则检查，不是应用 E2E |
| 独立 ZIP 打包／隔离解包 | `package.log`、`isolated-package.log`；隔离 ZIP 内 DOCX／XLSX／PPTX create/read 通过，不借根仓依赖 |
| 副本／失败恢复 | `copies-recovery.log`；Slides 提交失败保原稿，named copy 保原字节／revision，后续保存指向副本；Sheets 副本含 cell=77、原稿 revision=0；迟到 IPC 拒绝、通知异常不掩盖提交 |
| recovery 等待中 close／dispose | `recovery-close.log`；先 dismiss 恢复等待再 drain，reopen 完成、native 资源释放 |

本轮独立包：`.scratch/office-modules-20261110/matcha.office-0.1.9.zip`，38,170,342 bytes，125 文件，digest `9b63221794019ef8523f2de5ae9e7b01daf8cb8b10c5ff64ce430a4798274fc0`。根 `build/app-plugins/win32-x64/matcha.office.zip` 与独立包摘要一致，`root-bundle.log` exitCode=0。单次只读复核对照旧 activate 与 0.1.8 包，未发现可证实的迁移退化，不以此替代运行验证。

当前用户 Profile 已正常 UI 更新 0.1.8→0.1.9；使用本轮独立库文档验收：

- Docs `doc_5c854a4989b34779`：真实输入、保存及公开 read 正文一致，revision3；初次操作快于打开完成，第一次保存仍是旧正文，等待打开并重新输入后验证通过，不把首次回执算成功。
- Sheets `doc_9b86bd7150fe49f5`：真实网格 B2=919，保存后公开 read 为919、revision1，库重开仍一致。
- Slides `doc_6ec9702e7c4046e9`：真实备注输入、菜单保存、公开 read 含验收文字，revision1、dirty=false、三个 Canvas；库重开备注仍在。
- UI 证据 `.scratch/office-acceptance-20261110/live/modules-{docs,sheets,slides}-019.json` 及同名截图、`modules-sheets-reopened-019.png`。这些是当前宿主操作与独立读回，不是模型调用闭环。

**性能仅单样本观察**：`perf-before.log`／`perf-after.log` 的同机空白 PPT require＋activate＋首创建为 251.91→225.71ms，RSS 均 72MiB；不是桌面完整 ready、P95 或页面内存改善结论。

**仍未闭合**：旧 Docs／Slides browser smoke 失败边界保留，本轮未重跑或认领它们通过。根全 tests 的既有 220 files／1186 tests 失败及 gpt-6-luna 模型闭环失败未重跑、不改写；宿主所有离场关闭保护、加密 UI／复杂格式／大文件和长期性能也不因本轮检查自动通过。未新增／修改测试，未提交或发布。

### 历史 0.1.8：自有适配代码收敛及真实宿主验收（2026-11-10）

以下为 0.1.8 当时源码、dist、根 Windows x64 bundle 与用户 Profile 的记录，不是当前 0.1.9 状态；该节“当前／本轮”均指当时。

- Docs 删除万能 Proxy，显式实现 DesktopApi；替换/关闭复用上游 dirty 检查与真实保存回执。每次打开独立 revision snapshot，选择同文档不刷新旧页 CAS 基线。
- Sheets 保存为“锁内准备新内容及 native generation → 库提交 → 接管新 session → 清旧资源”；失败保留原 session。解密与 reopen 按稳定文档身份绑定，另存副本产生新库身份。页面独立 editorId，未知/已关闭 IPC 不重建实例。
- Sheets recovery reply 使用专用通道绕过正在等待恢复选择的生命周期队列；beginClose 先 dismiss 恢复等待，再排空在途请求并释放，不提前销毁 native 资源。已验证恢复选择、恢复等待中关闭及插件 dispose 均可完成。
- Slides 真正另存副本，不再覆盖原稿；保存/替换使用真实 App 编辑与备注冲刷。两类 native 事件投递失败只记录日志，不杀插件、不把已提交保存伪报失败。公开工具不再在提交后用 abort 检查把成功改成失败。
- 单次 ESM splitting + CJS activate facade，按需加载引擎和 native runtime；保留全部字体，删除 Sheets 确证重复载荷。未修改 Host 公开契约、sandbox、CSP 或 package 上限。
- 真实安装验收暴露旧 jsdom cp filter 排除了整个依赖根，开发目录烟测借用了根仓依赖。现将完整 API/真实同步 XHR worker 依赖闭包打包，保留 stylesheet、package 与许可，共六文件；完整插件 125 文件，遵守 Host 的 1024 文件上限。ZIP 在系统临时目录独立解包后 DOCX/XLSX/PPTX create/read 全通过；当前 Profile DOCX 读取亦恢复。

**已执行验证**（证据均在 `.scratch/office-acceptance-20261110/`）：

- Office 最终 tsc、build、engine smoke 通过；根 typecheck、build:vite、check:e2e、Windows bundle 通过。日志 `final-form-typecheck-018.log`、`final-form-build-018-final.log`、`final-form-engine-018.log`、`final-form-root-check.log`、`final-form-root-build.log`、`final-form-root-bundle.log`。
- Sheets 索引 rename 注入 EACCES：revision 不变，旧 session 仍可读；解除后同 session 重试持久化 B2=88、revision=1，再 reopen/save 至2。`final-form-sheets-recovery.log` 的 namedCopy 那次误用已替换旧 session，不能算副本失败证据。
- 正确会话验证两类 named copy 均新增库身份，原稿字节/revision 不变，后续保存指向副本；所有 publish 抛错均不逃逸。`final-form-copies-recovery.log`。
- 原生恢复副本触发 reopen 提示，reply 在队列占用中仍结算；提示等待中 close、插件 dispose 均正常完成，无残留进程。`final-form-recovery-dialog.log`、`final-form-recovery-close.log`。
- 当前用户 Profile 正常 UI 更新 0.1.7→0.1.8。Docs 文档 `doc_5a6efb45dd1746c4`：真实输入/保存、外部 revision 冲突、同文档重新选择、取消保内容、明确放弃才加载新快照；最终 0.1.8 保存至 revision3，独立 read 正文一致。
- 当前 Profile Sheets：原稿 `doc_37b89122690a4933` UI 编辑 B2=321 保存至 revision1；UI 另存 `doc_9c219d24ca404188` 不动原稿；0.1.8 重开副本 UI 编辑 B2=654 保存至 revision1，公开 read 与画面一致。
- 当前 Profile Slides：UI 命名副本 `doc_4c42db34ea2f44d6`，原稿 `doc_df4ef35db2aa4ab8` 保持 revision0；0.1.8 UI 修改备注并保存、read 一致；未保存备注替换取消后 dirty=true/备注保留，选择保存修改后重新打开，dirty=false。证据 `live/final-form-current-profile-018.json`、`live/slides-final-018.json`、`live/sheets-final-018.json` 及同目录截图。
- 上游 1677 文件同算法指纹仍为 `1e7596af22197ce09bddceb11f60a562f3837f7289288eaa98516d48eb5c67b9`，没有手改 genoffice。包内 10 public tools、4 app-only tools，既有模型目录隔离合同保持。

**性能只作有限观测**：同机 Node24.15 空白 PPT 单进程，从 require 到首创建总耗时基线约927ms，最终约171ms；RSS 163→75MiB，读取最终8.14–14.64ms。Docs headless 字体就绪+真实输入单样本1967→1701ms，但峰值 Job commit 0.496→0.516GiB，不能声称页面内存改善或完整桌面/P95提升。Sheets HTML 31,432,869→29,680,866字节，字体未裁剪。日志 `final-form-perf-018.log`、`final-form-docs-ready.log`。

**未通过/未覆盖，不可伪绿**：

- 旧 Docs browser smoke 不提供 tools，当前 getRecentFiles 真读库而报错；旧 Slides smoke 预打开 headless 会话却要求新页面 UUID 直接接管，报无 Canvas。保留失败，不为绿恢复偷接会话或空返回；改以真实当前宿主 UI 验证。Sheets browser smoke 通过。未新增或修改测试代码。
- 普通侧栏路由切换本轮未观察到 dirty 关闭确认，不能以插件 onCloseRequested 实现或替换确认代替“宿主所有离场均保护”证明；Host 路由关闭许可不在本轮自有适配修改范围。显式 native close/dispose 已验证。
- 加密密码 UI、复杂 DOCX altChunk、大文件/P95/长期内存未做运行验收。
- gpt-6-luna 模型闭环仍是此前失败结论，本轮未重复消耗模型调用；根全量 tests 沿用此前 220 files /1186 tests 失败的结果，本轮未重跑或声称恢复。此前应用退出 code2/timeout 的历史结论也不改写。

交付包：`build/app-plugins/win32-x64/matcha.office.zip` 与 `matcha.office-0.1.8.zip` 内容摘要相同：`2bba0b83fb22038856629728fc68c5f4a977ec827ee5dbcd18154f1021239c00`。未提交或发布。README、分层架构及 frontend-plugins 知识库已同步源码事实。

### 历史：适配层架构检查与源码修复（2026-11-10，0.1.6 之后）

以下保留当时缺陷／判断及旧路径，均非当前待修清单；先销旧 session 等描述已由后续 generation 提交链替代。该阶段仅检查自有 `adapter/`、`src/`、构建与同步脚本，上游仅用于核对消费契约。

- 已实测并修复：PPT `applyOps` 返回 `applied:false` 时旧适配仍报成功并推进
  revision；现在创建/编辑统一检查上游事务结果，拒绝时返回 invalid_request，
  不提交库。空数组创建空白 PPT 的既有行为保留。
- 已修复 Slides 指南空占位：直接返回上游签名索引（本次 5001 字符）及六组原始
  指南，不独立编写另一套 op 定义。
- Office tsc、构建、现有 engine smoke 和三个 browser smoke 通过；临时库真实 tools 验证无效编辑
  不推进 revision、无效创建不入库、有效备注修改仍成功。证据：
  `architecture-invalid-ops.log`、`architecture-invalid-ops-fixed.log`、
  `architecture-engine-check.log`。未新增测试代码。
- 此次仅更新源码和本地 dist，未重新打包/安装；当前用户 Profile 仍为此前已验的
  0.1.6，不可把源码修复冒称当前窗口已更新。
- 当前未达到可宣称整体可靠/极致性能的质量：Docs 替换确认恒 true（真实浏览器
  调桥返回 true，listDocsTabs 返回 null）；Slides 另存为被映射到原文档保存；
  Sheets 保存交接与页面身份仍待收敛。均须按完整 owner 链修复，不以返回空值
  或隐藏按钮冒充实现。
- Sheets 静态确证：原生保存先销毁旧 session 再生成新 session，随后库提交失败
  会导致页面继续持有已失效身份；解密打开/open-encrypted 及崩溃 reopen 生成的
  session 没有登记库绑定，保存可能只更新临时文件而返回成功。尚未本轮运行复现。
- 更正下文 0.1.6 的页面退出描述：Slides host 已实现 close-editor，但 preload
  在 pagehide 发请求时，先注册的 SDK pagehide 已关闭桥，不能保证释放发生。
  应接现有 onCloseRequested，在桥可用时完成 dirty 决策和 await 释放；本轮
  仅确认调用/销毁顺序，尚未修复或测量内存增长。
- 性能实测范围很窄：Windows x64 / Node24.15 单进程空白 5630 字节 PPT：require
  600.94ms、activate 219.41ms、首次创建 106.84ms、六次读取 9.44–17.28ms，
  末尾 RSS 163MiB。这不是桌面完整就绪或大文件性能结论。
- 构建页基线（该源码修复前）：Docs 26.25MiB（61 个字体 base64 共19.02MiB）、
  Sheets 29.98MiB、Slides 8.69MiB。自有构建选择单文件全量内嵌；后续需测完整
  编辑可用耗时/峰值内存，不能把上游代码规模等同适配层性能证据。

### 历史 0.1.6：PPT 保存失败修复（2026-11-10）

该阶段源码和日常 Profile 曾更新至 **0.1.6**；以下只保留当时证据、缺陷与工件，不是当前状态。

- PPT 保存由适配层统一负责：同文档锁内校验 revision → 上游引擎生成文件 →
  文档库提交 → `commitSaved` 清 dirty。冲突或提交失败不会提前标记已保存；
  保留原生编辑会话、备注和未保存状态，可在 I/O 恢复后重试。
- 文档库存储改为不可变内容文件，索引原子 rename 是唯一提交点；兼容旧版
  version 1 索引及文件。索引提交失败保留旧字节/revision，清理失败不冒充保存失败。
- Slides 页面实例 ID 贯穿内部打开、IPC、原生 session 和事件；同实例操作串行，
  两个页面不再共用单一会话。页面退出释放其虚拟 WebContents。
- 未修改 `genoffice/`、宿主公开契约或四桥的 app-only 可见性；未新增测试代码。
- Office tsc、构建、引擎烟测及 Docs/Sheets/Slides browser smoke 全部通过。
  初版实例路由导致旧 browser smoke 无 Canvas，已修正预打开会话交接并重跑通过。
- 实际插件故障注入通过：索引 rename 抛 EACCES 时 `ok:false`、dirty/备注保留、
  库字节和 revision 不变；解除故障后再次保存成功。并发 revision 冲突、两实例
  保存隔离和重开读回通过。证据：`ppt-save-failure-recovery.log`。
- 当前日常 Profile 正常 UI 更新至 0.1.6，独立验收文档
  `doc_eba24cfb1e774d37`：页面编辑保存 revision 1；工具并发推进至 2 后页面保存
  返回 `revision_conflict`，原生 dirty=true、未提交备注保留、库内容未覆盖；
  重开后再次编辑保存至 revision 3，公开 `document_read` 核对正文，dirty=false。
  证据：`live/ppt-save-current-profile-0.1.6.json`、
  `live/ppt-save-recovered-current-profile-0.1.6.json` 及截图。
- 修复包：`.scratch/office-acceptance-20261110/matcha.office-0.1.6.zip`，
  SHA-256 `cdec972c96e53bc00855008528ee0ad5248ca30e89d2f3db55f9b702ce481ed4`。
  根 `build/app-plugins/win32-x64/matcha.office.zip` 仍是先前 0.1.4，不可混称。
- 尚未修复：Sheets 原生保存后再提交库的会话交接问题；gpt-6-luna 模型闭环；
  宿主模型同步/前台确认/监听器告警。未重跑根全量回归，先前失败结论不变。
- 用户最初所见失败没有对应保存回执，不能倒推其唯一原因；本次修复与验证覆盖
  已确认的 PPT 保存提交、冲突和实例串会话缺陷，不代表所有复杂 PPT 路径均已验收。


### 历史 0.1.4 及初次移植验收

本小节的“当前／本轮”均指初次移植阶段，不覆盖 0.1.9 的源码、安装或验收。

当时源码移植和适配主体已经完成，Office 插件侧的类型检查、构建、引擎烟测、
Docs/Sheets/Slides 浏览器烟测、应用插件打包都已通过。根仓的
`pnpm run typecheck` 和 `pnpm run build:vite` 也已通过。

2026-11-10 已继续完成真实 Electron 宿主验收并修复接入问题，当前插件版本
为 **0.1.4**。复用 `e2e/.profiles/licensed/` 自身已有授权，不复制日常 Profile。

- 插件界面导入/启用/更新、三个 application 入口已实测。
- Docs：空白编辑保存、文档库重开再编辑保存、真实 `.docx` 导入；保存正文经
  宿主公开 `document_read` 独立核对，revision 0→1。
- Sheets：库工作簿打开、网格编辑（B3=77）、保存、重开可见值；revision 1→2。
  并发工具修改到 revision 3 后，旧页面保存报冲突，B2=88/B3=77 保留。
- Slides：创建、备注编辑、保存、重开和跨应用重启持久化；三个 Canvas 正常。
  并发推进 revision 后旧页面保存被拒绝，重开仍为原备注。
- 实际 agent gateway 恰好公开 10 个 tools；四个内部桥不在目录，模型端调用
  均返回 404。四桥须在 manifest 声明为 app-only，不能省略声明。
- 三页 AI 面板/ribbon/模型入口已隐藏；未启动 GenOffice CLI/MCP。
- 最终 Office 类型检查、构建、引擎烟测、三页 browser smoke、根类型检查、
  bundle、ZIP 资源检查通过；根 Vite 构建与 `check:e2e` 也通过。
- **根全量测试失败**：220 文件失败/162 通过/2 跳过，1186 用例失败/
  1701 通过/3 跳过，另有 4 个未处理错误。未做干净基线，不能宣称新增依赖
  没有回归，也不能把失败全部归为 Office。

**随后按用户要求补做当前窗口 + gpt-6-luna 验收：** 当前窗口使用日常
`C:/Users/Mr.Key/AppData/Roaming/matchaclaw`（不是上述专用 Profile），原本未安装
Office，已通过正常 UI 安装根 bundle 的 0.1.4。PPT 画布拖出文本框、输入、保存、
重新打开截图与 `document_read` 均核对成功，revision 2。模型真实对话任务却反复
ToolSearch、未发起 Office 创建/编辑/读取，约 4 分钟后停止；**模型端到端未通过**。
不能以 gateway 直调成功代替模型验收，也不能把未发起调用说成调用成功。provider
协议尚未知；只读检查发现条件性的工具搜索提示/结果格式不一致，尚无真实请求
schema 证据，不下唯一根因结论。当前应用保持运行。详细证据见 `live/RESULT.md`。

验收证据：`.scratch/office-acceptance-20261110/`，原始失败与最终结果均保留。
不宣称整次 E2E 全绿：首轮退出 code 2（IAB 清理失败），第二轮到达 30 分钟
守护上限 exit124；用户批准只移除该轮已退出 PID 33676 的专用残锁后，第三轮
继续使用同一 Profile。第三轮业务验证结束后正常请求关闭，仍为 code 2，
守护退出 1、进程树清空，Profile 和文档保留。未修改 E2E 规则或新增测试。

仍未提交，`apps/office` 仍为未跟踪目录。打印、完整桌面壳功能和所有 Office
复杂格式能力不在本轮验收范围；Slides UI 本轮验证的是演讲者备注编辑，未把它
表述为画布富文本/图片/动画的全面验收。

以下第 1—3、6、7、9 节描述 0.1.9 当前结构和使用入口；第 4、5、8、10 节明确保留历史，不作新验收。

## 1. 不可破坏的约束

- 插件 ID 是 `matcha.office`，作为 MatchaClaw 的应用插件运行。
- 上游源码和适配代码必须分区：
  - `apps/office/genoffice/`：GenOffice 上游白名单快照，只能由同步脚本生成，禁止手改。
  - `apps/office/src/`、`scripts/`、`patches/`：Matcha 自有实现／构建适配，不被同步覆盖；旧 adapter／backend 不保兼容层。
- 目录名就是 `genoffice`，不要改成 `upstream` 或其他名字。
- 升级方式：重跑 `scripts/sync.mjs` 原样覆盖 `genoffice/`，再核显式 patch；版本、源 hash 或上下文不匹配时构建拒绝，不手改快照。
- 不移植 GenOffice 桌面壳、菜单、更新器、单实例锁和遥测。
- 不运行 GenOffice 自带的 agent、AI 面板、AI provider 账号体系；AI 能力由
  MatchaClaw 自己的 agent 通过插件 tools 调用。
- 不启动 GenOffice CLI 入口和 MCP server；文档能力已经映射为插件 tools。
- 保留 Docs / Sheets / Slides 三个编辑页，保留 docx/xlsx/pptx 引擎和
  `xlsx-sidecar` Rust 进程。
- 仍不整仓复制上游；白名单快照不改，必要适配只在显式校验的构建 overlay 中应用。

## 2. 当前目录和所有权

```text
apps/office/
  genoffice/                 # 上游白名单快照，禁止手改
  src/
    activate.ts              # 装配、停止接单、drain、dispose
    documents/               # 唯一 model/store/service/public tools/client
    docs/                    # engine/page/typed desktop bridge/close，页面快照保存
    sheets/                  # engine/page/bridge/close/session/save
    slides/                  # engine/page/bridge/close/session，保存归 session
    ui/                      # 文档选择、命名、未保存确认、样式
    platform/                # 环境／通信替身、临时资源，不决定保存
  scripts/
    sync.mjs                 # 原样白名单同步
    patches.mjs              # 严格校验、临时 overlay、原 module identity
  patches/
    genoffice/sheets-save-runtime.patch
    jsdom/default-stylesheet.patch
  test/
    engine-smoke.mjs         # 14 个 tool 的引擎烟测
    docs-browser-smoke.mjs
    sheets-browser-smoke.mjs
    slides-browser-smoke.mjs
  build.mjs                  # esbuild 构建 main.cjs、HTML、native 资源
  manifest.json              # applications 和公开 tools
  README.md                  # 当前使用说明
```

根仓相关改动：

- `apps/bundled.json`：加入 `matcha.office` 构建入口。
- `package.json` / `pnpm-lock.yaml`：加入 Univer、Tiptap、Konva、Office
  解析依赖，并固定 `react-konva@19.2.7`、Univer `0.25.1`。
- `.gitignore`：忽略 `apps/office/.build/`、`apps/office/.office-previous-*/`。
- `README.md`、`README.zh-CN.md`、`README.ja-JP.md`：补充 Matcha Office
  的当前定位（GenOffice 源码快照 + 三个编辑页 + Matcha agent tools）。

## 3. 已经实现的运行链路

### 3.1 插件激活

`src/activate.ts` 做四件事：

1. 在打包目录存在 `native/xlsx-sidecar.exe` 时设置
   `process.env.XLSX_SIDECAR_PATH`。
2. 创建 Documents service，由它持唯一文档库和引擎操作映射。
3. 创建 Sheets／Slides session，注入 Documents 的类型专属保存／新建 hooks。
4. 组合并注册 10 public＋4 app-only tools；退役停止接单／注销，先 Sheets beginClose，再 drain active tools，最后释放两类会话。

公开 tools：

- `documents_list`
- `document_create`
- `document_import`
- `document_read`
- `document_edit`
- `document_check`
- `document_export`
- `document_write`
- `document_delete`
- `document_guide`

内部桥（manifest 必须声明，并设置 `_meta.ui.visibility: ["app"]`，不暴露给 agent）：

- `office_sheets_ipc`
- `office_sheets_open`
- `office_slides_ipc`
- `office_slides_open`

保存经 Documents service 进入 `store.updateFrom`／`update`，提交前在文档串行锁内核 `expectedRevision` CAS，以索引原子 rename 提交不可变内容。编辑器的 produce 回调在 CAS 成功后执行；`document_edit` 引擎生成后仍须经提交 CAS，不能覆盖较新 revision。通知异常和提交后的取消不把成功改成失败。

### 3.2 Docs

- `src/docs/page.tsx` 渲染上游 App，`engine.ts` 提供工具侧 docx 引擎操作。
- `desktop.ts` 显式 typed DesktopApi，经 Documents client 映射库打开／保存；每次打开独立 snapshot／revision，成功保存才更新基线，另存为新库身份。Docs 没有后台 native 编辑会话。
- `close.ts` 复用上游复合 dirty 与 close-save 真实回执，换文档／关闭不猜测保存成功；不支持的桌面能力显式失败／unsupported。
- AI 面板默认隐藏；保留 `.docx` 导入、编辑、回库、另存及 HTML／Markdown 导出，完整桌面壳能力不在范围内。

### 3.3 Sheets

- `src/sheets/{engine,page,bridge,close,session,save}.ts*` 各持引擎、页面、业务桥、关闭、native 会话和保存；每页独立 editorId，挂 App 前 await open-editor，真实保存回执后 await close-editor。
- 页面只向 `office_sheets_open` 传 documentId／editorId，后台经 Documents 读名称／字节／revision，session 写临时文件并走上游 select，不经页面导出回传字节。
- `save.ts` 在 CAS 锁内先导出新 generation／预开新 session，再提交库，成功才接管并退役旧 session／snapshot；失败清准备资源，保旧会话／revision。save-as 建新库身份，稳定 identityPath 的 reopen／解密指向最新已提交 generation。
- recovery reply 绕 editor tail；close／beginClose 先 dismiss 恢复等待再 drain，避免 native open 等待回复卡住退役。AI handlers 关闭，sidecar 随 native 资源打包。

### 3.4 Slides

- `src/slides/{engine,page,bridge,close,session}.ts*` 各持引擎、页面、业务桥、关闭和 native 会话；保存实现在 session.ts，不虚设独立 save 模块。
- 页面以 documentId／editorId 打开，后台 Documents 读取后 session 写临时 `.pptx` 并调用上游 open-path；每页独立会话与操作 tail，未知／关闭页不重建。
- 普通保存同库身份 CAS 提交成功后才 commitSaved／清 dirty；save-as 在新工作目录导出、创建新库身份，提交后才切换当前页，原稿字节／revision 不变。提交后 render 刷新失败只记日志、仍报保存成功。
- close.ts 等上游真实 App flush 活动编辑／notes 和保存结果，再 await close-editor；bridge 的 getRecentFiles 返回空数组，不暴露临时路径。
- session 捕获上游 autosave interval 并 unref，dispose 排空后清定时器、事件与工作目录。
- 以下 Slides-only AI IPC 在 session 中显式注销：
  `ai:generate-image`、`ai:analyze-media`、`ai:insert-image-url`、
  `ai:replace-picture-url`、`ai:save-sidecar`、`ai:save-style-template`、
  `ai:list-style-templates`、`ai:load-style-template`。

### 3.5 构建

`build.mjs` 的职责：

- 解析 `@genoffice/*` 到 `genoffice/packages/*/src`。
- 处理 `@matcha/sheets-*`、`@matcha/slides-*` 等适配别名。
- 用 `src/platform/` 的环境／通信替身与 replacements 替代不适用的 Electron／Node 能力，不在 platform 决定保存。
- 调 `scripts/patches.mjs` 校验并准备两份显式 patch，临时 overlay 的 bytes 以原路径 onLoad，两个 Sheets alias 共用模块身份；成功／失败均清 overlay。
- 后台一次 ESM splitting，CJS activate facade 动态加载同目录 backend／chunks；HTML 自包含、字体完整保留，jsdom API＋真实 sync-XHR worker 和磁盘资源共六文件，Host 1024 文件上限不变。
- 输出：
  - `dist/main.cjs`
  - `dist/backend.mjs`、`dist/chunk-*.mjs`（必须同目录）
  - `dist/node_modules/jsdom/{package.json,LICENSE.txt,THIRD_PARTY_LICENSES.txt}`
  - `dist/node_modules/jsdom/lib/{api.js,xhr-sync-worker.js,default-stylesheet.css}`
  - `dist/docs.html`
  - `dist/sheets.html`
  - `dist/slides.html`
  - `dist/native/xlsx-sidecar.exe`
  - `dist/native/harfbuzz/harfbuzz.mjs`
  - `dist/native/harfbuzz/harfbuzz.wasm`
  - `dist/native/fonts/Carlito-*.ttf`

### 3.6 同步

`scripts/sync.mjs`：

- 读取 `GENOFFICE_SOURCE` 或第一个参数。
- `rm -rf apps/office/genoffice` 后按白名单复制。
- 生成 `genoffice/matcha-sync.json`，记录同步时间和文件清单。
- 白名单包含 Docs/Sheets/Slides 页面、共享 packages、字体、xlsx-engine 的
  Rust 源码和 Cargo 文件。
- 当前 1677 文件 SHA 指纹由主线程断言未变，见第 0 节；sync 不应用 patch，显式 patch 只在构建临时 overlay 生效。

## 4. 历史：初次移植验证与产物

以下只保留初次移植时的检查／产物，不是 0.1.9 成绩；尤其旧三页 smoke 通过不能覆盖后续显式 editor session 与关闭许可，当前已过项只看第 0 节。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| Office 类型检查 | `pnpm exec tsc -p apps/office/tsconfig.json --noEmit` | 通过 |
| 根仓类型检查 | `pnpm run typecheck` | 通过 |
| 根仓 Vite 构建 | `pnpm run build:vite` | 通过（有 chunk size 提示） |
| Office 构建 | `node apps/office/build.mjs` | 通过 |
| 引擎烟测 | `node apps/office/test/engine-smoke.mjs` | 通过 |
| Docs 页面烟测 | `node apps/office/test/docs-browser-smoke.mjs` | 通过 |
| Sheets 页面烟测 | `node apps/office/test/sheets-browser-smoke.mjs` | 通过 |
| Slides 页面烟测 | `node apps/office/test/slides-browser-smoke.mjs` | 通过 |
| 应用插件打包 | `node scripts/bundle-app-plugins.mjs --platform win32 --arch x64` | 通过 |
| ZIP 内容检查 | 读取 `matcha.office.zip` 条目 | 必需文件齐全 |

ZIP 检查确认包含：

```text
manifest.json
main.cjs
docs.html
sheets.html
slides.html
native/xlsx-sidecar.exe
native/harfbuzz/harfbuzz.mjs
native/harfbuzz/harfbuzz.wasm
native/fonts/Carlito-*.ttf
```

历史产物（当时路径／摘要，不代表该路径现有内容）：

```text
build/app-plugins/win32-x64/matcha.office.zip
sha256: 8c0f969e8654a1de7a86837907bd987c95ca7213774e7dcecff122691058ddd1
```

引擎烟测覆盖 14 个注册 tools，以及 docx/xlsx/pptx 的创建、读取、编辑、
检查、导出；Sheets 的实际打开和 range 读取；Slides 的实际打开、保存和
库 revision 增长。

浏览器烟测分别启动真实页面，Docs/Sheets 渲染页面，Slides 先真实打开
`.pptx`，并确认编辑页面和 Canvas 存在。

## 5. 原交接 P0/P1 清单（历史要求，最新结果见第 0 节）

本节保留原交接的要求、判断与命令背景，不是新增规则或本轮执行／提交授权；“已执行／当前”均指历史阶段。

### P0：宿主内验收（历史阶段已执行，不代表 0.1.9）

以下为本轮开始前的交接要求，不能再当作当前未执行状态；实际结果和未覆盖项
以第 0 节为准：

1. 启动应用（`pnpm dev` 或已构建的应用）。
2. 确认 Matcha Office 出现在应用插件列表，并能启用。
3. 确认 Applications 中出现 Docs、Sheets、Slides 三个入口。
4. Docs：新建/导入 `.docx`，编辑并保存，重新打开确认内容和 revision。
5. Sheets：新建/导入 `.xlsx`，编辑单元格，保存，重新打开确认内容。
6. Slides：新建/导入 `.pptx`，编辑并保存，重新打开确认内容。
7. 从 MatchaClaw agent 调用一次 `documents_list`、`document_create`、
   `document_read`、`document_edit`，确认工具在宿主的 tool 列表里可见且
   返回值正常。
8. 确认页面没有 GenOffice AI 面板/AI provider 登录入口，也没有启动
   GenOffice CLI/MCP server。
9. 重启应用后再打开同一文档，确认本地库持久化正常。

仓库 `AGENTS.md` 提到当前 Electron E2E 真实验收可能被 Host 启动栈溢出
阻塞；如果遇到，不要把问题误判成 Office 插件失败，改用 `pnpm dev` 手动
验收或单独的 host smoke。

### P1：提交前清理和回归

1. `git status` 当前会看到 `?? apps/office/`，这是整个新插件目录，需要一起
   纳入提交。
2. 根仓还有大量与本任务无关的 `matcha-agent/**` 修改和未跟踪文件。不要把
   它们混进 Office 提交。
3. 建议只审查并提交：
   - `apps/office/`
   - `apps/bundled.json`
   - `.gitignore`
   - `README.md`、`README.zh-CN.md`、`README.ja-JP.md`
   - `package.json`、`pnpm-lock.yaml`
4. 如果构建过程重新生成 `apps/office/.office-previous-*`，可以删除；它只是
   上一次构建的备份。`apps/office/.build/xlsx-target` 要保留，是外部
   sidecar 构建产物。
5. 提交前再跑一次：Office typecheck、根仓 typecheck、`build:vite`、
   engine smoke、三个 browser smoke、bundle。

### P2：可选裁剪和加固

不要把上游 AI 包直接删掉。当前耦合点已经确认：

- `packages/docx-engine`、`packages/pptx-engine` 引用
  `@genoffice/agent-core/redact-*`。
- Docs/Sheets/Slides 的共享 IPC/UI 类型引用 `@genoffice/ai-provider`。
- Slides main 和 Sheets main 引用 `@genoffice/ai-search`。
- 旧 `adapter/engine/pptx.ts`（现 `src/slides/engine.ts`）直接引用 `@genoffice/pipelines`。

因此现在做的是“运行时不启动、页面不暴露、IPC 注销”，不是把源包从快照里
删干净。要彻底删包，先替换上面的引用，再同步收缩
`scripts/sync.mjs` 和 `build.mjs` 的 `packageRoots`，然后重跑全部烟测。

其他待评估项：

- 目前只验证 `win32-x64`。如果要支持 macOS/Linux/Windows ARM64，需要为
  每个目标构建 `xlsx-sidecar`，并确认 HarfBuzz/Carlito 资源路径。
- `build.mjs` 有两条 `import.meta` 的 esbuild 警告，分别来自
  `genoffice/packages/cli/src/resources.ts` 和
  `genoffice/apps/docs/src/renderer/font-resolve.ts`。当前构建和烟测通过，
  但提交前应确认 `resources.ts` 的资源路径分支不会被插件工具触发。
- 根仓 `package.json` 新增了较多依赖，`pdfjs-dist`、`undici`、Tiptap 等
  版本也发生了变化。根仓 typecheck 和 `build:vite` 已通过，但仍建议在宿主
  里做一次主应用启动和关键页面冒烟。

## 6. 常用命令

### 同步上游

```powershell
$env:GENOFFICE_SOURCE='E:\code\Matcha-claw\.scratch\genoffice'
node apps/office/scripts/sync.mjs
```

同步会删除并重建 `apps/office/genoffice/`。不要把 sidecar 的 Cargo target
放进这个目录。

### 构建 xlsx sidecar

```powershell
Set-Location apps/office/genoffice/apps/sheets/native/xlsx-engine
cargo build --release --locked --target-dir E:\code\Matcha-claw\apps\office\.build\xlsx-target
Set-Location E:\code\Matcha-claw
```

### 构建插件

```powershell
Get-Process xlsx-sidecar -ErrorAction SilentlyContinue | Stop-Process -Force
$env:XLSX_SIDECAR_BIN='E:\code\Matcha-claw\apps\office\.build\xlsx-target\release\xlsx-sidecar.exe'
node apps\office\build.mjs
```

Windows 上 sidecar 运行时可能锁住 exe；构建前先停进程。

### 类型检查

```powershell
pnpm exec tsc -p apps/office/tsconfig.json --noEmit
pnpm run typecheck
```

### 引擎和浏览器烟测

```powershell
$env:XLSX_SIDECAR_BIN='E:\code\Matcha-claw\apps\office\.build\xlsx-target\release\xlsx-sidecar.exe'
node apps\office\test\engine-smoke.mjs

$env:PLAYWRIGHT_CHROMIUM_EXECUTABLE='C:\Users\Mr.Key\AppData\Local\ms-playwright\chromium_headless_shell-1223\chrome-headless-shell-win64\chrome-headless-shell.exe'
node apps\office\test\docs-browser-smoke.mjs
node apps\office\test\sheets-browser-smoke.mjs
node apps\office\test\slides-browser-smoke.mjs
```

### 打包应用插件

```powershell
$env:XLSX_SIDECAR_BIN='E:\code\Matcha-claw\apps\office\.build\xlsx-target\release\xlsx-sidecar.exe'
node scripts\bundle-app-plugins.mjs --platform win32 --arch x64
```

注意：`bundle-app-plugins.mjs` 会重新调用 `apps/office/build.mjs`，所以
`XLSX_SIDECAR_BIN` 必须在这个命令的环境里也存在；只给单独一次
`node apps/office/build.mjs` 设置是不够的。

### 根仓构建

```powershell
pnpm run build:vite
```

## 7. 已知坑

1. **不要手改 `apps/office/genoffice/`**。下一次同步会覆盖它，而且会破坏
   “上游目录 + 适配目录”的升级模型。
2. **`sync.mjs` 会 `rm -rf` `genoffice/`**。sidecar target 必须放在
   `apps/office/.build/`，不要放进 `genoffice/`。
3. **Windows 文件锁**：构建前停掉 `xlsx-sidecar`，否则复制 exe 可能报
   `EPERM`。
4. **`react-konva` 固定 `19.2.7`**。项目当前 React 是 `19.2.4`，
   `react-konva@19.3.x` 运行时要求 React 19.3，会直接报错。
5. **Univer 固定 `0.25.1`，并且只能有一份副本**。不要在 `package.json`
   或 `pnpm.overrides` 里引入第二个版本。
6. **浏览器构建必须保留 `process` banner 和 `process.env.NODE_ENV` define**。
   否则上游代码在浏览器里会报 `process is not defined`。
7. **Playwright 浏览器路径**：当前机器使用
   `C:\Users\Mr.Key\AppData\Local\ms-playwright\chromium_headless_shell-1223\chrome-headless-shell-win64\chrome-headless-shell.exe`；
   换机器时先确认路径。
8. **内部桥必须在 manifest 声明为 app-only**。`office_sheets_*`、
   `office_slides_*` 设置 `_meta.ui.visibility: ["app"]`；宿主拒绝未声明工具，
   agent gateway 过滤 app-only 工具，并拒绝模型端调用。
9. **不要把 GenOffice 的 AI IPC 重新注册回来**。Sheets 使用
   `includeAiHandlers:false`，Slides 在 `src/slides/session.ts` 中 `removeHandler`。
10. **不要用 `getRecentFiles` 暴露临时路径**。Slides 已经固定返回空数组。
11. **根仓有大量与本任务无关的 `matcha-agent/**` 改动**，提交时不要
    `git add -A`。
12. **当前机器 PowerShell 和 Git Bash 的 `node` 版本可能不同**（本次
    PowerShell 是 v24.15.0，Git Bash 曾显示 v22.22.0）。以仓库的 `pnpm`
    脚本和 `packageManager` 为准；不要因为 shell 切换导致依赖或构建结果
    不一致。

## 8. 历史：初次交接验收清单

保留原未勾选清单，不表示所有项仍未执行，也不把旧全部通过要求当作 0.1.9 结果；当前状态只看第 0 节。

- [ ] `apps/office/genoffice/` 与上游快照逐文件一致，没有手改。
- [ ] 上游快照不被手改；原 adapter 已迁入 src，显式 patches 在临时 overlay 应用。
- [ ] `manifest.json` 同时声明 Docs、Sheets、Slides 三个 application。
- [ ] 10 个公开 tools 在宿主 agent 的 tool 列表中可见。
- [ ] 4 个内部桥在 manifest 中为 app-only，未出现在 agent tool 列表且模型端调用被拒绝。
- [ ] Docs 页面能新建/导入、编辑、保存、重新打开。
- [ ] Sheets 页面能新建/导入、编辑、保存、重新打开。
- [ ] Slides 页面能新建/导入、编辑、保存、重新打开。
- [ ] 保存冲突返回 `revision_conflict`，不会覆盖较新的 revision。
- [ ] 页面没有 GenOffice AI 面板、AI provider 登录、Genspark 账号入口。
- [ ] 没有启动 GenOffice CLI/MCP server。
- [ ] `matcha.office.zip` 包含 `docs.html`、`sheets.html`、`slides.html`、sidecar、HarfBuzz 和 Carlito 字体。
- [ ] `pnpm exec tsc -p apps/office/tsconfig.json --noEmit` 通过。
- [ ] `pnpm run typecheck` 通过。
- [ ] `pnpm run build:vite` 通过。
- [ ] engine smoke 通过。
- [ ] Docs/Sheets/Slides browser smoke 通过。
- [ ] `apps/bundled.json` 包含 `matcha.office`。
- [ ] README 三语没有“Matcha Office 不是完整编辑器 UI”这类过时描述。
- [ ] 提交没有混入无关的 `matcha-agent/**` 改动。

## 9. 关键文件索引

| 文件 | 作用 |
| --- | --- |
| `apps/office/manifest.json` | 插件 ID、三个 application、10 个公开 tools |
| `apps/office/src/activate.ts` | 装配、tool 注册、drain／dispose |
| `apps/office/src/documents/store.ts` | 文档库、CAS／revision、原子索引提交 |
| `apps/office/src/documents/service.ts` | 文档操作、引擎映射、编辑器提交 hooks／通知 |
| `apps/office/src/documents/tools.ts`、`client.ts` | 公开工具、页面文档 client |
| `apps/office/scripts/sync.mjs` | 上游原样白名单同步 |
| `apps/office/scripts/patches.mjs`、`patches/` | 严格校验的显式临时 patch overlay |
| `apps/office/src/docs/page.tsx` | Docs 页面入口 |
| `apps/office/src/sheets/page.tsx` | Sheets 页面入口 |
| `apps/office/src/slides/page.tsx` | Slides 页面入口 |
| `apps/office/src/sheets/session.ts`、`save.ts` | Sheets native 会话、generation 保存／恢复 |
| `apps/office/src/slides/session.ts` | Slides native 会话、提交／副本、AI IPC 注销 |
| `apps/office/src/docs/desktop.ts`、`close.ts` | typed DesktopApi、页面快照保存／关闭 |
| `apps/office/build.mjs` | esbuild、别名、shim、native 资源 |
| `apps/office/test/engine-smoke.mjs` | 14 个 tool 的引擎烟测 |
| `apps/office/test/*-browser-smoke.mjs` | 三个页面的浏览器烟测 |
| `apps/bundled.json` | 应用插件构建清单 |
| `scripts/bundle-app-plugins.mjs` | ZIP 打包和 digest 校验 |

## 10. 历史 Git 状态提示

以下为初次交接的状态快照，不是当前实时 git status，也不是提交授权：

```text
M .gitignore
M README.md
M README.zh-CN.md
M README.ja-JP.md
M apps/bundled.json
M package.json
M pnpm-lock.yaml
?? apps/office/
```

仓库里同时存在大量 `matcha-agent/**` 的修改和未跟踪文件，这些不是本次
Office 移植产生的，提交时必须排除。

还没有提交。下一个 agent 完成宿主验收后，再按“一个完整能力一个提交”的
规则提交，提交信息要写清楚新增了 Matcha Office 插件、三个编辑页、tools
和适配层，以及删除了哪些旧残留。
