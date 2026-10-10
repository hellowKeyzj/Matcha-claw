use platform::mcp::{ToolCallOutcome, ToolProvider};
use serde_json::{Map, Value, json};

use super::team_run::TeamRunMcpFacade;

impl ToolProvider for TeamRunMcpFacade {
    fn tools(&self) -> Vec<Value> {
        vec![
            node_event_tool(),
            approval_resolve_tool(),
            graph_patch_tool(),
            graph_context_tool(),
            decision_submit_tool(),
            evidence_record_tool(),
        ]
    }

    fn call(&mut self, name: &str, arguments: &Map<String, Value>) -> Option<ToolCallOutcome> {
        match name {
            "team_graph_context"
            | "team_graph_patch"
            | "team_node_event"
            | "team_approval_resolve"
            | "team_run_decision_submit"
            | "team_evidence_record" => Some(self.call_host(name, arguments)),
            _ => None,
        }
    }
}

fn schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object", "additionalProperties": false,
        "properties": properties, "required": required,
    })
}

fn identifier() -> Value {
    json!({ "type": "string", "minLength": 1 })
}

fn graph_patch_tool() -> Value {
    let description = r#"保存当前 TeamRun 的设计，或在节点运行中修改任务正文；不启动 Run、不触发调度、不执行节点任务。

运行中修改：
1. 从当前 <team_run_context> 取 teamId/runId，从 <team_run_authority> 取 executionAuthority；先调用 team_graph_context（view=run_prompts），读取目标节点的原提示词、角色与连线。原任务已经适用则不提交修改。
2. expectedGraphVersion 使用读取结果的 graphVersion，nodeId 使用目标节点的真实标识。set_node_prompt 提交完整新正文，不是追加片段；保留仍有效的要求，只调整不适用或缺失的内容。
3. 新修改使用新的 commandId/idempotencyKey；原请求重试保持全部参数及两项标识不变。版本冲突后重读、重新生成的修改属于新请求，不能沿用旧键。
4. 只能修改本 Run 已有 work/review 的 prompt，包括当前正在执行或已完成的节点；不得改拓扑、角色或会话绑定，不传设计凭据或 baseGraphId/baseWorkflowPlanId。新正文用于后续新派发，已派发任务及同次发送重试保持原正文；修改不触发重跑。
5. 保存返回 applied 或 replayed 及当前 graphVersion，不返回任务全文；再读 run_prompts 核验目标正文。必要修改确认保存后，仍通过 team_message 的 summary/decision 提交节点结果，不用 dispatch 派任务。

运行期失败处理：版本冲突先重读再判断；提交结果未知时先核对当前正文，不盲目重发或声称已保存。授权失效即停止，不猜测或借用其他执行的凭据；executionAuthority 只用于工具参数，不写入节点正文、产物或最终回复。

运行期调用示例（以下为参数模板；{{…}} 必须替换为本次注入值、读取结果或新生成的标识，不能原样提交）：
先调用 team_graph_context：
```json
{"teamId":"{{teamId}}","runId":"{{runId}}","executionAuthority":"{{executionAuthority}}","view":"run_prompts"}
```
确认目标原任务需要调整后，调用 team_graph_patch：
```json
{"teamId":"{{teamId}}","runId":"{{runId}}","executionAuthority":"{{executionAuthority}}","expectedGraphVersion":"{{读取结果的graphVersion}}","commandId":"{{新命令标识}}","idempotencyKey":"{{新幂等键}}","operations":[{"op":"set_node_prompt","nodeId":"{{目标nodeId}}","prompt":"{{保留有效要求后的完整任务正文}}"}]}
```

启动前设计（仅当前有效设计轮次）：
调用顺序：
1. 从系统注入的 <team_design_context> 取得 teamId、runId、designEpoch、promptGeneration，先用这些原值调用 team_graph_context。不要自行编造或切换团队、Run、设计凭据。
2. 从返回值取得 graphVersion、graph.graphId、graph.workflowPlanId，分别填入 expectedGraphVersion、baseGraphId、baseWorkflowPlanId；从 roles 取得真实 roleId 及其在当前 Run 的 sessionRef。
3. operations 按数组顺序处理：先 add_node 创建新节点，再 add_edge 连线；连线两端必须已存在。add 不能覆盖已有 ID；replace 要提供完整节点或边，不是局部字段合并，replace_node 不能改变已有节点的 kind。
4. work 和 review 必须有真实负责人、非空 config.prompt，以及与该负责人当前 Run 绑定一致的 config.sessionRef。保留未修改的任务正文、绑定和 payload；端口与 action 按字段说明填写。
5. 可选字段不需要时省略，不要统一填 null。尤其 start/end 不需要 roleId，应省略；roleId:null 不合法。只提交输入 schema 定义的字段，不能把 context 的节点投影原样回传。

保存后核验返回的当前图、角色绑定、任务正文、连线和 graphVersion，后续修改基于最新返回值。只有预期变更已保存且核验通过，才能说设计已更新；最终设计还需有 start/end，所有节点沿非 rework 连线从 start 可达且能到 end，非 rework 连线不能成环。保存成功不代表任务已执行。

失败处理：按返回的具体 error 修正对应输入，不要把端口、节点引用或 schema 错误猜成权限不足。版本陈旧时重新调用 team_graph_context，基于最新图重算修改；设计 epoch/generation 失效或设计阶段已退出时停止，等待新的系统设计上下文，不能猜新值或去掉凭据绕过。未确认成功时不声称已保存。

operations 示例（不是完整调用参数）：假设 context 已有 start 节点且使用 out 输出，确有 writer→rs1、reviewer→rs2 绑定，以下新增节点和边 ID 均未使用。复用已有 start，不重复创建；实际调用须使用当前 Run 的真实 ID、端口和绑定。
```json
[
  {"op":"add_node","node":{"nodeId":"draft","title":"撰写初稿","kind":"work","maxAttempts":2,"roleId":"writer","config":{"prompt":"根据用户目标撰写初稿，说明依据并列出待核实项。","sessionRef":"rs1"}}},
  {"op":"add_node","node":{"nodeId":"review","title":"审核初稿","kind":"review","maxAttempts":2,"roleId":"reviewer","config":{"prompt":"核对初稿是否满足用户目标；通过时完成，否则给出具体修改意见并返工。","sessionRef":"rs2"}}},
  {"op":"add_node","node":{"nodeId":"end","title":"完成","kind":"end"}},
  {"op":"add_edge","edge":{"edgeId":"start-draft","sourceNodeId":"start","sourcePort":"out","targetNodeId":"draft","targetPort":"in","action":"activate"}},
  {"op":"add_edge","edge":{"edgeId":"draft-review","sourceNodeId":"draft","sourcePort":"completed","targetNodeId":"review","targetPort":"in","action":"activate"}},
  {"op":"add_edge","edge":{"edgeId":"review-end","sourceNodeId":"review","sourcePort":"completed","targetNodeId":"end","targetPort":"in","action":"finish"}},
  {"op":"add_edge","edge":{"edgeId":"review-rework","sourceNodeId":"review","sourcePort":"rework","targetNodeId":"draft","targetPort":"in","action":"rework"}}
]
```
反例：work 的 sourcePort 写 out、review 的 rework 出边配 activate、连到尚未创建的 targetNodeId，都会失败；但 start 的 out 和目标节点的 in 并不因此非法。"#;
    let design_schema = schema(json!({
            "teamId": { "type": "string", "minLength": 1, "description": "系统注入的 team_design_context.teamId，必须与所读 context 的团队一致。" },
            "runId": { "type": "string", "minLength": 1, "description": "系统注入的 team_design_context.runId，只修改这个 Run。" },
            "designEpoch": { "type": "string", "minLength": 1, "description": "系统注入的当前设计轮次原值；不是 graphVersion，不可自行生成。" },
            "promptGeneration": { "type": "string", "minLength": 1, "description": "系统注入的本次设计对话凭据原值；失效时等待新上下文，不可猜测或递增。" },
            "expectedGraphVersion": { "type": "string", "pattern": "^[0-9a-f]{64}$", "description": "最近一次成功 context/patch 返回的 graphVersion，原样传入这段 64 位小写十六进制字符串；版本陈旧时重读图。" },
            "commandId": { "type": "string", "minLength": 1, "description": "本次修改的唯一命令标识；原请求重试时保持不变，修改内容后使用新标识。" },
            "idempotencyKey": { "type": "string", "minLength": 1, "description": "本次修改的幂等键；同一请求重试复用原键与 commandId，不同修改不能复用同一键。" },
            "baseGraphId": { "type": "string", "minLength": 1, "description": "最近 context 返回的 graph.graphId 原值，不是 runId 或 graphVersion。" },
            "baseWorkflowPlanId": { "type": "string", "minLength": 1, "description": "最近 context 返回的 graph.workflowPlanId 原值，不可另造计划 ID。" },
            "operations": {
                "type": "array", "minItems": 1,
                "description": "非空、有顺序的修改列表：先创建节点，再引用节点连线。replace 是完整替换，不是局部合并。整份修改通过校验后才保存。",
                "items": { "oneOf": [
                    schema(json!({
                        "op": { "enum": ["add_node", "replace_node"], "description": "add_node 使用未占用的 nodeId；replace_node 完整替换已有节点，保留原 kind 和仍需使用的配置。" },
                        "node": node_schema()
                    }), &["op", "node"]),
                    schema(json!({ "op": { "const": "remove_node", "description": "删除已有节点，同时删除其关联连线和位置；不要随后再次删除已随节点移除的边。" }, "nodeId": identifier() }), &["op", "nodeId"]),
                    schema(json!({
                        "op": { "enum": ["add_edge", "replace_edge"], "description": "add_edge 使用未占用的 edgeId；replace_edge 完整替换已有边。两端节点必须在此操作之前已存在。" },
                        "edge": edge_schema()
                    }), &["op", "edge"]),
                    schema(json!({ "op": { "const": "remove_edge", "description": "删除当前仍存在的边，edgeId 从 context 或本次前序操作取得。" }, "edgeId": identifier() }), &["op", "edgeId"]),
                    schema(json!({
                        "op": { "const": "set_metadata", "description": "逐键设置图元数据；不是节点配置。值限标识字符串、布尔值或非负整数，不用 null 删除键。" },
                        "metadata": { "type": "object", "minProperties": 1, "additionalProperties": { "oneOf": [{ "type": "string" }, { "type": "boolean" }, { "type": "integer", "minimum": 0, "maximum": u64::MAX }] } }
                    }), &["op", "metadata"])
                ] }
            }
        }), &["teamId", "runId", "designEpoch", "promptGeneration", "expectedGraphVersion", "commandId", "idempotencyKey", "baseGraphId", "baseWorkflowPlanId", "operations"]);
    let runtime_schema = schema(json!({
        "teamId": identifier(),
        "runId": identifier(),
        "executionAuthority": execution_authority_schema(),
        "expectedGraphVersion": {"type":"string", "pattern":"^[0-9a-f]{64}$", "description":"最近 run_prompts 返回的 graphVersion；冲突时重读再重算。"},
        "commandId": { "type": "string", "minLength": 1, "description": "本次修改的唯一命令标识；原请求重试时保持不变，修改内容后使用新标识。" },
        "idempotencyKey": { "type": "string", "minLength": 1, "description": "本次修改的幂等键；同一请求重试复用原键与 commandId，不同修改不能复用同一键。" },
        "operations": {"type":"array", "minItems":1, "items":schema(json!({
            "op":{"const":"set_node_prompt"},
            "nodeId":identifier(),
            "prompt":{"type":"string", "minLength":1, "description":"替换目标 work/review 的完整任务正文，必须含非空白内容。"}
        }), &["op","nodeId","prompt"])}
    }), &["teamId","runId","executionAuthority","expectedGraphVersion","commandId","idempotencyKey","operations"]);
    json!({
        "name": "team_graph_patch",
        "description": description,
        "inputSchema": {"type":"object", "oneOf":[design_schema, runtime_schema]}
    })
}

