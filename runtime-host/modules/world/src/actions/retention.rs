use world_protocol::{
    actions::{ActionProposal, ActionStatus, EffectIntent, SourceReceipt, VerificationReceipt},
    authorization::ActualImpact,
    ids::*,
    operation::{OperationFailure, OperationResult},
    query::ReadReceipt,
};

use super::{Context, Error, Execution, decode};
use crate::store::{RetentionRoots, WorldTransaction};

/// Action history is retained even after a logical world deletion.
pub(crate) async fn world_deletion_roots(
    tx: &WorldTransaction<'_>,
) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    let params: &[&(dyn tokio_postgres::types::ToSql + Sync)] = &[
        &tx.world().tenant_id.as_str(),
        &tx.world().world_id.as_str(),
    ];
    for row in tx.query("SELECT body,execution FROM world_action_proposal WHERE tenant_id=$1 AND world_id=$2 ORDER BY proposal_id", params).await? {
        retain_proposal(&mut roots, decode(row.get("body"))?);
        retain_context(&mut roots, decode(row.get("execution"))?);
    }
    for row in tx.query("SELECT record,execution FROM world_effect_intent WHERE tenant_id=$1 AND world_id=$2 ORDER BY intent_id", params).await? {
        let intent: EffectIntent = decode(row.get("record"))?;
        let execution: Execution = decode(row.get("execution"))?;
        if intent.action.world != *tx.world() || intent.source_operation.binding.world != *tx.world() { return Err(super::contract::input("retention.intent")); }
        roots.definitions.extend([intent.action, intent.source_operation.binding]);
        roots.resources.extend(intent.expected_versions.into_iter().map(|position| ResourceRef::Source { id: position.source_id }));
        for argument in intent.argument_values { crate::definitions::value_resources(&argument.value, &mut roots.resources); }
        retain_context(&mut roots, execution.context);
        merge(&mut roots, crate::query::retained_action_roots(&execution.evaluation)?);
        if let Some(source) = execution.source { merge(&mut roots, crate::sources::connectors::effects::retained_effect_roots(&source).map_err(super::source_error)?); }
    }
    for row in tx.query("SELECT body FROM world_source_receipt WHERE tenant_id=$1 AND world_id=$2 ORDER BY receipt_id", params).await? {
        retain_source(&mut roots, decode(row.get("body"))?);
    }
    for row in tx.query("SELECT body FROM world_verification_receipt WHERE tenant_id=$1 AND world_id=$2 ORDER BY verification_id", params).await? {
        retain_verification(&mut roots, decode(row.get("body"))?);
    }
    roots.scopes.sort();
    roots.scopes.dedup();
    roots.resources.sort();
    roots.resources.dedup();
    roots.definitions.sort();
    roots.definitions.dedup();
    roots.evidence.sort();
    roots.evidence.dedup();
    roots.releases.sort();
    roots.releases.dedup();
    Ok(roots)
}

