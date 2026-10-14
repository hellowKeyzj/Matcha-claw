use platform::mcp::{ToolCallFuture, ToolProvider};
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

    fn call<'a>(
        &'a self,
        name: &'a str,
        arguments: &'a Map<String, Value>,
    ) -> Option<ToolCallFuture<'a>> {
        if !is_team_tool(name) {
            return None;
        }
        Some(Box::pin(self.call_host(name, arguments)))
    }
}

pub fn is_team_tool(name: &str) -> bool {
    matches!(
        name,
        "team_graph_context"
            | "team_graph_patch"
            | "team_node_event"
            | "team_approval_resolve"
            | "team_run_decision_submit"
            | "team_evidence_record"
    )
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
    let description = r#"保存 TeamRun 图；不启动 Run、不触发调度、不执行节点任务。设计操作与运行中 set_node_prompt 不能混批。

运行中修改：
1. 外层 teamId/runId/nodeId/nodeExecutionId 全部取本次 <team_run_context> 原值；先用相同四项调用 team_graph_context（view=run_prompts）读取原任务、角色与连线。不能用待修改的目标节点替换外层 nodeId，也不能借用其他节点或旧尝试的执行标识。
2. 任务已适用则不改；否则 operations 中只用 set_node_prompt，op/nodeId/prompt 同层，不传 node/config。operations[i].nodeId 从上下文选取目标节点；expectedGraphVersion 取返回的 graphVersion，prompt 提交保留有效要求后的完整正文，不是追加片段。
3. 仅改本 Run 已有 work/review 的 prompt，包括正在执行或已完成的节点；不改拓扑、角色或绑定，不传设计上下文参数及 baseGraphId/baseWorkflowPlanId。新正文只用于后续新派发，已派发任务及同次发送重试不变，不触发重跑。
4. 新修改生成 commandId/idempotencyKey；重放原请求须保持全部参数不变。版本冲突先重读再判断，重算修改用新键；结果未知先核对正文，不盲目重发。当前执行失效即停止，等待新的系统上下文，不猜执行标识。
5. 确认 applied/replayed 后重读 team_graph_context（view=run_prompts）核验；未确认不声称保存。完成当前任务仍用 team_message 的 summary/decision，不用 dispatch 派任务。

运行期调用模板（{{…}} 替换为本次注入值、读取结果或新标识，不能原样提交）：
```json
{"teamId":"{{teamId}}","runId":"{{runId}}","nodeId":"{{当前调用节点nodeId}}","nodeExecutionId":"{{当前调用节点nodeExecutionId}}","expectedGraphVersion":"{{graphVersion}}","commandId":"{{新命令标识}}","idempotencyKey":"{{新幂等键}}","operations":[{"op":"set_node_prompt","nodeId":"{{目标nodeId}}","prompt":"{{完整任务正文}}"}]}
```

启动前设计（仅当前有效设计轮次）：
调用顺序：
1. 从系统注入的 <team_design_context> 取得 teamId、runId、designEpoch、promptGeneration，先用这些原值调用 team_graph_context。不要自行编造或切换团队、Run、设计上下文参数；设计 patch 不传外层 nodeId/nodeExecutionId。
2. 从返回值取得 graphVersion、graph.graphId、graph.workflowPlanId，分别填入 expectedGraphVersion、baseGraphId、baseWorkflowPlanId；从 roles 取得真实 roleId 及其在当前 Run 的 sessionRef。
3. operations 按数组顺序校验：先 add_node 创建新节点，再 add_edge 连线；连线两端必须已存在。省略的端口、action 和依赖任务 ID 按本批节点操作后的最终节点集合解析，因此边引用的节点也必须保留在批次最终图中。add 不能覆盖已有 ID；replace 要提供完整节点或边，不是局部字段合并，replace_node 不能改变已有节点的 kind。
4. work 和 review 必须有真实 roleId 和非空 config.prompt；该角色在当前 Run 恰有一个会话绑定时省略 config.sessionRef，由程序在保存锁内解析。多候选必须从 roles 显式选择匹配的 config.sessionRef；零候选需重新读取并选择有效角色，不能猜 rs0/rs1。显式 null、空值或错值不会按省略处理。保留未修改的任务正文、绑定和 payload；程序按节点类型确定端口：单出口省略 sourcePort，只有多出口节点才按业务分支选择 context 中该节点 sourcePorts 的一个值；同批新增节点按 sourcePort 字段说明中的类型分支选择。targetPort 通常省略，由程序选目标的唯一入口；无入口/出口的节点不能作为对应端点。
5. join 是无组、无任务正文的程序同步节点，不调用模型做汇总；只等待全部 gate 入边的上游当前尝试成功完成且选中对应 sourcePort，不能用 activate/finish/rework 接入 join。需要模型撰写汇总时另建有负责人和 prompt 的 work/review。join 不接收 groupId、group 或 config.join；config 省略或 {}。可暂存未接线的 join，但启动执行前至少接入一条 gate。
6. 上游摘要按边的 payload.includeUpstreamResult 与已消费 source fence 对应的精确尝试透传，join 不生成新摘要，也不把所有历史结果混入；控制节点正常完成并选择 rejected/failed 等业务端口仍可满足匹配 gate，不等同于尝试 Failed/Cancelled。
7. script_review 必须显式提供 config.rule，没有默认通过，也不执行脚本正文：pass_through 无条件通过；assert_all_upstream_completed 检查本次尝试全部非 rework 入边的已消费输入及其精确上游尝试 Completed/端口，零输入不通过；assert_no_blocking_gate 只检查 gate 输入，零 gate 通过；assert_artifact_exists 要求本 Run 已消费的直接上游尝试至少有一个 typed Artifact，不检查脚本节点自身、无关产物或祖先，也不验证文件实体存在。结果选择 passed/failed 业务端口，不等于尝试失败。
8. human_decision 不需要负责人或任务正文，config 省略或 {}；程序按当前尝试与真实团队负责人生成审批，等待明确人工决定后选择 approved/rejected/aborted。
9. 可选字段不需要时省略，不要统一填 null。尤其 start/end/join/human_decision/script_review 不需要 roleId，应省略；roleId:null 不合法。只提交输入 schema 定义的字段，不能把 context 的节点投影原样回传。

保存后核验返回的当前图、角色绑定、任务正文、连线和 graphVersion，后续修改基于最新返回值。只有预期变更已保存且核验通过，才能说设计已更新；最终设计还需有 start/end，所有节点沿非 rework 连线从 start 可达且能到 end，非 rework 连线不能成环。保存成功不代表任务已执行。

失败处理：按返回的具体 error 修正对应输入，不要把端口、节点引用或 schema 错误猜成权限不足。版本陈旧时重新调用 team_graph_context，基于最新图重算修改；设计轮次或设计对话代次失效、设计阶段已退出时停止，等待新的系统设计上下文，不能猜新值或省略设计上下文参数绕过。未确认成功时不声称已保存。

设计期 replace_node 调用模板（示例为已有 work，{{…}} 替换为当前设计上下文、读取结果或新标识；完整保留该节点原有 maxAttempts/taskId/outputArtifactKind 等可选配置，不原样回传投影）：
```json
{"teamId":"{{teamId}}","runId":"{{runId}}","designEpoch":"{{designEpoch}}","promptGeneration":"{{promptGeneration}}","expectedGraphVersion":"{{graphVersion}}","commandId":"{{新命令标识}}","idempotencyKey":"{{新幂等键}}","baseGraphId":"{{graph.graphId}}","baseWorkflowPlanId":"{{graph.workflowPlanId}}","operations":[{"op":"replace_node","node":{"nodeId":"{{原nodeId}}","title":"{{原title}}","kind":"work","roleId":"{{原roleId}}","config":{"prompt":"{{完整任务正文}}","sessionRef":"{{原sessionRef}}"}}]}
```

设计建图 operations 示例（不是完整调用参数）：假设 context 已有 start，writer→rs1、reviewer→rs2 绑定有效，以下新 ID 均未使用；实际用当前 Run 的 ID 和绑定。单出口和目标入口省略，审核选择通过或返工分支。
```json
[
  {"op":"add_node","node":{"nodeId":"draft","title":"撰写初稿","kind":"work","maxAttempts":2,"roleId":"writer","config":{"prompt":"根据用户目标撰写初稿，说明依据并列出待核实项。","sessionRef":"rs1"}}},
  {"op":"add_node","node":{"nodeId":"review","title":"审核初稿","kind":"review","maxAttempts":2,"roleId":"reviewer","config":{"prompt":"核对初稿是否满足用户目标；通过时完成，否则给出具体修改意见并返工。","sessionRef":"rs2"}}},
  {"op":"add_node","node":{"nodeId":"end","title":"完成","kind":"end"}},
  {"op":"add_edge","edge":{"edgeId":"start-draft","sourceNodeId":"start","targetNodeId":"draft","action":"activate"}},
  {"op":"add_edge","edge":{"edgeId":"draft-review","sourceNodeId":"draft","targetNodeId":"review","action":"activate"}},
  {"op":"add_edge","edge":{"edgeId":"review-end","sourceNodeId":"review","sourcePort":"completed","targetNodeId":"end","action":"finish"}},
  {"op":"add_edge","edge":{"edgeId":"review-rework","sourceNodeId":"review","sourcePort":"rework","targetNodeId":"draft","action":"rework"}}
]
```
反例：任何端口填写 default、out 或 in，review 省略分支、review.rework 配 activate、End 作为源、Start 作为目标，或连到尚未创建的节点，都会失败；不要用别名或空值代替省略。"#;
    let mut input_schema = schema(json!({
            "teamId": { "type": "string", "minLength": 1, "description": "本次 team_design_context 或 team_run_context 的 teamId 原值，必须与所读 context 的团队一致。" },
            "runId": { "type": "string", "minLength": 1, "description": "本次 team_design_context 或 team_run_context 的 runId 原值，只修改这个 Run。" },
            "nodeId": { "type": "string", "minLength": 1, "description": "运行修改时取本次 team_run_context.nodeId 原值，标识当前调用节点；不是 operations 中的目标节点。设计修改不传。" },
            "nodeExecutionId": { "type": "string", "minLength": 1, "description": "运行修改时取本次 team_run_context.nodeExecutionId 原值，须属于当前调用节点的当前执行，不能借用其他节点或旧尝试。设计修改不传。" },
            "designEpoch": { "type": "string", "minLength": 1, "description": "系统注入的当前设计轮次原值；不是 graphVersion，不可自行生成。" },
            "promptGeneration": { "type": "string", "minLength": 1, "description": "系统注入的本次设计对话代次原值；失效时等待新上下文，不可猜测或递增。" },
            "expectedGraphVersion": { "type": "string", "pattern": "^[0-9a-f]{64}$", "description": "最近一次成功 context/patch 返回的 graphVersion，原样传入这段 64 位小写十六进制字符串；版本陈旧时重读图。" },
            "commandId": { "type": "string", "minLength": 1, "description": "本次修改的唯一命令标识；原请求重试时保持不变，修改内容后使用新标识。" },
            "idempotencyKey": { "type": "string", "minLength": 1, "description": "本次修改的幂等键；同一请求重试复用原键与 commandId，不同修改不能复用同一键。" },
            "baseGraphId": { "type": "string", "minLength": 1, "description": "最近 context 返回的 graph.graphId 原值，不是 runId 或 graphVersion。" },
            "baseWorkflowPlanId": { "type": "string", "minLength": 1, "description": "最近 context 返回的 graph.workflowPlanId 原值，不可另造计划 ID。" },
            "operations": {
                "type": "array", "minItems": 1,
                "description": "非空、有顺序的修改列表：设计时先创建节点，再引用节点连线，replace 是完整替换而非局部合并；运行时全部操作必须为 set_node_prompt，不能混入设计操作。整份修改通过校验后才保存。",
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
                    }), &["op", "metadata"]),
                    schema(json!({
                        "op": { "const": "set_node_prompt", "description": "运行中仅替换已有 work/review 的任务正文，不修改拓扑、角色或绑定。" },
                        "nodeId": { "type": "string", "minLength": 1, "description": "要修改正文的目标 work/review 节点 ID，从本 Run 上下文选取；不是外层当前调用节点的标识。" },
                        "prompt": { "type": "string", "minLength": 1, "description": "替换目标 work/review 的完整任务正文，必须含非空白内容。" }
                    }), &["op", "nodeId", "prompt"])
                ] }
            }
        }), &["teamId", "runId", "expectedGraphVersion", "commandId", "idempotencyKey", "operations"]);
    input_schema["if"] = json!({
        "properties": { "operations": { "contains": {
            "type": "object", "properties": { "op": { "const": "set_node_prompt" } }, "required": ["op"]
        } } },
        "required": ["operations"]
    });
    input_schema["then"] = json!({
        "required": ["nodeId", "nodeExecutionId"],
        "properties": {
            "designEpoch": false, "promptGeneration": false,
            "baseGraphId": false, "baseWorkflowPlanId": false,
            "operations": { "items": { "properties": { "op": { "const": "set_node_prompt" } } } }
        }
    });
    input_schema["else"] = json!({
        "required": ["designEpoch", "promptGeneration", "baseGraphId", "baseWorkflowPlanId"],
        "properties": { "nodeId": false, "nodeExecutionId": false }
    });
    json!({
        "name": "team_graph_patch",
        "description": description,
        "inputSchema": input_schema
    })
}

