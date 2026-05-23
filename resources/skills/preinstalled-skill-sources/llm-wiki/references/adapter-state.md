# 外挂状态模型

外挂失败统一分成 `not_installed / env_unavailable / runtime_failed / unsupported / empty_result` 五类。

所有需要枚举来源、读取 `source_label`、`raw_dir`、`adapter_name`、`fallback_hint` 的地方，都先读来源总表：

```bash
bash ${SKILL_DIR}/scripts/source-registry.sh list
```

需要拿单个来源的定义时，用：

```bash
bash ${SKILL_DIR}/scripts/source-registry.sh get <source_id>
```

对 URL 类来源，先运行：

```bash
bash ${SKILL_DIR}/scripts/adapter-state.sh check <source_id>
```

`adapter-state.sh check` 返回 8 列：

```text
source_id	source_label	state	state_label	detail	recovery_action	install_hint	fallback_hint
```

- `not_installed`：提示用户可补安装，同时允许改走手动入口
- `env_unavailable`：说明缺少的环境条件，同时允许改走手动入口
- `runtime_failed`：说明本次提取执行失败，允许重试一次，再改走手动入口
- `unsupported`：直接给出手动入口，不尝试自动提取
- `empty_result`：说明自动提取没拿到有效内容，请用户手动补全文本

当自动提取实际执行后，再运行：

```bash
bash ${SKILL_DIR}/scripts/adapter-state.sh classify-run <source_id> <exit_code> <output_path>
```

用返回的 `detail`、`recovery_action`、`install_hint`、`fallback_hint` 生成提示。核心主线不因外挂失败而中断。

---