pub(crate) fn operation_retention_roots(
    world: &WorldRef,
    result: &OperationResult,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    match result {
        OperationResult::Proposal(proposal) => retain_proposal(roots, proposal.clone()),
        OperationResult::Approval(approval) => roots.definitions.push(approval.contract.clone()),
        OperationResult::Action(status) => {
            roots.resources.push(ResourceRef::Operation {
                id: status.operation_id.clone(),
            });
            for receipt in &status.source_receipts {
                retain_source(roots, receipt.clone());
            }
            for receipt in &status.verifications {
                retain_verification(roots, receipt.clone());
            }
            if let Some(failure) = &status.failure {
                crate::owner::operation_failure_roots(
                    world,
                    &OperationFailure::Action(failure.details.clone()),
                    roots,
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn step_retention_roots(
    step: &crate::owner::StepRecord,
    roots: &mut RetentionRoots,
) -> Result<(), Error> {
    let Some(result) = &step.result else {
        return Ok(());
    };
    match step.kind.as_str() {
        "action.propose" | "action.compensate" => retain_proposal(roots, decode(result.clone())?),
        "action.approve" => {
            let binding: world_protocol::authorization::ApprovalBinding = decode(result.clone())?;
            roots.definitions.push(binding.contract);
        }
        "action.reconcile" => {
            let status: ActionStatus = decode(result.clone())?;
            roots.resources.push(ResourceRef::Operation {
                id: status.operation_id,
            });
            for receipt in status.source_receipts {
                retain_source(roots, receipt);
            }
            for receipt in status.verifications {
                retain_verification(roots, receipt);
            }
        }
        "action.effect" => {
            // Replay finishes with the existing intent id; verification writes the typed receipt.
            #[derive(serde::Deserialize)]
            #[serde(untagged)]
            enum Result {
                Intent(EffectIntentId),
                Verification(VerificationReceipt),
            }
            match decode(result.clone())? {
                Result::Intent(id) => {
                    let _ = id;
                }
                Result::Verification(receipt) => retain_verification(roots, receipt),
            }
        }
        _ => {}
    }
    Ok(())
}

fn retain_proposal(roots: &mut RetentionRoots, proposal: ActionProposal) {
    roots.definitions.push(proposal.request.action);
    roots.dependencies.extend(proposal.read_dependencies);
    roots.resources.extend(
        proposal
            .request
            .branch_id
            .into_iter()
            .map(|id| ResourceRef::Branch { id }),
    );
    roots.resources.extend(
        proposal
            .request
            .targets
            .into_iter()
            .map(|subject| match subject {
                world_protocol::identity::SubjectRef::Object { id } => ResourceRef::Object { id },
                world_protocol::identity::SubjectRef::Relation { id } => {
                    ResourceRef::Relation { id }
                }
            }),
    );
    for argument in proposal.request.arguments {
        crate::definitions::value_resources(&argument.value, &mut roots.resources);
    }
    impact(roots, proposal.impact);
}
pub(crate) fn retain_source(roots: &mut RetentionRoots, receipt: SourceReceipt) {
    roots.resources.push(ResourceRef::Source {
        id: receipt.source_id,
    });
    roots.evidence.extend(receipt.evidence);
    if let Some(value) = receipt.result {
        crate::definitions::value_resources(&value, &mut roots.resources);
    }
}
fn retain_verification(roots: &mut RetentionRoots, receipt: VerificationReceipt) {
    roots.evidence.extend(receipt.evidence);
    retain_read(roots, receipt.read_receipt);
}
fn retain_read(roots: &mut RetentionRoots, receipt: ReadReceipt) {
    roots.releases.push(receipt.release_id);
    roots.resources.extend(
        receipt
            .branch_id
            .into_iter()
            .map(|id| ResourceRef::Branch { id }),
    );
    roots.dependencies.extend(receipt.actual_dependencies);
    roots.sources.extend(receipt.basis);
    roots.resources.extend(
        receipt
            .dirty
            .into_iter()
            .map(|id| ResourceRef::Watch { id }),
    );
    roots.resources.extend(
        receipt
            .coverage
            .missing_fields
            .into_iter()
            .map(|id| ResourceRef::Definition { id }),
    );
    roots.resources.extend(
        receipt
            .coverage
            .missing_sources
            .into_iter()
            .chain(receipt.coverage.gap_sources)
            .chain(
                receipt
                    .freshness
                    .into_iter()
                    .map(|freshness| freshness.source_id),
            )
            .map(|id| ResourceRef::Source { id }),
    );
}
fn retain_context(roots: &mut RetentionRoots, context: Context) {
    roots.scopes.push(context.scope);
    roots.releases.push(context.release_id);
    roots.branches.extend(context.branch);
}
fn impact(roots: &mut RetentionRoots, impact: ActualImpact) {
    for scope in impact.access {
        roots.scopes.push(scope.scope);
        roots.resources.extend(scope.resources);
        roots.definitions.extend(scope.fields);
    }
    roots.resources.extend(
        impact
            .source_ids
            .into_iter()
            .map(|id| ResourceRef::Source { id }),
    );
    roots.resources.extend(
        impact
            .state
            .into_iter()
            .map(|reference| ResourceRef::State { id: reference.id }),
    );
}
pub(crate) fn merge(roots: &mut RetentionRoots, other: RetentionRoots) {
    roots.scopes.extend(other.scopes);
    roots.resources.extend(other.resources);
    roots.definitions.extend(other.definitions);
    roots.evidence.extend(other.evidence);
    roots.dependencies.extend(other.dependencies);
    roots.sources.extend(other.sources);
    roots.releases.extend(other.releases);
    roots.branches.extend(other.branches);
    roots.source_versions.extend(other.source_versions);
    roots.parse_artifacts.extend(other.parse_artifacts);
    roots.schemas.extend(other.schemas);
    roots.mappings.extend(other.mappings);
}