fn execution_authority_schema() -> Value {
    json!({"type":"string", "minLength":1, "maxLength":4096, "description":"当前节点 team_run_authority.executionAuthority 原值；仅供本 Run 当前执行使用，不可猜测、转交或输出。"})
}

fn node_schema() -> Value {
    schema(
        json!({
            "nodeId": { "type": "string", "minLength": 1, "description": "图内唯一节点 ID；新增用未占用值，替换用 context 中的原值。" },
            "title": { "type": "string", "minLength": 1, "description": "非空节点标题；具体任务要求写入 config.prompt。" },
            "kind": { "enum": ["start", "work", "review", "human_decision", "script_review", "join", "end"], "description": "节点类型。设计中的 work/review 必须有任务正文和真实成员绑定；start/end 等控制节点不需要负责人。" },
            "maxAttempts": { "type": "integer", "minimum": 1, "maximum": u32::MAX, "description": "节点总尝试次数，包含初次执行：2 表示初次加一次返工，省略时默认为 1。返工目标和会重新执行的审核等路径节点都要留足次数；优先于 config.maxAttempts。" },
            "taskId": { "type": "string", "minLength": 1, "description": "work 的任务 ID，图内不能与其他 work 重复；省略时使用 nodeId。" },
            "roleId": { "type": "string", "minLength": 1, "description": "work/review 的真实 roleId，从 context.roles 选择，不能用角色显示名称或臆造角色；不需要负责人时省略，不能传 null。" },
            "groupId": { "type": ["string", "null"], "minLength": 1, "description": "work 所属组或 join 汇合的组 ID；work 无分组时可省略或传 null，join 应填写要汇合的组。" },
            "executor": schema(json!({ "roleId": { "type": "string", "minLength": 1, "description": "未提供节点 roleId 时使用此真实角色 ID；通常直接填写节点 roleId，不要同时填相互冲突的值。" } }), &["roleId"]),
            "config": schema(json!({
                "prompt": { "type": "string", "description": "work/review 的任务正文，必须包含非空白内容，写清目标、输入和完成或审核标准；不能只写 title。" },
                "outputArtifactKind": { "type": "string", "minLength": 1, "description": "work 的预期产物类型；不需要时省略，不能传 null。" },
                "sessionRef": { "type": "string", "minLength": 1, "pattern": "^rs[0-9]+$", "description": "从 context.roles 取该 roleId 在当前 Run 的 sessionRef 并原样保留，必须与现有绑定完全一致。这是 rsN 形式的 RoleSessionRef，不是原生 session ID/key；不能借用其他角色或 Run 的值，也不要猜 rs1。" },
                "maxAttempts": { "type": "integer", "minimum": 1, "maximum": u32::MAX, "description": "未提供节点级 maxAttempts 时使用的尝试次数；不要同时填相互冲突的值。" },
                "join": schema(json!({
                    "requireCompleted": { "type": "boolean" },
                    "allowFailed": { "type": "boolean" },
                    "retryLimit": { "type": "integer", "minimum": 0, "maximum": u32::MAX }
                }), &["requireCompleted", "allowFailed", "retryLimit"]),
                "trigger": { "oneOf": [
                    schema(json!({ "mode": { "const": "cron" }, "cron": identifier() }), &["mode", "cron"]),
                    schema(json!({ "mode": { "const": "webhook" }, "path": identifier() }), &["mode"])
                ] }
            }), &[])
        }),
        &["nodeId", "title", "kind"],
    )
}

