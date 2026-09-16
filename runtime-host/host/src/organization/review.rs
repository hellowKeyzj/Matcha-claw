//! Organization/TeamRun Review-node seam.
//!
//! This module prepares the existing Organization delivery fact and translates a reviewer
//! terminal summary into the existing authorized graph-resolution input. It does not call a
//! runtime, parse provider output, or retain review state.

use organization::run::review::{ReviewVerdict, ReviewerRequest};
use organization::{
    AgentNodeEventResolution, AgentNodeEventResolutionError, AuthorizedGraphResolutionReceipt,
    DeliveryId, DeliveryRequest, ExecutionFence, GraphRunId, GraphState, NodeId, NodeKind,
    RoleSessionReceipt, TeamId,
};

const DEFAULT_REVIEW_INSTRUCTION: &str =
    "Review the upstream TeamRun results and decide which ReviewNode output port should be used.";

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReviewDispatchPreparation {
    delivery: DeliveryRequest,
    review: ReviewerRequest,
}

impl ReviewDispatchPreparation {
    pub(crate) fn delivery_request(&self) -> &DeliveryRequest {
        &self.delivery
    }

    /// The typed review request is an in-memory projection for the caller. The Organization
    /// delivery ledger remains the sole durable dispatch state.
    pub(crate) fn review_request(&self) -> &ReviewerRequest {
        &self.review
    }

    pub(crate) fn delivery_id(&self) -> &DeliveryId {
        &self.delivery.delivery_id
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReviewDispatchError {
    InvalidInput,
    RunMismatch,
    UnknownNode,
    UnexpectedNodeKind,
    StaleFence,
    SessionBindingMismatch,
    InvalidDelivery,
    InvalidReviewRequest,
}

/// Inputs owned by the Organization/TeamRun boundary for one exact Review-node attempt.
///
/// `graph` and `binding` are borrowed facts. No provider or LLM choice is made here; the caller
/// later registers `delivery_request()` and sends its private message through the existing target
/// delivery path.
#[derive(Clone, Debug)]
pub(crate) struct ReviewDispatchInput<'a> {
    pub(crate) team_id: &'a TeamId,
    pub(crate) run_id: &'a GraphRunId,
    pub(crate) graph: &'a GraphState,
    pub(crate) node_id: &'a NodeId,
    pub(crate) fence: &'a ExecutionFence,
    pub(crate) binding: &'a RoleSessionReceipt,
    pub(crate) workflow_plan_id: &'a str,
    pub(crate) title: &'a str,
    pub(crate) instruction: Option<&'a str>,
    pub(crate) requested_at: u64,
}

/// Facts supplied by a trusted native/event producer after terminal observation.
///
/// Matcha's current terminal wire exposes status only, so the status observer must not construct
/// this value or infer a verdict. The producer boundary is the only source for the summary and
/// authorized receipt consumed by the durable Review settlement path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReviewResolutionInput {
    pub(crate) delivery_id: DeliveryId,
    pub(crate) receipt: AuthorizedGraphResolutionReceipt,
    pub(crate) summary: String,
    pub(crate) resolved_at: u64,
}

/// Builds the exact private reviewer prompt and the durable delivery request for one fence.
///
/// The returned request is intentionally not registered here: registration and settlement remain
/// owned by the existing OrganizationStore/TeamRun delivery APIs, so Review preparation cannot
/// create a second dispatch ledger or fabricate a provider receipt.
pub(crate) fn prepare_review_dispatch(
    input: ReviewDispatchInput<'_>,
) -> Result<ReviewDispatchPreparation, ReviewDispatchError> {
    validate_dispatch_input(&input)?;

    let role_id = input.binding.role().as_str();
    let node_id = input.node_id.as_str();
    let delivery_key = format!(
        "team-graph-review-delivery:{}:{}",
        input.run_id.as_str(),
        input.fence.attempt_id().as_str()
    );
    let delivery_id =
        DeliveryId::new(delivery_key.clone()).map_err(|_| ReviewDispatchError::InvalidDelivery)?;
    let prompt = build_review_prompt(
        input.title,
        input.run_id,
        input.node_id,
        input.fence,
        role_id,
        input.binding.endpoint().as_str(),
        input.instruction,
    );

    let delivery = DeliveryRequest {
        delivery_id,
        team_id: input.team_id.as_str().to_owned(),
        run_id: input.run_id.as_str().to_owned(),
        node_id: node_id.to_owned(),
        node_execution_id: input.fence.node_execution_id().as_str().to_owned(),
        task_id: node_id.to_owned(),
        role_id: role_id.to_owned(),
        idempotency_key: delivery_key.clone(),
        message: prompt.clone(),
        requested_at: input.requested_at,
        max_attempts: input
            .graph
            .definition()
            .node(input.node_id)
            .expect("validated node")
            .max_attempts()
            .get(),
    };
    delivery
        .validate()
        .map_err(|_| ReviewDispatchError::InvalidDelivery)?;

    let review = ReviewerRequest {
        review_id: delivery_key.clone(),
        run_id: input.run_id.as_str().to_owned(),
        node_id: node_id.to_owned(),
        fence: input.fence.clone(),
        role_id: role_id.to_owned(),
        session_id: input.binding.external_session().as_str().to_owned(),
        prompt,
        idempotency_key: delivery_key,
        requested_at: input.requested_at,
    };
    review
        .validate()
        .map_err(|_| ReviewDispatchError::InvalidReviewRequest)?;

    Ok(ReviewDispatchPreparation { delivery, review })
}

