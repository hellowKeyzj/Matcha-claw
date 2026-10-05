# Wiki 本地向量资源

Wiki 独立使用 `Xenova/all-MiniLM-L6-v2`（FP32，384 维），不依赖 OpenClaw 插件或 Node 推理。模型偏英语，中文/多语言检索效果有限；需要更好的中文效果时选择远端 embedding，并完整重建向量索引。

```sh
pnpm run download:wiki-assets                    # 显式下载当前平台资源
pnpm run download:wiki-assets -- --all           # 下载五个支持平台
pnpm run download:wiki-assets -- --platform win32 --arch arm64
node scripts/download-wiki-assets.mjs --check   # 纯文件检查，不下载、不加载模型
node scripts/download-wiki-assets.mjs --check --all
```

`dev`、`build` 与各 `package:*` 入口只做目标平台 `--check`，缺资源时提示显式下载；启动不加载模型。模型由 Wiki Rust owner 在第一次本地 embedding 时加载。

实际布局（原生库直接位于架构目录，无 `lib` 或 `node_modules` 层）：

```text
resources/wiki/
  models/Xenova/all-MiniLM-L6-v2/
    config.json
    tokenizer.json
    tokenizer_config.json
    onnx/model.onnx
  onnxruntime/
    win32/{x64,arm64}/{onnxruntime.dll,DirectML.dll,dxcompiler.dll,dxil.dll}
    linux/{x64,arm64}/libonnxruntime.so.1
    darwin/arm64/libonnxruntime.1.24.3.dylib
  MINILM-LICENSE.txt
  MINILM-MODEL-CARD.md                 # 显式下载时获取的官方模型卡
  ONNXRUNTIME-LICENSE.txt
  ONNXRUNTIME-ThirdPartyNotices.txt
```

支持 Windows x64/arm64、Linux x64/arm64、macOS arm64。官方 `onnxruntime-node@1.24.3` 包没有 macOS x64 库，因此该平台本地 MiniLM 不可用；检查会明确警告，但不阻止应用原有 macOS x64 打包。不复制 `onnxruntime_binding.node`。资源存在不代表各平台推理已实机验证。

electron-builder 将整个 `resources/` 复制到安装目录的 `process.resourcesPath/resources/`；`afterPack` 检查 `resources/wiki`，只保留目标平台/架构的原生库，保留模型和许可证。Rust 自行从 executable 祖先或当前工作目录定位 `resources/wiki`，不增加 bootstrap 路径字段。

## 固定来源与许可

- 模型：[Xenova/all-MiniLM-L6-v2，revision `751bff37182d3f1213fa05d7196b954e230abad9`](https://huggingface.co/Xenova/all-MiniLM-L6-v2/tree/751bff37182d3f1213fa05d7196b954e230abad9)，四文件通过 Hugging Face 固定 revision 直接下载；[官方模型卡](https://huggingface.co/Xenova/all-MiniLM-L6-v2/blob/751bff37182d3f1213fa05d7196b954e230abad9/README.md)。模型遵循 Apache-2.0，`MINILM-LICENSE.txt` 使用 [Sentence Transformers v2.2.2 官方许可证](https://github.com/UKPLab/sentence-transformers/blob/v2.2.2/LICENSE)原文。
- 原生库：[官方 npm registry `onnxruntime-node-1.24.3.tgz`](https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-1.24.3.tgz)，只提取所需运行库；[ORT v1.24.3 MIT LICENSE](https://github.com/microsoft/onnxruntime/blob/v1.24.3/LICENSE)和 [ThirdPartyNotices](https://github.com/microsoft/onnxruntime/blob/v1.24.3/ThirdPartyNotices.txt)原文独立保留。

本机首次准备复用了已有四模型文件和同版本原生库字节，逐文件 SHA-256 对比一致；这只是一次性复制，下载、校验与打包脚本不从插件读取资源。资产目录忽略于 Git，许可证保留在仓库；不要删除原插件资产。