fn edge_schema() -> Value {
    schema(
        json!({
            "edgeId": { "type": "string", "minLength": 1, "description": "图内唯一边 ID；新增不能复用已有 ID，替换必须使用已有 ID。" },
            "sourceNodeId": { "type": "string", "minLength": 1, "description": "源节点 ID，必须在当前图或本次前序 add_node 中已存在。" },
            "sourcePort": { "type": "string", "minLength": 1, "description": "源节点输出端口，必须显式填写：work 只能 completed；带任务分配的 review 只能 completed（通过）或 rework（返工）。任何节点的 rework 端口都必须配 action=rework，completed 端口不能配 action=rework。其他控制节点保留其实际端口；start.out 不因上述 work/review 规则而非法。" },
            "targetNodeId": { "type": "string", "minLength": 1, "description": "目标节点 ID，必须在当前图或本次前序 add_node 中已存在；仅在连线中写 ID 不会创建节点。" },
            "targetPort": { "type": "string", "minLength": 1, "description": "目标输入端口，显式填写非空字符串并保留原约定，例如 in 或 input；work/review 的输出端口限制不适用于 targetPort。" },
            "action": { "enum": ["activate", "rework", "gate", "finish"], "description": "activate：当前边满足即激活目标，不等待其他上游；gate：等待目标的全部 gate 入边满足后激活；finish：激活目标，通常连接 end，并非立即结束整个 Run；rework：开启返工轮次。多成员全部完成才审核时，各成员 completed→review 都用 gate，不能用 activate。同一 review.rework 的多条返工边会让所有目标返工，不会自动选择其中一个。" },
            "payload": schema(json!({ "includeUpstreamResult": { "type": "boolean", "description": "是否将上游结果带给下游；省略 payload 时默认为 true，替换边时保留原意图。" } }), &["includeUpstreamResult"]),
            "dependency": { "description": "可选任务依赖元数据，省略或 null 表示无此元数据；不能代替实际连线或 gate 的等待语义。", "oneOf": [
                schema(json!({ "dependencyTaskId": identifier(), "taskId": identifier() }), &["dependencyTaskId", "taskId"]),
                { "type": "null" }
            ] }
        }),
        &[
            "edgeId",
            "sourceNodeId",
            "sourcePort",
            "targetNodeId",
            "targetPort",
            "action",
        ],
    )
}

