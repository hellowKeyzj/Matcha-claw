use platform::trace::{identifier_hash, runtime_trace};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{GraphState, NodeId, TeamNodeOutput, TeamNodeOutputError};

pub const MAX_REPAIR_ATTEMPTS: usize = 3;

#[derive(Clone, Debug, Eq, PartialEq)]
enum TeamMessageError {
    Output(TeamNodeOutputError),
    ConflictingOutputs,
    RepairRefused,
}

impl TeamMessageError {
    fn repair_error(&self) -> String {
        match self {
            Self::Output(TeamNodeOutputError::MissingEnvelope) => "missing <team_message>...</team_message> envelope".to_owned(),
            Self::Output(TeamNodeOutputError::InvalidEnvelope) => "exactly one <team_message> envelope must end the final reply".to_owned(),
            Self::Output(TeamNodeOutputError::InvalidJson) => "invalid JSON".to_owned(),
            Self::Output(TeamNodeOutputError::MissingField(field)) => format!("missing required field `{field}`"),
            Self::Output(TeamNodeOutputError::UnexpectedField(_)) => "only summary, decision and files fields are allowed".to_owned(),
            Self::Output(TeamNodeOutputError::InvalidField("files")) => "files must be an array of concrete relative file paths, each at most 4096 UTF-8 bytes; no URL, absolute path, traversal, wildcard or directory".to_owned(),
            Self::Output(TeamNodeOutputError::InvalidField(field)) => format!("invalid field `{field}`"),
            Self::Output(TeamNodeOutputError::InvalidSummary) => "summary must be non-empty and contain no control characters other than line breaks or tabs".to_owned(),
            Self::Output(TeamNodeOutputError::UnsafeDecision | TeamNodeOutputError::DecisionNotAllowed) => "decision must be one of the current node's allowed output ports".to_owned(),
            Self::ConflictingOutputs => "conflicting valid team_message outputs; provide one unambiguous result".to_owned(),
            Self::RepairRefused => "repair cannot truthfully declare a permitted result".to_owned(),
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum TeamMessageRepairBasis {
    MissingDeclaration,
    Declared { decision: String, files: Vec<String> },
    UnreadableDeclaration,
}

impl TeamMessageRepairBasis {
    pub(crate) fn from_assistant_texts(texts: &[String]) -> Self {
        let mut selected = Self::MissingDeclaration;
        for text in texts {
            if !text.contains("<team_message>") && !text.contains("</team_message>") {
                continue;
            }
            let Some((decision, files)) = TeamNodeOutput::declared_result(text) else {
                return Self::UnreadableDeclaration;
            };
            let next = Self::Declared { decision, files };
            if selected != Self::MissingDeclaration && selected != next {
                return Self::UnreadableDeclaration;
            }
            selected = next;
        }
        selected
    }

    pub(crate) fn validate_output(&self, output: &TeamNodeOutput) -> Result<(), TeamMessageFailure> {
        match self {
            Self::MissingDeclaration => Ok(()),
            Self::Declared { decision, .. } if decision != output.decision() => Err(TeamMessageFailure::InvalidOutput),
            Self::Declared { files, .. } if files != output.files() => Err(TeamMessageFailure::InvalidFiles),
            Self::Declared { .. } => Ok(()),
            Self::UnreadableDeclaration => Err(TeamMessageFailure::InvalidOutput),
        }
    }
}

pub fn plan_team_message_terminal(
    context: &TeamMessageTerminalContext,
    attempt: usize,
    assistant_texts: Vec<String>,
    graph: &GraphState,
    node_id: &NodeId,
    prompts: &crate::prompts::TeamPromptSettings,
) -> TeamMessageTerminalPlan {
    plan_team_message_terminal_with_repair_basis(context, attempt, assistant_texts, graph, node_id, None, prompts)
        .unwrap_or(TeamMessageTerminalPlan::Failed)
}

pub(crate) fn plan_team_message_terminal_with_repair_basis(
    context: &TeamMessageTerminalContext,
    attempt: usize,
    assistant_texts: Vec<String>,
    graph: &GraphState,
    node_id: &NodeId,
    repair_basis: Option<&TeamMessageRepairBasis>,
    prompts: &crate::prompts::TeamPromptSettings,
) -> Result<TeamMessageTerminalPlan, TeamMessageFailure> {
    let plan = match select_team_message(&assistant_texts, graph, node_id, attempt > 0) {
        Ok(output) => TeamMessageTerminalPlan::Settle { output },
        Err(TeamMessageError::RepairRefused) => return Err(TeamMessageFailure::InvalidOutput),
        Err(error) if attempt < MAX_REPAIR_ATTEMPTS => {
            let next_attempt = attempt + 1;
            let original_basis;
            let repair_basis = match repair_basis {
                Some(basis) => basis,
                None => {
                    original_basis = TeamMessageRepairBasis::from_assistant_texts(&assistant_texts);
                    &original_basis
                }
            };
            TeamMessageTerminalPlan::Repair(TeamMessageRepairDispatch {
                attempt: next_attempt,
                requested_run_id: team_message_repair_run_id(context.delivery_id(), next_attempt),
                endpoint_session_id: context.endpoint_session_id().clone(),
                prompt: build_team_message_repair_prompt(&assistant_texts.join("\n\n"), &error, graph, node_id, repair_basis, prompts),
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
    Ok(plan)
}

fn select_team_message(
    assistant_texts: &[String],
    graph: &GraphState,
    node_id: &NodeId,
    repairing: bool,
) -> Result<TeamNodeOutput, TeamMessageError> {
    let mut selected: Option<TeamNodeOutput> = None;
    let mut conflicting = false;
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
                        && existing.decision() == output.decision()
                        && existing.files() == output.files() => "equivalent_duplicate",
                    _ => "conflicting",
                },
            }));
        }
        match candidate {
            Err(TeamNodeOutputError::UnsafeDecision) if repairing
                && TeamNodeOutput::declared_result(text).is_some_and(|(decision, files)| decision.is_empty() && files.is_empty()) => {
                return Err(TeamMessageError::RepairRefused);
            }
            Ok(output) => match &selected {
                Some(existing) if existing.summary() != output.summary()
                    || existing.decision() != output.decision()
                    || existing.files() != output.files() => {
                    runtime_trace("runtime.team_run.terminal.selection", || json!({
                        "runHash": identifier_hash(graph.definition().run_id().as_str()),
                        "nodeHash": identifier_hash(node_id.as_str()),
                        "outcome": "conflicting", "index": index,
                        "processed": index + 1, "total": assistant_texts.len(),
                    }));
                    if !repairing {
                        return Err(TeamMessageError::ConflictingOutputs);
                    }
                    conflicting = true;
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
        "outcome": if conflicting { "conflicting" } else if selected.is_some() { "unique" } else { "no_valid_output" },
        "total": assistant_texts.len(), "truncated": assistant_texts.len() > 16,
    }));
    if conflicting { Err(TeamMessageError::ConflictingOutputs) } else { selected.ok_or(error) }
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
    repair_basis: &TeamMessageRepairBasis,
    prompts: &crate::prompts::TeamPromptSettings,
) -> String {
    let decisions = graph.definition().node(node_id).into_iter()
        .flat_map(|node| node.kind().source_ports())
        .map(|port| port.as_str())
        .collect::<Vec<_>>().join(" / ");
    compose_repair_prompt(original_output, &error.repair_error(), &decisions, repair_basis, prompts)
}

pub(crate) fn compose_repair_prompt(
    original_output: &str,
    error: &str,
    decisions: &str,
    repair_basis: &TeamMessageRepairBasis,
    prompts: &crate::prompts::TeamPromptSettings,
) -> String {
    let (repair_rules, correct_format) = match repair_basis {
        TeamMessageRepairBasis::MissingDeclaration => (
            prompts.text("repair.missing.body").to_owned(),
            message_structure(prompts.text("repair.missing.targetSummary"), prompts.text("repair.missing.targetDecision"), &[]),
        ),
        TeamMessageRepairBasis::Declared { decision, files } => (
            prompts.render("repair.declared.body", &[
                ("原流向", &json!(decision).to_string()),
                ("原文件列表", &json!(files).to_string()),
            ]),
            format!("<team_message>{}</team_message>", json!({"summary": prompts.text("repair.declared.targetSummary"), "decision": decision, "files": files})),
        ),
        TeamMessageRepairBasis::UnreadableDeclaration => (
            prompts.text("repair.unreadable.body").to_owned(),
            message_structure(prompts.text("repair.unreadable.targetSummary"), "", &[]),
        ),
    };
    let refusal = message_structure(prompts.text("repair.fallback.targetSummary"), "", &[]);
    let fallback = prompts.render("repair.fallback.body", &[("拒绝结算结构", &refusal)]);
    let common = prompts.render("repair.common.body", &[
        ("本轮边界", &repair_rules),
        ("原始输出", original_output),
        ("校验错误", error),
        ("目标结构", &correct_format),
        ("无法结算答复", &fallback),
        ("允许流向", decisions),
    ]);
    format!("<teamrun_message_repair>\n{common}\n</teamrun_message_repair>")
}

fn message_structure(summary: &str, decision: &str, files: &[String]) -> String {
    #[derive(serde::Serialize)]
    struct Fields<'a> {
        summary: &'a str,
        decision: &'a str,
        files: &'a [String],
    }
    let fields = serde_json::to_string(&Fields { summary, decision, files })
        .expect("team message example fields serialize");
    format!("<team_message>{fields}</team_message>")
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TeamMessageFailure {
    ResultReadFailed,
    RepairExhausted,
    RepairRejected,
    RepairFailed,
    InvalidOutput,
    InvalidFiles,
    FileUnavailable,
}

impl TeamMessageFailure {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::ResultReadFailed => "team_message_result_read_failed",
            Self::RepairExhausted => "team_message_repair_exhausted",
            Self::RepairRejected => "team_message_repair_rejected",
            Self::RepairFailed => "team_message_repair_failed",
            Self::InvalidOutput => "team_message_invalid_output",
            Self::InvalidFiles => "team_message_files_invalid",
            Self::FileUnavailable => "team_message_files_unavailable",
        }
    }