fn node_schema() -> Value {
    let prompt = json!({ "type": "string", "minLength": 1, "description": "work/review 的任务正文，必须包含非空白内容，写清目标、输入和完成或审核标准；不能只写 title。" });
    let session_ref = json!({ "type": "string", "minLength": 1, "pattern": "^rs[0-9]+$", "description": "该 roleId 在当前 Run 恰有一个绑定时省略，由保存事务解析；多候选必须从 context.roles 显式选择匹配值，零候选应选择有效角色。显式值必须与当前绑定完全一致，不能用 null、空串或错值代替省略。这是 rsN 形式的 RoleSessionRef，不是原生 session ID/key；不猜 rs0/rs1，不借用其他角色或 Run 的值。" });
    let mut node = schema(
        json!({
            "nodeId": { "type": "string", "minLength": 1, "description": "图内唯一节点 ID；新增用未占用值，替换用 context 中的原值。" },
            "title": { "type": "string", "minLength": 1, "description": "非空节点标题；具体任务要求写入 config.prompt。" },
            "kind": { "enum": ["start", "work", "review", "human_decision", "script_review", "join", "end"], "description": "节点类型。设计中的 work/review 必须有任务正文和真实成员绑定；start/end 等控制节点不需要负责人。" },
            "maxAttempts": { "type": "integer", "minimum": 1, "maximum": u32::MAX, "description": "节点总尝试次数，包含初次执行：2 表示初次加一次返工，省略时默认为 1。返工目标和会重新执行的审核等路径节点都要留足次数。" },
            "taskId": { "type": "string", "minLength": 1, "description": "work 的任务 ID，图内不能与其他 work 重复；省略时使用 nodeId。" },
            "roleId": { "type": "string", "minLength": 1, "description": "work/review 的真实 roleId，从 context.roles 选择，不能用角色显示名称或臆造角色；不需要负责人时省略，不能传 null。" },
            "config": { "type": "object", "description": "仅使用当前 kind 分支定义的配置；不需要配置时省略。" }
        }),
        &["nodeId", "title", "kind"],
    );
    node["oneOf"] = json!([
        {
            "properties": {
                "kind": { "const": "start" },
                "config": schema(json!({ "trigger": { "oneOf": [
                    schema(json!({ "mode": { "const": "cron" }, "cron": identifier() }), &["mode", "cron"]),
                    schema(json!({ "mode": { "const": "webhook" }, "path": { "type": "string", "minLength": 1, "pattern": "\\S", "description": "webhook 必须提供非空白路径；手动 Start 不传 trigger。" } }), &["mode", "path"])
                ] } }), &[])
            }
        },
        {
            "required": ["roleId", "config"],
            "properties": {
                "kind": { "const": "work" },
                "config": schema(json!({
                    "prompt": prompt,
                    "sessionRef": session_ref,
                    "outputArtifactKind": { "type": "string", "minLength": 1, "description": "work 的预期产物类型；不需要时省略，不能传 null。" }
                }), &["prompt"])
            }
        },
        {
            "required": ["roleId", "config"],
            "properties": {
                "kind": { "const": "review" },
                "config": schema(json!({ "prompt": prompt, "sessionRef": session_ref }), &["prompt"])
            }
        },
        {
            "required": ["config"],
            "properties": {
                "kind": { "const": "script_review" },
                "config": schema(json!({
                    "rule": { "enum": ["pass_through", "assert_all_upstream_completed", "assert_no_blocking_gate", "assert_artifact_exists"], "description": "显式选择程序审核规则；没有默认规则，不接受脚本正文。" }
                }), &["rule"])
            }
        },
        {
            "properties": {
                "kind": { "enum": ["human_decision", "join", "end"] },
                "config": schema(json!({}), &[])
            }
        }
    ]);
    node
}

