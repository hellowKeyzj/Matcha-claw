# MatchaClaw 前端 HTML 设计交接包

直接打开 index.html，从目录选择页面。每个 HTML 都是当前真实 React 组件的 DOM 与样式快照，可单独发送和离线打开，不需要 Node、服务器、CDN 或账户。

## 修改与交回

1. 将目标 HTML、DESIGN.md、PRODUCT.md 一起交给设计方。
2. 直接改 HTML 中的语义 DOM、CSS 和内联 SVG，不要把页面变成整张图片，不要删掉 head 内的 design-snapshot-metadata。
3. 定稿后交回改过的 HTML；涉及多个页签或弹窗时，将相应 HTML 一起返回，并说明共享组件需要统一的改动。
   产品文案回填 React 时必须复用或新增 i18n 翻译键，同步现有语言资源，不能把 HTML 中已翻译的中文硬编码进组件；示例业务数据不当作翻译键。
4. 以浏览器实际呈现为准。默认基准窗口 1440 × 960、缩放100%、Windows字体环境；聊天右栏会按真实扩窗行为增宽，以HTML元数据和manifest记录的viewport为准。右下角工具只用于目录和主题，不属于产品设计。

## 内容与边界

- 页面/页签/重要弹层分别存为独立HTML。侧栏、主要页签和已有对应快照的入口可点击本地跳转；右下“设计”工具还可按分组切换全部页面。其余React业务交互不随快照保留，不会连接真实服务、提交支付或保存数据。请先解压ZIP再打开index.html；只单独发送一份HTML时，指向其他文件的链接需要目标HTML一并发送。分组包仅在组内跳转，跨组入口需使用完整包。
- 全部业务内容为新造的合成示例，不读取真实账号、授权码、密钥、聊天记录或用户profile。资料链接使用example.test。
- 原应用未内置Inter字体文件，使用相同CSS字体栈和系统回退；不同操作系统的字形可能不同。不要假设任意机器像素一致。
- 原生终端/Canvas若转换为局部PNG，在manifest的snapshot.canvasCount中登记；其外层布局与文本仍可编辑。品牌logo以gzip压缩原始SVG内嵌，打开时由浏览器原生解压，保持矢量；请使用支持DecompressionStream的现代Chrome、Edge或Firefox，页面本身不是截图。
- manifest.json保留页面到源码的映射、覆盖状态和逐页验证结果；本地verification/保存离线截图与失败证据，不放入交接ZIP。验证逐像素比较源页面与离线HTML，差异占比超过0.1%会失败；通过不等于所有页面都是0像素差，具体见pixelDiff。浅深主题通过页面工具切换。
- theme-tokens.css是原始主题样式参考，不是独立可加载的Tailwind产物；每个HTML已内联编译后的实际CSS。

## 重新导出

在项目根目录执行：

```bash
node --max-old-space-size=1536 scripts/design-export/export.mjs
# 定向更新某个页面族
node --max-old-space-size=1536 scripts/design-export/export.mjs --only settings-,providers-
# 只更新已有HTML的离线导航，逐页校验视觉不变
node --max-old-space-size=1536 scripts/design-export/export.mjs --navigation-only
```

工具只启动独立本地Renderer与隔离浏览器，不启动Electron或runtime-host，也不修改生产源码。