    pub(crate) const fn message(self) -> &'static str {
        match self {
            Self::ResultReadFailed => "节点最终回复读取失败，无法确认任务结果；请检查对应会话后重试。",
            Self::RepairExhausted => "节点最终回复仍不符合完成协议，三次补答已耗尽。",
            Self::RepairRejected => "节点最终回复不符合完成协议，补答发送被拒绝。",
            Self::RepairFailed => "节点最终回复不符合完成协议，补答未成功完成。",
            Self::InvalidOutput => "节点最终回复不符合完成协议，无法结算为成功。",
            Self::InvalidFiles => "交付文件路径无效或文件不存在，未登记产物；请检查本节点的交付文件。",
            Self::FileUnavailable => "暂时无法核验交付文件，未登记产物；请检查工作区是否可访问。",
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
        let failure = [TeamMessageFailure::ResultReadFailed, TeamMessageFailure::RepairExhausted, TeamMessageFailure::RepairRejected, TeamMessageFailure::RepairFailed, TeamMessageFailure::InvalidOutput, TeamMessageFailure::InvalidFiles, TeamMessageFailure::FileUnavailable]
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
                &context, attempt, vec![original_output.to_owned()], &graph, &node_id, &crate::prompts::TeamPromptSettings::default(),
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
                &context, 3, vec![original_output.to_owned()], &graph, &node_id, &crate::prompts::TeamPromptSettings::default(),
            ),
            TeamMessageTerminalPlan::Failed
        );
    }
}