fn graph_context_tool() -> Value {
    json!({
        "name": "team_graph_context",
        "description": r#"读取当前 TeamRun 图的上下文，不修改图、不启动执行。运行中修改任务正文前使用 run_prompts；启动前设计使用设计凭据，两种授权不能混用。

设计读取：
- 从系统注入的 <team_design_context> 原样取 teamId、runId、designEpoch、promptGeneration；同时提供两项设计凭据，建议 view=graph_summary，不需要 nodeExecutionId。
- 返回完整设计快照：graphVersion、graph（含 graphId、workflowPlanId、节点标题、任务正文、角色绑定、连线端口、payload、布局）及 roles。patch 的 expectedGraphVersion/baseGraphId/baseWorkflowPlanId 分别取 graphVersion/graph.graphId/graph.workflowPlanId；work/review 的 roleId 和 sessionRef 从当前 Run 的 roles 配对取得，不能从显示名称或原生会话标识推断。
- 没有有效设计上下文时，不要猜 epoch/generation，也不要用脱敏视图冒充可编辑快照。设计凭据失效或已离开设计阶段时停止，等待新的系统上下文；版本陈旧则用仍有效的设计凭据重读。

运行中任务正文：
- view=run_prompts，提供 <team_run_context> 的 teamId/runId 及 <team_run_authority> 的 executionAuthority，不传 designEpoch/promptGeneration/nodeExecutionId。
- 成功返回 outcome=available、teamId/runId、graphVersion、nodes 和 edges；work/review 节点含 nodeId、kind、title、roleId、prompt，控制节点不含 roleId/prompt。这里的 prompt 是当前保存的正文，不代表正在执行任务的派发快照。
- 用注入的 nodeId 在 nodes 中定位当前节点，按 edges 的 sourceNodeId/targetNodeId、sourcePort/action 判断后续路径；经过控制节点时继续沿连线查找目标工作或审核节点，不按角色猜节点，也不把所有可达节点都当成下一步必执行的任务。
- 需要调整任务时，将读取的 nodeId、graphVersion 用于 team_graph_patch；已经适用则不修改。本工具只读，不保存修改或推动调度。授权失效时停止，不猜值或借其他执行凭据；不要在结果中复述授权。

运行读取示例（{{…}} 替换为本次系统注入原值，不能原样提交）：
```json
{"teamId":"{{teamId}}","runId":"{{runId}}","executionAuthority":"{{executionAuthority}}","view":"run_prompts"}
```

脱敏运行概览：
- 不传任何授权，view=current_node 或 graph_summary 只返回脱敏状态，不含任务正文或 graphVersion，不能作为改任务依据。
- current_node 需要真实 nodeExecutionId；graph_summary 可省略。nodeExecutionId 不是 nodeId 或 runId。

收到结果先确认读取成功且对应预期 teamId/runId；失败按具体 error 处理，不把输入错误猜成权限不足。不因读取成功就声称修改已保存。

设计读取示例（假设系统本次注入的值恰好如下；实际必须替换为注入原值）：
```json
{"teamId":"team:demo","runId":"run:demo","designEpoch":"design:demo","promptGeneration":"generation:demo","view":"graph_summary"}
```
反例：只传 designEpoch 不传 promptGeneration，或从其他 Run 复制设计凭据。"#,
        "inputSchema": { "type": "object", "oneOf": [
            schema(json!({
                "teamId": identifier(),
                "runId": identifier(),
                "view": {"const":"run_prompts"},
                "executionAuthority": execution_authority_schema()
            }), &["teamId","runId","view","executionAuthority"]),
            schema(json!({
                "teamId": { "type": "string", "minLength": 1, "description": "当前目标团队的真实 ID，须与 runId 所属团队一致。" },
                "runId": { "type": "string", "minLength": 1, "description": "要读取的当前 Run ID，不是图 ID 或节点执行 ID。" },
                "view": { "enum": ["current_node", "graph_summary"], "description": "current_node 读取指定节点执行的脱敏上下文，须提供 nodeExecutionId；graph_summary 读取图概览。" },
                "nodeExecutionId": { "type": ["string", "null"], "minLength": 1, "description": "current_node 必须提供真实节点执行 ID；graph_summary 可省略或传 null，不能用 nodeId 代替。" }
            }), &["teamId", "runId", "view"]),
            schema(json!({
                "teamId": { "type": "string", "minLength": 1, "description": "系统注入的 team_design_context.teamId 原值。" },
                "runId": { "type": "string", "minLength": 1, "description": "系统注入的 team_design_context.runId 原值，只读取这个 Run。" },
                "designEpoch": { "type": "string", "minLength": 1, "description": "系统注入的当前设计轮次，必须与 promptGeneration 一起提供；不能猜测或自行创建。" },
                "promptGeneration": { "type": "string", "minLength": 1, "description": "系统为本次设计对话注入的凭据，必须与 designEpoch 配对原样传入；失效后等待新上下文。" },
                "view": { "enum": ["current_node", "graph_summary"], "description": "设计读取建议使用 graph_summary；有效设计凭据下返回完整设计快照，不是运行脱敏视图。" },
                "nodeExecutionId": { "type": ["string", "null"], "minLength": 1, "description": "设计读取无需此字段，可省略或传 null。" }
            }), &["teamId", "runId", "designEpoch", "promptGeneration", "view"])
        ] }
    })
}

