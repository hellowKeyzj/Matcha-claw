use serde::{Deserialize, Serialize};
use crate::{
    AuthorizedGraphOutcome, ControlAuthority, ControlNodeResolution, GraphRunId, NodeId,
    ScriptReviewRule, TeamId, TriggerFireRequest, TriggerSource,
    run::control::ControlNodeResolutionInput,
    store::{StoreFault, schema::{RecordKind, StoredRecord}},
};
use super::{attempt::Fence, decode, record};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Trigger { node: String, source: Source }
#[derive(Serialize, Deserialize)]
enum Source { Cron, Webhook }

pub(crate) fn encode_trigger(team: &TeamId, request: &TriggerFireRequest) -> Result<StoredRecord, StoreFault> {
    record(team, &GraphRunId::new(&request.run_id), RecordKind::Trigger, &request.idempotency_key, &Trigger {
        node: request.start_node_id.clone(), source: match request.source { TriggerSource::Cron => Source::Cron, TriggerSource::Webhook => Source::Webhook },
    })
}

pub(crate) fn decode_trigger(row: &StoredRecord) -> Result<TriggerFireRequest, StoreFault> {
    let value: Trigger = decode(row, RecordKind::Trigger)?;
    if row.run_id.as_deref() != Some(row.key.scope.as_str()) { return Err(StoreFault::InvalidFacts); }
    let request = TriggerFireRequest { run_id: row.key.scope.clone(), start_node_id: value.node, source: match value.source { Source::Cron => TriggerSource::Cron, Source::Webhook => TriggerSource::Webhook }, idempotency_key: row.key.id.clone() };
    request.validate().map_err(|_| StoreFault::InvalidFacts)?;
    Ok(request)
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Resolution { authority: Authority, node: String, fence: Fence, outcome: Outcome, output: String, rule: Option<Rule>, at: u64 }
#[derive(Serialize, Deserialize)]
enum Authority { HumanDecision, ScriptReview, Join }
#[derive(Serialize, Deserialize)]
enum Outcome { Completed, Failed }
#[derive(Serialize, Deserialize)]
enum Rule { PassThrough, AssertAllUpstreamCompleted, AssertNoBlockingGate, AssertArtifactExists }

pub(crate) fn encode_control(team: &TeamId, resolution: &ControlNodeResolution) -> Result<StoredRecord, StoreFault> {
    let value = Resolution {
        authority: match resolution.authority() { ControlAuthority::HumanDecision => Authority::HumanDecision, ControlAuthority::ScriptReview => Authority::ScriptReview, ControlAuthority::Join => Authority::Join },
        node: resolution.node_id().as_str().to_owned(), fence: Fence::from_domain(resolution.fence()),
        outcome: match resolution.outcome() { AuthorizedGraphOutcome::Completed => Outcome::Completed, AuthorizedGraphOutcome::Failed => Outcome::Failed },
        output: resolution.output_port().to_owned(),
        rule: resolution.script_review_rule().map(|rule| match rule { ScriptReviewRule::PassThrough => Rule::PassThrough, ScriptReviewRule::AssertAllUpstreamCompleted => Rule::AssertAllUpstreamCompleted, ScriptReviewRule::AssertNoBlockingGate => Rule::AssertNoBlockingGate, ScriptReviewRule::AssertArtifactExists => Rule::AssertArtifactExists }),
        at: resolution.resolved_at(),
    };
    let mut row = record(team, resolution.graph_run_id(), RecordKind::ControlResolution, resolution.idempotency_key(), &value)?;
    row.key.scope.clear();
    Ok(row)
}

pub(crate) fn decode_control(row: &StoredRecord) -> Result<ControlNodeResolution, StoreFault> {
    let value: Resolution = decode(row, RecordKind::ControlResolution)?;
    if !row.key.scope.is_empty() { return Err(StoreFault::InvalidFacts); }
    let resolution = ControlNodeResolution::from_durable(ControlNodeResolutionInput {
        authority: match value.authority { Authority::HumanDecision => ControlAuthority::HumanDecision, Authority::ScriptReview => ControlAuthority::ScriptReview, Authority::Join => ControlAuthority::Join },
        graph_run_id: GraphRunId::new(row.run_id.clone().ok_or(StoreFault::InvalidFacts)?), node_id: NodeId::new(value.node), fence: value.fence.into_domain(),
        outcome: match value.outcome { Outcome::Completed => AuthorizedGraphOutcome::Completed, Outcome::Failed => AuthorizedGraphOutcome::Failed }, output_port: value.output,
        script_review_rule: value.rule.map(|rule| match rule { Rule::PassThrough => ScriptReviewRule::PassThrough, Rule::AssertAllUpstreamCompleted => ScriptReviewRule::AssertAllUpstreamCompleted, Rule::AssertNoBlockingGate => ScriptReviewRule::AssertNoBlockingGate, Rule::AssertArtifactExists => ScriptReviewRule::AssertArtifactExists }), resolved_at: value.at,
    }).map_err(|_| StoreFault::InvalidFacts)?;
    if resolution.idempotency_key() != row.key.id { return Err(StoreFault::InvalidFacts); }
    Ok(resolution)
}