/// Maps the historical summary-prefix verdict rule and binds it to the prepared delivery.
///
/// The receipt is supplied by the already-authorized native/event caller. This function never
/// invents one and leaves graph legality, delivery phase, and durable settlement to Organization.
pub(crate) fn map_review_verdict(
    preparation: &ReviewDispatchPreparation,
    receipt: AuthorizedGraphResolutionReceipt,
    summary: &str,
    resolved_at: u64,
) -> Result<(ReviewVerdict, AgentNodeEventResolution), AgentNodeEventResolutionError> {
    let verdict = review_verdict_from_summary(summary);
    let output_port = verdict.output_port();
    let resolution = match verdict {
        ReviewVerdict::Pass => AgentNodeEventResolution::complete_with_summary(
            receipt,
            preparation.delivery.delivery_id.clone(),
            preparation.review.run_id.clone(),
            preparation.review.fence.clone(),
            summary.to_owned(),
            preparation.review.review_id.clone(),
            preparation.review.idempotency_key.clone(),
            Some(output_port),
            resolved_at,
        )?,
        ReviewVerdict::Fail | ReviewVerdict::Rework => {
            AgentNodeEventResolution::reject_with_summary(
                receipt,
                preparation.delivery.delivery_id.clone(),
                preparation.review.run_id.clone(),
                preparation.review.fence.clone(),
                summary.to_owned(),
                preparation.review.review_id.clone(),
                preparation.review.idempotency_key.clone(),
                Some(output_port),
                resolved_at,
            )?
        }
    };
    Ok((verdict, resolution))
}

/// Consumes a trusted native terminal result into the existing durable agent-event seam.
///
/// This is deliberately only a consumer. The current native terminal wire produces status, not
/// the summary or authorization receipt required here; callers must obtain both from the trusted
/// native/event producer after `observe_matcha_terminal` has recorded terminal observation.
/// `OrganizationStore::apply_agent_node_event_resolution` remains the final observation gate.
pub(crate) fn resolve_review_after_terminal_observation(
    preparation: &ReviewDispatchPreparation,
    input: ReviewResolutionInput,
) -> Result<(ReviewVerdict, AgentNodeEventResolution), AgentNodeEventResolutionError> {
    if input.delivery_id != preparation.delivery.delivery_id {
        return Err(AgentNodeEventResolutionError::NodeMismatch);
    }
    map_review_verdict(
        preparation,
        input.receipt,
        &input.summary,
        input.resolved_at,
    )
}

pub(crate) fn review_verdict_from_summary(summary: &str) -> ReviewVerdict {
    let normalized = summary.trim().to_ascii_lowercase();
    if normalized.starts_with("fail:")
        || normalized.starts_with("failed:")
        || normalized.starts_with("reject:")
        || normalized.starts_with("rejected:")
    {
        ReviewVerdict::Fail
    } else {
        ReviewVerdict::Pass
    }
}

fn validate_dispatch_input(input: &ReviewDispatchInput<'_>) -> Result<(), ReviewDispatchError> {
    if input.team_id.as_str().trim().is_empty()
        || input.run_id.as_str().trim().is_empty()
        || input.node_id.as_str().trim().is_empty()
        || input.workflow_plan_id.trim().is_empty()
        || input.title.trim().is_empty()
        || input.requested_at == 0
    {
        return Err(ReviewDispatchError::InvalidInput);
    }
    if input.graph.definition().run_id() != input.run_id {
        return Err(ReviewDispatchError::RunMismatch);
    }
    let node = input
        .graph
        .definition()
        .node(input.node_id)
        .ok_or(ReviewDispatchError::UnknownNode)?;
    if node.kind() != NodeKind::Review {
        return Err(ReviewDispatchError::UnexpectedNodeKind);
    }
    let attempt = input
        .graph
        .current_attempt(input.node_id)
        .ok_or(ReviewDispatchError::UnknownNode)?;
    if attempt.fence() != input.fence
        || input.fence.node_execution_id().as_str() != attempt.fence().node_execution_id().as_str()
    {
        return Err(ReviewDispatchError::StaleFence);
    }
    if input.binding.team() != input.team_id
        || input.binding.team_run() != input.run_id
        || input.binding.role().as_str().trim().is_empty()
        || input.binding.external_session().as_str().trim().is_empty()
    {
        return Err(ReviewDispatchError::SessionBindingMismatch);
    }
    Ok(())
}