fn edge_schema() -> Value {
    use crate::NodeKind;
    let kinds = [
        ("start", NodeKind::Start),
        ("work", NodeKind::Work),
        ("review", NodeKind::Review),
        ("human_decision", NodeKind::HumanDecision),
        ("script_review", NodeKind::ScriptReview),
        ("join", NodeKind::Join),
        ("end", NodeKind::End),
    ];
    let source_ports = kinds
        .iter()
        .flat_map(|(_, kind)| kind.source_ports())
        .map(|port| port.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let target_ports = kinds
        .iter()
        .flat_map(|(_, kind)| kind.target_ports())
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let branches = kinds
        .iter()
        .filter(|(_, kind)| kind.source_ports().len() > 1)
        .map(|(name, kind)| {
            format!(
                "{name}: {}",
                kind.source_ports()
                    .iter()
                    .map(|port| port.as_str())
                    .collect::<Vec<_>>()
                    .join(" / ")
            )
        })
        .collect::<Vec<_>>()
        .join("；");
    let source_description = format!(
        "单出口省略，由程序确定；多出口必须从源节点 sourcePorts 选择业务分支。同批新增节点尚不在 context 时，按类型选择：{branches}。值须精确匹配源节点，不接受别名、空串或 null；无出口节点不能作为源。"
    );
    schema(
        json!({
            "edgeId": { "type": "string", "minLength": 1, "description": "图内唯一边 ID；新增不能复用已有 ID，替换必须使用已有 ID。" },
            "sourceNodeId": { "type": "string", "minLength": 1, "description": "源节点 ID，必须在当前图或本次前序 add_node 中已存在。" },
            "sourcePort": { "enum": source_ports, "description": source_description },
            "targetNodeId": { "type": "string", "minLength": 1, "description": "目标节点 ID，必须在当前图或本次前序 add_node 中已存在；仅在连线中写 ID 不会创建节点。" },
            "targetPort": { "enum": target_ports, "description": "通常省略，程序按目标节点唯一入口确定；显式值必须在目标 targetPorts 中。无入口的 Start 不能作为目标；不接受 in、default、空串或 null。" },
            "action": { "enum": ["activate", "rework", "gate", "finish"], "description": "先确定端口，再取源节点 sourcePortActions 对应端口的动作与目标约束的交集（join 仅允许 gate）：唯一合法动作可省略，多个合法动作必须按业务显式选择，无合法动作则拒绝连线；没有默认 activate。activate：当前边满足即激活，不等其他上游；gate：全部 gate 入边的上游当前尝试 Completed 且选中对应 sourcePort 才激活，Failed/Cancelled 不满足；finish：激活目标，通常连接 end，不立即结束 Run；rework：开启返工轮次，不能直接指向 join。多成员全部完成才审核时，各成员 completed→review 都用 gate。同一 review.rework 的多条返工边会让所有目标返工；review.rework 必须用 rework，其它只有 human_decision 的 rejected/aborted 和 script_review 的 failed 分支允许 rework。控制节点正常完成的拒绝/失败业务端口可匹配 gate，不能与尝试失败混淆。" },
            "payload": schema(json!({ "includeUpstreamResult": { "type": "boolean", "description": "是否将上游结果带给下游；省略 payload 时默认为 true，替换边时保留原意图。" } }), &["includeUpstreamResult"]),
            "dependency": { "description": "可选任务依赖元数据，省略或 null 表示无此元数据。work→work 可传 {}，程序从两端 taskId 派生省略项；显式 dependencyTaskId/taskId 必须分别匹配源/目标任务。其他节点组合必须显式提供两个不透明标识。不能代替连线或 gate 等待语义。", "oneOf": [
                schema(json!({ "dependencyTaskId": identifier(), "taskId": identifier() }), &[]),
                { "type": "null" }
            ] }
        }),
        &["edgeId", "sourceNodeId", "targetNodeId"],
    )
}

fn graph_context_tool() -> Value {
    let mut input_schema = schema(json!({
        "teamId": { "type": "string", "minLength": 1, "description": "当前目标团队的真实 ID，须与 runId 所属团队一致；设计读取取 team_design_context.teamId 原值。" },
        "runId": { "type": "string", "minLength": 1, "description": "要读取的当前 Run ID，不是图 ID 或节点执行 ID；设计读取取 team_design_context.runId 原值。" },
        "designEpoch": { "type": "string", "minLength": 1, "description": "系统注入的当前设计轮次，必须与 promptGeneration 一起提供；不能猜测或自行创建。" },
        "promptGeneration": { "type": "string", "minLength": 1, "description": "系统注入的本次设计对话代次，必须与 designEpoch 配对原样传入；失效后等待新上下文。" },
        "view": { "enum": ["current_node", "graph_summary", "run_prompts"], "description": "run_prompts 使用当前调用节点的四项执行标识读取运行任务正文，不传设计上下文参数；无设计上下文参数的 current_node/graph_summary 只读脱敏状态；有效设计上下文参数下返回完整设计快照，建议 graph_summary。" },
        "nodeId": { "type": "string", "minLength": 1, "description": "仅 run_prompts 提供本次 team_run_context.nodeId 原值，标识当前调用节点，不是计划修改的目标节点。" },
        "nodeExecutionId": { "type": ["string", "null"], "minLength": 1, "description": "run_prompts 必须提供本次 team_run_context 中当前调用节点的执行 ID；无设计上下文参数的 current_node 也须提供真实非空执行 ID，不能用 nodeId 代替；graph_summary 或设计读取可省略或传 null。" }
    }), &["teamId", "runId", "view"]);
    input_schema["if"] = json!({ "properties": { "view": { "const": "run_prompts" } }, "required": ["view"] });
    input_schema["then"] = json!({
        "required": ["nodeId", "nodeExecutionId"],
        "properties": {
            "nodeExecutionId": identifier(), "designEpoch": false, "promptGeneration": false
        }
    });
    input_schema["else"] = json!({
        "properties": { "nodeId": false },
        "if": { "anyOf": [
            { "required": ["designEpoch"] },
            { "required": ["promptGeneration"] }
        ] },
        "then": { "required": ["designEpoch", "promptGeneration"] },
        "else": {
            "if": { "properties": { "view": { "const": "current_node" } }, "required": ["view"] },
            "then": { "required": ["nodeExecutionId"], "properties": { "nodeExecutionId": identifier() } }
        }
    });
    json!({
        "name": "team_graph_context",
        "description": r#"只读 TeamRun 上下文：run_prompts 提供运行任务正文和修改依据；携设计上下文参数时提供完整设计快照；其余读取只返回脱敏状态。模板 {{…}} 替换为本次系统注入原值。

运行中修改任务前读取：
- teamId/runId/nodeId/nodeExecutionId 全部取本次 <team_run_context> 原值，标识当前调用节点及其执行；view=run_prompts，不传设计上下文参数，不借用其他节点或旧尝试的执行标识。
```json
{"teamId":"{{teamId}}","runId":"{{runId}}","nodeId":"{{当前调用节点nodeId}}","nodeExecutionId":"{{当前调用节点nodeExecutionId}}","view":"run_prompts"}
```
- 成功返回 outcome=available、teamId/runId、graphVersion、nodes、edges；work/review 含 nodeId/kind/title/roleId/prompt，控制节点无 roleId/prompt。prompt 是已保存正文，不是已派发任务快照。
- 用注入 nodeId 定位当前节点，沿 edges 的 sourceNodeId/targetNodeId、sourcePort/action 判断后续路径，必要时穿过控制节点；不按角色猜节点，不把所有可达节点视为必执行。
- 需要修改才用 team_graph_patch 的 set_node_prompt（op/nodeId/prompt 同层），expectedGraphVersion 取 graphVersion；外层 nodeId 仍为当前调用节点，operations[i].nodeId 才是目标节点。不用 replace_node 或 node.config.prompt。

启动前设计读取：
- 从 <team_design_context> 原样取 teamId/runId/designEpoch/promptGeneration，两项设计上下文参数必须同时提供；建议 view=graph_summary，无需 nodeExecutionId。
```json
{"teamId":"{{teamId}}","runId":"{{runId}}","designEpoch":"{{designEpoch}}","promptGeneration":"{{promptGeneration}}","view":"graph_summary"}
```
- 返回完整设计快照 graphVersion、graph 和 roles。patch 的 expectedGraphVersion/baseGraphId/baseWorkflowPlanId 分别取 graphVersion/graph.graphId/graph.workflowPlanId；work/review 的 roleId/sessionRef 从 roles 配对取得，不猜显示名称或原生会话标识。replace_node 须按输入 schema 重建完整 node，正文放 node.config.prompt，不原样回传投影。
- graph 含任务、绑定、连线、payload、布局及 sourcePorts/targetPorts/sourcePortActions。端口空列表表示无入口/出口，单端口可省略，多出口须选业务分支；sourcePortActions 与目标约束求交（join 仅 gate），唯一 action 可省略，多候选须选择，零候选不可连线。

脱敏状态读取：
- 不传设计上下文参数，current_node 或 graph_summary 只返回脱敏状态，无任务正文或 graphVersion，不能作为修改依据。current_node 必须提供当前 nodeExecutionId，不能用 nodeId/runId 代替；graph_summary 可省略它。
```json
{"teamId":"{{teamId}}","runId":"{{runId}}","view":"current_node","nodeExecutionId":"{{nodeExecutionId}}"}
```
- current_node.approvals 仅含当前尝试的 approvalId/subject/status/decision，无 note/reason 或旧尝试审批；graph_summary.approvals 为空。pendingApprovalIds 是 Run 级待处理 ID，消失不代表批准。

确认设计读取 success=true、其余读取 outcome=available，且 teamId/runId 符合预期后再使用结果。输入错误按 error 修正；图版本陈旧先重读再重算修改；设计上下文参数或当前节点执行失效则停止，等待新的系统上下文。读取成功不代表修改已保存，patch 后须用同一读取方式核验。"#,
        "inputSchema": input_schema
    })
}

fn approval_resolve_tool() -> Value {
    json!({
        "name": "team_approval_resolve",
        "description": r#"提交已有 HumanDecision 或 WorkNode 审批的明确人工决定；工具调用本身不是人工授权，不能替人选择 approve/deny/abort。
- runId 取当前 Run；approvalId 取已提供的真实审批上下文，并确认人工决定。team_graph_context 的 view=current_node 返回的 approvals 可核对当前尝试的 subject/status/decision；Run 级 pendingApprovalIds 不说明审批类型，不能据此盲批。本工具不创建审批，输入不传 subject，owner 按已持久化的审批事实分派。
- 新决定使用新的 idempotencyKey，原请求重试保留同一键及全部参数；note 只记录真实说明，不需要时省略或 null。结果未知时先核对审批状态，不换键盲目重试。
- 检查 outcome=recorded/replayed：HumanDecision 记录回执并结算 approved/rejected/aborted 分支；WorkNode 只记录决定，保留 KeepNodeWaiting，不自动恢复、重派、创建新尝试或完成节点，终态仍沿原运行时路径处理。可重读当前尝试 approvals 确认决定，不能仅因 pendingApprovalIds 中 ID 消失就推断批准。错误或未知结果不表示已批准，也不表示整个 Run 完成。"#,
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
        "description": r#"报告当前节点进度、请求输入或请求审批，不提交节点终态；节点完成沿运行时 terminal hook 结算。
- runId/nodeExecutionId 取本次系统注入的 <team_run_context>，或当前 Run 的 team_graph_context 脱敏结果中对应 nodes 条目的真实执行 ID；不能用 nodeId/runId 代替执行 ID，也不能沿用旧尝试的 ID。roleId 如需提供，必须取当前节点的真实角色绑定，不猜角色名。
- progress 记录进度；request_input 使节点等待；request_approval 创建 WorkNode 审批并使节点等待，必须提供 roleId 及实际请求的 approvalAction。这不授予执行许可；已有明确人工决定后可用 team_approval_resolve 记账，再从 view=current_node 返回的 approvals 查询同一尝试的决定。记账不会自动恢复、重派或完成节点。
- 每次新事件生成 commandId/idempotencyKey；原请求重试保留这两项及全部参数，不换键重复请求。结果未知先重读当前节点状态及 pendingApprovalIds，无法确认则报告未知。
- 分别检查 outcome=progressed/waiting_for_input/approval_requested，再按需重读脱敏图核验；这些返回均不代表节点完成或审批通过。返回错误时按错误修正，不伪造成功。"#,
        "inputSchema": { "type": "object", "allOf": [schema(json!({
            "runId": identifier(), "commandId": identifier(), "idempotencyKey": identifier(),
            "nodeExecutionId": identifier(),
            "roleId": { "type": ["string", "null"], "minLength": 1 },
            "event": { "enum": ["progress", "request_input", "request_approval"] },
            "approvalAction": { "enum": ["continue_node", "execute_tool", "publish_result", "external_action"] }
        }), &["runId", "commandId", "idempotencyKey", "nodeExecutionId", "event"]),
            {
                "if": { "properties": { "event": { "const": "request_approval" } }, "required": ["event"] },
                "then": { "required": ["roleId", "approvalAction"], "properties": { "roleId": identifier() } }
            }
        ] }
    })
}

fn decision_submit_tool() -> Value {
    json!({
        "name": "team_run_decision_submit",
        "description": r#"记录 TeamRun 的 retry/proceed_degraded/abort 决策，不等于已重试、降级继续、中止或恢复执行，也不能代替人工授权或审批回执。
- runId 取当前 Run；stageId 仅使用已提供的真实阶段标识，省略或 null 表示 run 级决定。本工具和 team_graph_context 都不提供阶段列表，不把 nodeId/nodeExecutionId 猜成 stageId。decision 按已有明确决定填写；note 不需要时省略或 null。
- 新决定使用新的 idempotencyKey；原请求重试保持全部参数和原键，不换键绕过冲突。服务端记录时间参与决策重放比较，跨次重试不保证 replayed；结果未知时先从已有决策回执或运行状态确认，无法确认则报告未知，不盲目重提。
- 核验 outcome=recorded/replayed、对应 recorded/replayed 标志及 sequence；这些仅证明决策记账。脱敏图只可核对实际运行状态，不能查询该决策回执或证明调度已执行。"#,
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
        "description": r#"为当前 TeamRun 节点执行登记已有产物的不透明证据引用，不上传、创建、查找产物，不验证产物实体存在，也不提交节点完成。
- runId/nodeExecutionId 取本次 <team_run_context> 或当前 Run 脱敏上下文中对应节点的真实执行 ID，不能用 nodeId 替代或借用旧尝试。referenceKind 固定 artifact；reference 取实际产物流程已提供的标识，不猜 ID，不传文件路径、URL 或正文。这些工具不提供产物列表或引用查询；没有真实引用就不要调用。
- evidenceId 是本条新证据的唯一标识，由调用方生成；同一登记重试保持 evidenceId 和全部字段不变。相同 ID 的不同内容会冲突，不换 ID 掩盖冲突或重复登记。label 可省略或 null；提供时也须是不透明标识，不是自由文本说明。
- 检查 outcome=recorded/replayed，确认登记成功；错误或未知结果不能声称已保存。此返回只证明引用已记录，不能证明产物正确、节点完成或审批通过。"#,
        "inputSchema": schema(json!({
            "evidenceId": identifier(), "runId": identifier(), "nodeExecutionId": identifier(),
            "referenceKind": { "const": "artifact" }, "reference": identifier(),
            "label": { "type": ["string", "null"], "minLength": 1 }
        }), &["evidenceId", "runId", "nodeExecutionId", "referenceKind", "reference"])
    })
}