fn approval_resolve_tool() -> Value {
    json!({
        "name": "team_approval_resolve",
        "description": "Resolve an existing TeamRun approval receipt.",
        "inputSchema": schema(json!({
            "runId": identifier(), "approvalId": identifier(),
            "decision": { "enum": ["approve", "deny", "abort"] },
            "note": { "type": ["string", "null"], "minLength": 1 },
            "idempotencyKey": identifier()
        }), &["runId", "approvalId", "decision", "idempotencyKey"])
    })
}

fn node_event_tool() -> Value {
    json!({
        "name": "team_node_event",
        "description": "Record a legacy/manual TeamRun node event. Terminal complete/reject events are accepted only as non-scheduler evidence; runtime terminal settle remains the completion path.",
        "inputSchema": { "type": "object", "allOf": [schema(json!({
            "runId": identifier(), "commandId": identifier(), "idempotencyKey": identifier(),
            "nodeExecutionId": identifier(),
            "roleId": { "type": ["string", "null"], "minLength": 1 },
            "event": { "enum": ["progress", "request_input", "request_approval", "complete", "reject"] },
            "approvalAction": { "enum": ["continue_node", "execute_tool", "publish_result", "external_action"] },
            "deliveryId": identifier(), "receipt": identifier(), "nodeId": identifier(),
            "attemptNumber": { "type": "integer", "minimum": 1, "maximum": u32::MAX },
            "summary": { "type": "string", "minLength": 1, "maxLength": 512 },
            "outputPort": identifier()
        }), &["runId", "commandId", "idempotencyKey", "nodeExecutionId", "event"]),
            {
                "if": { "properties": { "event": { "const": "request_approval" } }, "required": ["event"] },
                "then": { "required": ["approvalAction"] }
            },
            {
                "if": { "properties": { "event": { "enum": ["complete", "reject"] } }, "required": ["event"] },
                "then": { "required": ["deliveryId", "receipt", "nodeId", "attemptNumber", "summary", "outputPort"] }
            }
        ] }
    })
}

fn decision_submit_tool() -> Value {
    json!({
        "name": "team_run_decision_submit",
        "description": "Submit a TeamRun continuation decision for a paused run stage.",
        "inputSchema": schema(json!({
            "runId": identifier(), "stageId": { "type": ["string", "null"], "minLength": 1 },
            "decision": { "enum": ["retry", "proceed_degraded", "abort"] },
            "note": { "type": ["string", "null"], "minLength": 1 },
            "idempotencyKey": identifier()
        }), &["runId", "decision", "idempotencyKey"])
    })
}

fn evidence_record_tool() -> Value {
    json!({
        "name": "team_evidence_record",
        "description": "Record an opaque artifact evidence reference for a current TeamRun node execution.",
        "inputSchema": schema(json!({
            "evidenceId": identifier(), "runId": identifier(), "nodeExecutionId": identifier(),
            "referenceKind": { "const": "artifact" }, "reference": identifier(),
            "label": { "type": ["string", "null"], "minLength": 1 }
        }), &["evidenceId", "runId", "nodeExecutionId", "referenceKind", "reference"])
    })
}