fn build_review_prompt(
    title: &str,
    run_id: &GraphRunId,
    node_id: &NodeId,
    fence: &ExecutionFence,
    role_id: &str,
    endpoint: &str,
    instruction: Option<&str>,
) -> String {
    [
        format!("## TeamRun ReviewNode: {title}"),
        String::new(),
        "### Node context".to_owned(),
        String::new(),
        "These fields identify the exact TeamRun review node execution. Use them when a TeamRun tool asks for runId, nodeExecutionId, or roleId; do not invent replacements.".to_owned(),
        String::new(),
        format!("- runId: {}", run_id.as_str()),
        format!("- nodeId: {}", node_id.as_str()),
        format!("- nodeExecutionId: {}", fence.node_execution_id().as_str()),
        format!("- roleId: {role_id}"),
        format!("- attempt: {}", fence.attempt_id().as_str()),
        String::new(),
        format!("- runtimeEndpoint: {endpoint}"),
        String::new(),
        "### Node event lifecycle".to_owned(),
        String::new(),
        "Use Team Node Event only for this nodeExecutionId. Do not invent or edit attempt ids.".to_owned(),
        String::new(),
        "Before calling Team Node Event:".to_owned(),
        "- Copy runId, nodeExecutionId, roleId, and the runtime endpoint fields from this prompt.".to_owned(),
        "- Include top-level summary, event, and a stable idempotencyKey.".to_owned(),
        String::new(),
        "After calling Team Node Event:".to_owned(),
        "- If complete or reject returns success: true, stop calling Team Node Event for this nodeExecutionId.".to_owned(),
        "- Do not submit another terminal event for the same nodeExecutionId with a new idempotencyKey.".to_owned(),
        "- If review requests rework, wait for a new TeamRun node prompt with a new nodeExecutionId; do not guess the next attempt id.".to_owned(),
        String::new(),
        "### Review work".to_owned(),
        String::new(),
        "This is the review instruction from the review node config. Use it to judge upstream results; do not treat it as tool documentation.".to_owned(),
        String::new(),
        instruction.unwrap_or(DEFAULT_REVIEW_INSTRUCTION).to_owned(),
    ]
    .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use organization::{
        AttemptId, GraphDefinition, NodeDefinition, NodeExecutionId, WorkAssignment,
    };
    use std::num::NonZeroU32;

    fn fixture() -> (
        GraphState,
        TeamId,
        GraphRunId,
        NodeId,
        ExecutionFence,
        RoleSessionReceipt,
    ) {
        let run_id = GraphRunId::new("run:review");
        let node_id = NodeId::new("review");
        let graph = GraphState::initialize(
            GraphDefinition::new(
                "graph:review",
                "workflow:review",
                run_id.clone(),
                "review",
                vec![NodeDefinition::control(
                    node_id.clone(),
                    NodeKind::Review,
                    "Release review",
                    NonZeroU32::new(2).unwrap(),
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        );
        let fence = graph.current_attempt(&node_id).unwrap().fence().clone();
        let team = TeamId::try_new("team:review").unwrap();
        let binding = RoleSessionReceipt::new(
            team.clone(),
            run_id.clone(),
            organization::RoleId::try_new("reviewer").unwrap(),
            organization::LocalSessionReference::try_new("local:review").unwrap(),
            organization::ExternalSessionReference::try_new("session:review").unwrap(),
            organization::ManagedAgentReference::try_new("agent:review").unwrap(),
            organization::RuntimeEndpointReference::try_new("endpoint:openclaw").unwrap(),
        );
        (graph, team, run_id, node_id, fence, binding)
    }

    fn preparation() -> ReviewDispatchPreparation {
        let (graph, team, run_id, node_id, fence, binding) = fixture();
        prepare_review_dispatch(ReviewDispatchInput {
            team_id: &team,
            run_id: &run_id,
            graph: &graph,
            node_id: &node_id,
            fence: &fence,
            binding: &binding,
            workflow_plan_id: "workflow:review",
            title: "Release review",
            instruction: Some("Check the release artifact."),
            requested_at: 10,
        })
        .unwrap()
    }

    #[test]
    fn preparation_preserves_exact_fence_role_session_and_prompt_effect() {
        let prepared = preparation();
        let delivery = prepared.delivery_request();
        let review = prepared.review_request();
        assert_eq!(delivery.run_id, "run:review");
        assert_eq!(
            delivery.node_execution_id,
            review.fence.node_execution_id().as_str()
        );
        assert_eq!(delivery.role_id, "reviewer");
        assert_eq!(review.session_id, "session:review");
        assert!(
            delivery
                .message
                .contains("## TeamRun ReviewNode: Release review")
        );
        assert!(delivery.message.contains("Check the release artifact."));
        assert_eq!(
            prepared.delivery_id().as_str(),
            "team-graph-review-delivery:run:review:review:attempt:1"
        );
    }

    #[test]
    fn preparation_rejects_wrong_kind_and_stale_fence() {
        let (mut graph, team, run_id, node_id, fence, binding) = fixture();
        let wrong = NodeId::new("missing");
        assert_eq!(
            prepare_review_dispatch(ReviewDispatchInput {
                team_id: &team,
                run_id: &run_id,
                graph: &graph,
                node_id: &wrong,
                fence: &fence,
                binding: &binding,
                workflow_plan_id: "workflow:review",
                title: "Review",
                instruction: None,
                requested_at: 1
            })
            .unwrap_err(),
            ReviewDispatchError::UnknownNode
        );
        let stale = ExecutionFence::new(
            AttemptId::for_node(&node_id, NonZeroU32::new(9).unwrap()),
            NodeExecutionId::for_attempt(&AttemptId::for_node(
                &node_id,
                NonZeroU32::new(9).unwrap(),
            )),
        );
        assert_eq!(
            prepare_review_dispatch(ReviewDispatchInput {
                team_id: &team,
                run_id: &run_id,
                graph: &graph,
                node_id: &node_id,
                fence: &stale,
                binding: &binding,
                workflow_plan_id: "workflow:review",
                title: "Review",
                instruction: None,
                requested_at: 1
            })
            .unwrap_err(),
            ReviewDispatchError::StaleFence
        );
        graph = GraphState::initialize(
            GraphDefinition::new(
                "graph:work",
                "workflow:work",
                run_id.clone(),
                "work",
                vec![NodeDefinition::work(
                    node_id.clone(),
                    "Work",
                    NonZeroU32::MIN,
                    WorkAssignment::new("task:review", "worker"),
                )],
                Vec::new(),
            )
            .unwrap(),
            1,
        );
        let work_fence = graph.current_attempt(&node_id).unwrap().fence().clone();
        assert_eq!(
            prepare_review_dispatch(ReviewDispatchInput {
                team_id: &team,
                run_id: &run_id,
                graph: &graph,
                node_id: &node_id,
                fence: &work_fence,
                binding: &binding,
                workflow_plan_id: "workflow:review",
                title: "Review",
                instruction: None,
                requested_at: 1
            })
            .unwrap_err(),
            ReviewDispatchError::UnexpectedNodeKind
        );
    }

    #[test]
    fn resolution_consumer_rejects_a_receipt_for_another_delivery() {
        let prepared = preparation();
        let input = ReviewResolutionInput {
            delivery_id: DeliveryId::new("team-graph-review-delivery:other").unwrap(),
            receipt: AuthorizedGraphResolutionReceipt::try_new("native:receipt").unwrap(),
            summary: "pass: good".to_owned(),
            resolved_at: 20,
        };
        assert_eq!(
            resolve_review_after_terminal_observation(&prepared, input),
            Err(AgentNodeEventResolutionError::NodeMismatch)
        );
    }

    #[test]
    fn summary_mapping_matches_historical_prefix_rule_and_binds_resolution() {
        for summary in [
            " fail: artifact missing ",
            "FAILED: artifact missing",
            " reject: no",
            "rejected: no",
        ] {
            assert_eq!(review_verdict_from_summary(summary), ReviewVerdict::Fail);
        }
        assert_eq!(
            review_verdict_from_summary("PASS: good"),
            ReviewVerdict::Pass
        );
        let prepared = preparation();
        let receipt = AuthorizedGraphResolutionReceipt::try_new("native:receipt").unwrap();
        let (verdict, resolution) =
            map_review_verdict(&prepared, receipt, "pass: good", 20).unwrap();
        assert_eq!(verdict, ReviewVerdict::Pass);
        assert_eq!(resolution.delivery_id(), prepared.delivery_id());
        assert_eq!(resolution.graph_run_id().as_str(), "run:review");
        assert_eq!(resolution.fence(), &prepared.review_request().fence);
        assert_eq!(resolution.output_port(), Some("passed"));
    }
}
