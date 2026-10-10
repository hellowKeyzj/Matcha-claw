use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{GraphState, NodeId, TeamNodeOutput, TeamNodeOutputError};

pub const MAX_REPAIR_ATTEMPTS: usize = 3;

#[derive(Clone, Debug, Eq, PartialEq)]
enum TeamMessageError {
    Output(TeamNodeOutputError),
    ConflictingOutputs,
}

impl TeamMessageError {
    fn repair_error(&self) -> String {
        match self {
            Self::Output(TeamNodeOutputError::MissingEnvelope) => "missing <team_message>...</team_message> envelope".to_owned(),
            Self::Output(TeamNodeOutputError::InvalidEnvelope) => "exactly one <team_message> envelope must end the final reply".to_owned(),
            Self::Output(TeamNodeOutputError::InvalidJson) => "invalid JSON".to_owned(),
            Self::Output(TeamNodeOutputError::MissingField(field)) => format!("missing required field `{field}`"),
            Self::Output(TeamNodeOutputError::UnexpectedField(_)) => "only summary and decision fields are allowed".to_owned(),
            Self::Output(TeamNodeOutputError::InvalidField(field)) => format!("invalid field `{field}`"),
            Self::Output(TeamNodeOutputError::InvalidSummary) => "summary must be non-empty, at most 512 UTF-8 bytes, without control characters".to_owned(),
            Self::Output(TeamNodeOutputError::UnsafeDecision | TeamNodeOutputError::DecisionNotAllowed) => "decision must be one of the current node's allowed output ports".to_owned(),
            Self::ConflictingOutputs => "conflicting valid team_message outputs; provide one unambiguous result".to_owned(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMessageTerminalContext {
    run_id: organization::GraphRunId,
    delivery_id: organization::DeliveryId,
    endpoint_session_id: organization::EndpointSessionId,
}

impl TeamMessageTerminalContext {
    pub(crate) fn new(
        run_id: organization::GraphRunId,
        delivery_id: organization::DeliveryId,
        endpoint_session_id: organization::EndpointSessionId,
    ) -> Self {
        Self {
            run_id,
            delivery_id,
            endpoint_session_id,
        }
    }

    pub fn run_id(&self) -> &organization::GraphRunId {
        &self.run_id
    }

    pub fn delivery_id(&self) -> &organization::DeliveryId {
        &self.delivery_id
    }

    pub fn endpoint_session_id(&self) -> &organization::EndpointSessionId {
        &self.endpoint_session_id
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TeamMessageRepairDispatch {
    attempt: usize,
    requested_run_id: String,
    endpoint_session_id: organization::EndpointSessionId,
    prompt: String,
}

impl TeamMessageRepairDispatch {
    pub fn attempt(&self) -> usize {
        self.attempt
    }

    pub fn requested_run_id(&self) -> &str {
        &self.requested_run_id
    }

    pub fn endpoint_session_id(&self) -> &organization::EndpointSessionId {
        &self.endpoint_session_id
    }

    pub fn prompt(&self) -> &str {
        &self.prompt
    }

}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMessageTerminalPlan {
    Settle { output: TeamNodeOutput },
    Repair(TeamMessageRepairDispatch),
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamMessageTerminalObservation {
    Ignored,
    Settled,
    Repair(TeamMessageRepairDispatch),
}

pub fn plan_team_message_terminal(
    context: &TeamMessageTerminalContext,
    attempt: usize,
    assistant_texts: Vec<String>,
    graph: &GraphState,
    node_id: &NodeId,
) -> TeamMessageTerminalPlan {
    let plan = match select_team_message(&assistant_texts, graph, node_id) {
        Ok(output) => TeamMessageTerminalPlan::Settle { output },
        Err(error) if attempt < MAX_REPAIR_ATTEMPTS => {
            let next_attempt = attempt + 1;
            TeamMessageTerminalPlan::Repair(TeamMessageRepairDispatch {
                attempt: next_attempt,
                requested_run_id: team_message_repair_run_id(context.delivery_id(), next_attempt),
                endpoint_session_id: context.endpoint_session_id().clone(),
                prompt: build_team_message_repair_prompt(&assistant_texts.join("\n\n"), &error, graph, node_id),
            })
        }
        Err(_) => TeamMessageTerminalPlan::Failed,
    };
    runtime_trace("runtime.team_run.terminal.plan", || json!({
        "runHash": identifier_hash(context.run_id().as_str()),
        "deliveryHash": identifier_hash(context.delivery_id().as_str()),
        "nodeHash": identifier_hash(node_id.as_str()),
        "attempt": attempt, "maxAttempts": MAX_REPAIR_ATTEMPTS,
        "remainingAttempts": MAX_REPAIR_ATTEMPTS.saturating_sub(attempt),
        "candidateTotal": assistant_texts.len(),
        "outcome": match &plan {
            TeamMessageTerminalPlan::Settle { .. } => "settle",
            TeamMessageTerminalPlan::Repair(_) => "repair",
            TeamMessageTerminalPlan::Failed => "failed",
        },
        "repair": match &plan {
            TeamMessageTerminalPlan::Repair(repair) => Some(json!({
                "nativeRunHash": identifier_hash(repair.requested_run_id()),
                "attempt": repair.attempt(),
            })),
            _ => None,
        },
    }));
    plan
}

fn select_team_message(
    assistant_texts: &[String],
    graph: &GraphState,
    node_id: &NodeId,
) -> Result<TeamNodeOutput, TeamMessageError> {
    let mut selected: Option<TeamNodeOutput> = None;
    let mut error = TeamMessageError::Output(TeamNodeOutputError::MissingEnvelope);
    for (index, text) in assistant_texts.iter().enumerate() {
        let candidate = TeamNodeOutput::parse(text.clone()).and_then(|output| {
            output.validate_decision_for(graph, node_id)?;
            Ok(output)
        });
        if index < 16 {
            runtime_trace("runtime.team_run.terminal.candidate", || json!({
                "runHash": identifier_hash(graph.definition().run_id().as_str()),
                "nodeHash": identifier_hash(node_id.as_str()),
                "index": index, "utf8Bytes": text.len(),
                "total": assistant_texts.len(), "truncated": assistant_texts.len() > 16,
                "error": candidate.as_ref().err().map(|error| match error {
                    TeamNodeOutputError::MissingEnvelope => "missing_envelope",
                    TeamNodeOutputError::InvalidEnvelope => "invalid_envelope",
                    TeamNodeOutputError::InvalidJson => "invalid_json",
                    TeamNodeOutputError::MissingField(_) => "missing_field",
                    TeamNodeOutputError::UnexpectedField(_) => "unexpected_field",
                    TeamNodeOutputError::InvalidField(_) => "invalid_field",
                    TeamNodeOutputError::InvalidSummary => "invalid_summary",
                    TeamNodeOutputError::UnsafeDecision => "unsafe_decision",
                    TeamNodeOutputError::DecisionNotAllowed => "decision_not_allowed",
                }),
                "decisionAllowed": match &candidate {
                    Ok(_) => Some(true),
                    Err(TeamNodeOutputError::UnsafeDecision | TeamNodeOutputError::DecisionNotAllowed) => Some(false),
                    Err(_) => None,
                },
                "decision": candidate.as_ref().ok().map(|output| crate::trace::port(output.decision())),
                "selection": match (&candidate, &selected) {
                    (Err(_), _) => "invalid",
                    (Ok(_), None) => "selected",
                    (Ok(output), Some(existing)) if existing.summary() == output.summary()
                        && existing.decision() == output.decision() => "equivalent_duplicate",
                    _ => "conflicting",
                },
            }));
        }
        match candidate {
            Ok(output) => match &selected {
                Some(existing) if existing.summary() != output.summary()
                    || existing.decision() != output.decision() => {
                    runtime_trace("runtime.team_run.terminal.selection", || json!({
                        "runHash": identifier_hash(graph.definition().run_id().as_str()),
                        "nodeHash": identifier_hash(node_id.as_str()),
                        "outcome": "conflicting", "index": index,
                        "processed": index + 1, "total": assistant_texts.len(),
                    }));
                    return Err(TeamMessageError::ConflictingOutputs);
                }
                Some(_) => {}
                None => selected = Some(output),
            },
            Err(next_error) => error = TeamMessageError::Output(next_error),
        }
    }
    runtime_trace("runtime.team_run.terminal.selection", || json!({
        "runHash": identifier_hash(graph.definition().run_id().as_str()),
        "nodeHash": identifier_hash(node_id.as_str()),
        "outcome": if selected.is_some() { "unique" } else { "no_valid_output" },
        "total": assistant_texts.len(), "truncated": assistant_texts.len() > 16,
    }));
    selected.ok_or(error)
}

fn team_message_repair_run_id(delivery_id: &organization::DeliveryId, attempt: usize) -> String {
    let mut digest = Sha256::new();
    digest.update(delivery_id.as_str().as_bytes());
    digest.update([0]);
    digest.update(attempt.to_le_bytes());
    format!("tmr-{:x}", digest.finalize())
}

fn build_team_message_repair_prompt(
    original_output: &str,
    error: &TeamMessageError,
    graph: &GraphState,
    node_id: &NodeId,
) -> String {
    let decisions = graph.definition().node(node_id).into_iter()
        .flat_map(|node| node.kind().source_ports())
        .map(|port| port.as_str())
        .collect::<Vec<_>>().join(" / ");
    let correct_format = r#"<team_message>{"summary":"中文交付摘要","decision":"completed"}</team_message>"#;
    let prompt = format!(
        "<teamrun_message_repair>\n\
你正在修复 TeamRun 节点最终回复中的 `<team_message>` 控制块。\n\n\
只做格式修复，不重新执行任务，不调用工具，不输出解释。\n\
最终回复必须只包含一个 `<team_message>...</team_message>`，其中内容必须是合法 JSON。\n\n\
原始输出：\n{original_output}\n\n\
校验错误：\n{}\n\n\
目标结构：\n{correct_format}\n\n\
修复规则：\n\
- 只输出一个完整控制块，不用 Markdown 代码围栏包裹；结束标签后不再输出内容，字段值中不写控制块标签\n\
- 块内直接写一个 JSON 对象，不写数组或把整个对象编码成字符串；只含 `summary`、`decision`，各出现一次，值均为非空字符串，不用 null、数字、布尔值或嵌套对象代替\n\
- JSON 结构使用英文双引号、冒号和逗号；不用单引号或中文标点代替，不写注释、省略号或尾逗号\n\
- `summary`：用中文概括原始输出里的完成内容、关键结论、产物/改动、风险、下游必要上下文；非空，不超过 512 UTF-8 字节，不含控制字符\n\
- 摘要引用优先用中文引号，如“不可核实”；字符串值内部的英文双引号写为 `\\\"`，反斜杠写为 `\\\\`，不要用 HTML 实体代替 JSON 转义\n\
- 摘要写成单段，用空格或分号分隔，不含换行、制表符等控制字符，即使写成 JSON 转义也不允许；超长时精简内容，不截断 JSON\n\
- `decision`：保留原始输出表达的后续流向，只能选择当前节点允许的值：{decisions}；不得把失败或返工改为成功，也不翻译、不加空格或解释\n\
- 提交前检查对象与字符串闭合、转义和字段类型\n\
</teamrun_message_repair>",
        error.repair_error()
    );
    prompt
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TeamMessageFailure {
    RepairExhausted,
    RepairRejected,
    RepairFailed,
    InvalidOutput,
}

impl TeamMessageFailure {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::RepairExhausted => "team_message_repair_exhausted",
            Self::RepairRejected => "team_message_repair_rejected",
            Self::RepairFailed => "team_message_repair_failed",
            Self::InvalidOutput => "team_message_invalid_output",
        }
    }

    pub(crate) const fn message(self) -> &'static str {
        match self {
            Self::RepairExhausted => "节点最终回复仍不符合完成协议，三次补答已耗尽。",
            Self::RepairRejected => "节点最终回复不符合完成协议，补答发送被拒绝。",
            Self::RepairFailed => "节点最终回复不符合完成协议，补答未成功完成。",
            Self::InvalidOutput => "节点最终回复不符合完成协议，无法结算为成功。",
        }
    }

    pub(crate) fn receipt(self, delivery_id: &crate::DeliveryId) -> crate::AuthorizedGraphResolutionReceipt {
        crate::AuthorizedGraphResolutionReceipt::try_new(format!("{}:{}", self.code(), delivery_id.as_str()))
            .expect("fixed terminal failure receipt is non-empty")
    }

    pub(crate) fn evidence(
        self,
        observation: &crate::run::delivery::TerminalObservation,
        recorded_at: u64,
    ) -> Result<crate::EvidenceRecord, crate::StoreFault> {
        let evidence_id = Self::evidence_id(observation.delivery_id());
        crate::EvidenceRecord::new(
            evidence_id,
            observation.graph_run_id(),
            observation.fence().node_execution_id().as_str(),
            crate::EvidenceReference::opaque(crate::EvidenceReferenceKind::InlineText, self.code(), Some(self.message().to_owned()))
                .map_err(|_| crate::StoreFault::InvalidFacts)?,
            recorded_at,
        ).map_err(|_| crate::StoreFault::InvalidFacts)
    }

    fn evidence_id(delivery_id: &crate::DeliveryId) -> crate::EvidenceId {
        crate::EvidenceId::new(format!("team-message-failure:{:x}", Sha256::digest(delivery_id.as_str().as_bytes())))
            .expect("fixed prefix and digest fit evidence identity")
    }
}

pub(crate) fn terminal_failure(
    facts: &crate::OrganizationFacts,
    run_id: &crate::GraphRunId,
) -> Option<(crate::NodeId, &'static str, &'static str)> {
    let run = facts.run(run_id)?;
    facts.deliveries().deliveries().find_map(|delivery| {
        let crate::DeliveryPhase::TerminalObserved { observation } = delivery.phase() else { return None; };
        if observation.graph_run_id() != run_id.as_str() || observation.output().is_some() {
            return None;
        }
        let node_id = crate::NodeId::new(observation.node_id());
        let attempt = run.graph().current_attempt(&node_id)?;
        if attempt.fence() != observation.fence() || attempt.status() != crate::AttemptStatus::Failed {
            return None;
        }
        let crate::run::delivery::TerminalObservationResolution::GraphResolved(resolution) = observation.resolution() else { return None; };
        if resolution.outcome() != crate::AuthorizedGraphOutcome::Failed || resolution.output_port() != "failed" {
            return None;
        }
        let failure = [TeamMessageFailure::RepairExhausted, TeamMessageFailure::RepairRejected, TeamMessageFailure::RepairFailed, TeamMessageFailure::InvalidOutput]
            .into_iter().find(|failure| &failure.receipt(&delivery.facts().delivery_id) == resolution.receipt())?;
        let evidence_id = TeamMessageFailure::evidence_id(observation.delivery_id());
        facts.evidence_records().find(|record| record.evidence_id() == &evidence_id
            && record.matches_execution(run_id.as_str(), observation.fence())
            && record.reference().kind() == crate::EvidenceReferenceKind::InlineText
            && record.reference().reference() == failure.code())?;
        Some((node_id, failure.code(), failure.message()))
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn multiple_envelopes_are_rejected() {
        let text = "noise <team_message>{\"summary\":\"旧摘要\",\"decision\":\"completed\"}</team_message> tail <team_message>{\"summary\":\"新摘要\",\"decision\":\"completed\"}</team_message>";

        assert_eq!(TeamNodeOutput::parse(text), Err(TeamNodeOutputError::InvalidEnvelope));
    }

    #[test]
    fn json_syntax_error_is_reported() {
        let error =
            TeamNodeOutput::parse("<team_message>{\"summary\":\"摘要\",\"decision\":</team_message>")
                .unwrap_err();

        assert_eq!(error, TeamNodeOutputError::InvalidJson);
    }

    #[test]
    fn schema_validation_reports_first_error() {
        let value = json!({
            "summary": "bad\nsummary",
            "decision": ""
        });
        let error = TeamNodeOutput::parse(format!("<team_message>{value}</team_message>"))
            .unwrap_err();

        assert_eq!(error, TeamNodeOutputError::InvalidSummary);
    }

    #[test]
    fn dispatch_is_rejected() {
        let error = TeamNodeOutput::parse(
            "<team_message>{\"summary\":\"已完成交付\",\"decision\":\"completed\",\"dispatch\":[{\"role_id\":\"reviewer\",\"task\":\"复核结果\"}]}</team_message>",
        )
        .unwrap_err();

        assert_eq!(error, TeamNodeOutputError::UnexpectedField("dispatch".to_owned()));
    }

    #[test]
    fn bare_json_requires_envelope_instead_of_normalization() {
        let error = TeamNodeOutput::parse(
            "before {\"summary\":\"已完成交付\",\"decision\":\"completed\"} after",
        )
        .unwrap_err();

        assert_eq!(error, TeamNodeOutputError::MissingEnvelope);

        let error = TeamNodeOutput::parse(
            "before {\"summary\":\"已完成交付\",\"output_port\":\"done\",\"payload\":{}} after",
        )
        .unwrap_err();

        assert_eq!(error, TeamNodeOutputError::MissingEnvelope);
    }

    #[test]
    fn schema_rejects_unexpected_top_level_fields() {
        let value = json!({
            "summary": "已完成",
            "decision": "completed",
            "extra": true
        });
        let error = TeamNodeOutput::parse(format!("<team_message>{value}</team_message>"))
            .unwrap_err();

        assert_eq!(error, TeamNodeOutputError::UnexpectedField("extra".to_owned()));
    }

    #[test]
    fn repair_stops_after_three_failed_attempts() {
        let graph = crate::owner::actor::tests::native_cycle_graph(2);
        let node_id = NodeId::new("work");
        let context = TeamMessageTerminalContext::new(
            crate::GraphRunId::new("run:one"),
            crate::DeliveryId::new("delivery:one").unwrap(),
            crate::EndpointSessionId::try_new("native-session:one").unwrap(),
        );
        let mut original_output = "broken";
        assert_eq!(MAX_REPAIR_ATTEMPTS, 3);
        for attempt in 0..3 {
            let TeamMessageTerminalPlan::Repair(repair) = plan_team_message_terminal(
                &context, attempt, vec![original_output.to_owned()], &graph, &node_id,
            ) else {
                panic!("invalid output must request repair within the three-attempt budget");
            };
            assert_eq!(repair.attempt(), attempt + 1);
            assert!(repair.prompt().contains("不调用工具"));
            assert!(repair.prompt().contains("不重新执行任务"));
            assert!(repair.prompt().contains(
                "{\"summary\":\"中文交付摘要\",\"decision\":\"completed\"}"
            ));
            assert!(repair.prompt().contains(&format!("原始输出：\n{original_output}\n\n校验错误：")));
            original_output = "still broken";
        }
        assert_eq!(
            plan_team_message_terminal(
                &context, 3, vec![original_output.to_owned()], &graph, &node_id,
            ),
            TeamMessageTerminalPlan::Failed
        );
    }
}
