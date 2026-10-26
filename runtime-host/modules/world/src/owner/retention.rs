use std::collections::BTreeSet;

mod archive;
pub(crate) use archive::archive_retention_roots;

use serde::de::DeserializeOwned;
use world_protocol::{
    api::WorldCommand, authorization::ActualImpact, failure::FailureStage, ids::*,
    operation::OperationResult, provenance::ReadDependency,
};
use crate::store::{RetentionRoots, WorldSnapshot, WorldTransaction};
use super::{Error, OperationRecord, RunRecord, StepRecord, ledger, operation_failure_roots, workflows};

/// Owner history survives world deletion. Decode only the schemas written by this owner.
pub(crate) async fn world_deletion_roots(tx: &WorldTransaction<'_>) -> Result<RetentionRoots, Error> {
    let mut roots = RetentionRoots::default();
    let mut after = String::new();
    loop {
        let rows = tx.query("SELECT operation_id,revision,body FROM world_operation WHERE tenant_id=$1 AND world_id=$2 AND operation_id>$3 ORDER BY operation_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("operation_id");
            let record: OperationRecord = decode(row.get("body"))?;
            if record.input.world() != tx.world() || record.receipt.accepted.world != *tx.world()
                || record.receipt.accepted.operation_id.as_str() != after
                || number(record.receipt.accepted.revision)? != row.get::<_, i64>("revision") { return Err(invalid()); }
            if let ledger::OperationInput::Command(input) = &record.input {
                command_roots(tx, &input.command, record.receipt.result.as_ref(), &mut roots).await?;
            }
            if let Some(parent) = &record.strategy_parent {
                let operation = ledger::read(tx, &parent.operation_id).await?;
                let run = super::run::read_run(tx, &parent.run_id).await?;
                let step = super::run::read_step(tx, &parent.run_id, &parent.step_id).await?.ok_or_else(invalid)?;
                if operation.receipt.progress.run_id.as_ref() != Some(&run.id)
                    || run.operation.operation_id != parent.operation_id || step.input_digest != parent.input_digest
                    || step.kind != "learning.strategy" || step.ordinal != 2
                    || !matches!(operation.input.command()?, WorldCommand::ResolveTask(_))
                    || !matches!(record.input.command()?, WorldCommand::ActionSubmit(_)) { return Err(invalid()); }
                roots.resources.push(ResourceRef::Operation { id: parent.operation_id.clone() });
            }
            impact_roots(&record.impact, &mut roots);
            if let Some(failure) = &record.receipt.failure { operation_failure_roots(tx.world(), &failure.details, &mut roots)?; }
            if let Some(receipt) = &record.receipt.commit { roots.resources.extend(receipt.revisions.iter().map(|revision| revision.resource.clone())); }
            for effect in &record.receipt.effects {
                roots.resources.push(ResourceRef::Source { id: effect.source_id.clone() });
                roots.evidence.extend(effect.evidence.iter().cloned());
                if let Some(value) = &effect.result { crate::definitions::value_resources(value, &mut roots.resources); }
            }
        }
        if done { break; }
    }
    let mut after = String::new();
    loop {
        let rows = tx.query("SELECT r.run_id,r.operation_id,r.revision,r.kind,r.basis,r.body,o.body AS operation_body FROM world_run r JOIN world_operation o USING(tenant_id,world_id,operation_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.run_id>$3 ORDER BY r.run_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = row.get("run_id");
            let run: RunRecord = decode(row.get("body"))?;
            if run.id.as_str() != after || run.operation.world != *tx.world()
                || run.operation.operation_id.as_str() != row.get::<_, String>("operation_id")
                || number(run.revision)? != row.get::<_, i64>("revision") { return Err(invalid()); }
            let operation: OperationRecord = decode(row.get("operation_body"))?;
            if operation.input.world() != tx.world() || operation.receipt.accepted.world != *tx.world()
                || operation.receipt.accepted.operation_id != run.operation.operation_id
                || operation.receipt.progress.run_id.as_ref() != Some(&run.id)
                || operation.input.operation_name() != row.get::<_, String>("kind") { return Err(invalid()); }
            match &operation.input {
                ledger::OperationInput::Command(_) => {
                    roots.releases.extend(run.release_id);
                    roots.resources.extend(run.branch_id.into_iter().map(|id| ResourceRef::Branch { id }));
                    let basis = workflows::facts::run_command_basis(row.get("basis"))?;
                    command_roots(tx, &basis, None, &mut roots).await?;
                }
                ledger::OperationInput::Maintenance(input) => {
                    let basis: ledger::MaintenanceBasis = decode(row.get("basis"))?;
                    if run.activation_lock_id.is_some() || run.release_id.is_some() || run.branch_id.is_some() || !run.packages.is_empty()
                        || crate::definitions::canonical_digest(&basis)? != crate::definitions::canonical_digest(&input.basis)? { return Err(invalid()); }
                }
            }
        }
        if done { break; }
    }
    let mut after = (String::new(), String::new());
    loop {
        let rows = tx.query("SELECT run_id,step_id,revision,body FROM world_step WHERE tenant_id=$1 AND world_id=$2 AND (run_id,step_id)>($3,$4) ORDER BY run_id,step_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after.0, &after.1]).await?;
        let done = rows.len() < 256;
        for row in rows {
            after = (row.get("run_id"), row.get("step_id"));
            let step: StepRecord = decode(row.get("body"))?;
            if step.run_id.as_str() != after.0 || step.id.as_str() != after.1
                || number(step.revision)? != row.get::<_, i64>("revision") { return Err(invalid()); }
            if let Some(failure) = &step.failure { operation_failure_roots(tx.world(), &failure.details, &mut roots)?; }
            match step.kind.as_str() {
                kind if kind.starts_with("materials.") => workflows::materials::step_retention_roots(tx, &step, &mut roots).await?,
                kind if kind.starts_with("action.") => workflows::actions::step_retention_roots(&step, &mut roots)?,
                "facts.observe" | "facts.evaluate_rule" | "facts.reconcile" => workflows::facts::step_retention_roots(&step, &mut roots)?,
                "sources.discover" | "sources.service" => workflows::sources::step_retention_roots(tx, &step, &mut roots).await?,
                "sources.identity" => super::execution::source_identity_retention_roots(&step, &mut roots)?,
                "release.compiler" => workflows::releases::step_retention_roots(tx, &step, &mut roots).await?,
                "world.evaluation.case" | "world.evaluation.oracle_custody" => workflows::evaluation::step_retention_roots(tx, &step, &mut roots).await?,
                "learning.resolve" | "world.evaluation.online_oracle" => crate::learning::investigation::step_retention_roots(tx, &step, &mut roots).await?,
                "learning.strategy" => crate::abstraction::strategy_step_retention_roots(tx, &step, &mut roots).await?,
                "learning.abstraction" => workflows::learning::abstraction::step_retention_roots(&step, &mut roots)?,
                "maintenance.retirement" | "maintenance.content_cleanup" | "maintenance.support" | "maintenance.support_watches" | "maintenance.package_cleanup" => super::runtime::step_retention_roots(tx, &step, &mut roots).await?,
                _ => return Err(invalid()),
            }
        }
        if done { break; }
    }
    roots.scopes.sort(); roots.scopes.dedup(); roots.resources.sort(); roots.resources.dedup();
    roots.definitions.sort(); roots.definitions.dedup(); roots.evidence.sort(); roots.evidence.dedup();
    roots.releases.sort(); roots.releases.dedup(); roots.parse_artifacts.sort(); roots.parse_artifacts.dedup();
    Ok(roots)
}

async fn command_roots(tx: &WorldTransaction<'_>, command: &WorldCommand, result: Option<&OperationResult>, roots: &mut RetentionRoots) -> Result<(), Error> {
    workflows::materials::operation_retention_roots(tx, command, result, roots).await?;
    workflows::sources::operation_retention_roots(tx, command, result, roots).await?;
    workflows::learning::operation_retention_roots(tx, command, result, roots).await?;
    workflows::evaluation::operation_retention_roots(tx, command, result, roots).await?;
    if let Some(result) = result { workflows::actions::operation_retention_roots(tx.world(), result, roots)?; }
    match command {
        WorldCommand::ImportMaterials(request) => { if let Some(compile) = &request.compile { crate::learning::compile_retention_roots(tx, compile, roots).await?; } },
        WorldCommand::ProposeMaterialDraft(request) => {
            // Retain every selected reference under the one batch lock; this is not a compilation input.
            let selection = world_protocol::compiler::CompileSelection {
                activation_lock_id: request.compile.activation_lock_id.clone(),
                external_contracts: request.compile.candidates.iter()
                    .flat_map(|candidate| candidate.external_contracts.iter().cloned()).collect(),
            };
            crate::learning::compile_retention_roots(tx, &selection, roots).await?;
        },
        WorldCommand::ConfigurePolicy(request) => {
            roots.scopes.push(request.scope.clone());
            for access in &request.rule.access { roots.scopes.push(access.scope.clone()); roots.resources.extend(access.resources.iter().cloned()); roots.definitions.extend(access.fields.iter().cloned()); }
        },
        WorldCommand::ConfigureRetention(request) => roots.scopes.push(request.scope.clone()),
        WorldCommand::Observe(request) => { for observation in &request.observations { crate::facts::assertions::observation_retention_roots(tx, observation, roots).await?; } },
        WorldCommand::EvaluateRule(request) => {
            roots.releases.push(request.release_id.clone()); roots.definitions.push(request.rule.clone()); roots.scopes.push(request.scope.clone());
            for argument in &request.arguments { crate::definitions::value_resources(&argument.value, &mut roots.resources); }
        },
        WorldCommand::Reconcile(request) => { roots.resources.extend(request.subjects.iter().map(super::retained_failure::subject)); roots.definitions.extend(request.bindings.iter().cloned()); },
        WorldCommand::Publish(request) => {
            roots.resources.extend([ResourceRef::ChangeSet { id: request.change_set_id.clone() }, ResourceRef::Evaluation { id: request.evaluation_id.clone() }]);
            release_head_roots(&request.head, roots);
        },
        WorldCommand::Rollback(request) => { roots.releases.push(request.release_id.clone()); release_head_roots(&request.head, roots); },
        WorldCommand::ActionPropose(request) => {
            roots.definitions.push(request.action.clone()); roots.resources.extend(request.targets.iter().map(super::retained_failure::subject));
            roots.resources.extend(request.branch_id.iter().cloned().map(|id| ResourceRef::Branch { id }));
            for argument in &request.arguments { crate::definitions::value_resources(&argument.value, &mut roots.resources); }
        },
        WorldCommand::ActionSubmit(request) => { if let Some(approval) = &request.approval { roots.definitions.push(approval.contract.clone()); } },
        WorldCommand::ActionReconcile(key) | WorldCommand::ActionCompensate(key) => roots.resources.push(ResourceRef::Operation { id: key.operation_id.clone() }),
        WorldCommand::GrantPackage(request) => {
            roots.resources.push(ResourceRef::Package { id: request.install_id.clone() });
            for grant in &request.grants {
                match grant {
                    world_protocol::package::RequestedAccess::WorldRead { fields } => roots.resources.extend(fields.iter().cloned().map(|id| ResourceRef::Definition { id })),
                    world_protocol::package::RequestedAccess::SourceRead { source_id } => roots.resources.push(ResourceRef::Source { id: source_id.clone() }),
                    _ => {},
                }
            }
        },
        WorldCommand::ConfigurePackage(request) => { roots.resources.push(ResourceRef::Package { id: request.install_id.clone() }); for field in &request.fields { crate::definitions::value_resources(&field.value, &mut roots.resources); } },
        WorldCommand::EnablePackage(request) | WorldCommand::DisablePackage(request) | WorldCommand::UninstallPackage(request) => roots.resources.push(ResourceRef::Package { id: request.install_id.clone() }),
        WorldCommand::UpgradePackage(request) => roots.resources.push(ResourceRef::Package { id: request.install_id.clone() }),
        WorldCommand::MigratePackage(request) => { roots.resources.push(ResourceRef::Package { id: request.install_id.clone() }); roots.resources.push(ResourceRef::State { id: request.migration.expected.root.id.clone() }); activation_roots(&request.activation, roots); },
        WorldCommand::Activate(request) => activation_roots(request, roots),
        WorldCommand::Backup(request) => roots.releases.push(request.expected_release.clone()),
        _ => {},
    }
    match result {
        Some(OperationResult::Facts { assertions }) => roots.dependencies.extend(assertions.iter().cloned().map(|reference| ReadDependency::Assertion { reference })),
        Some(OperationResult::RuleEvaluated { assertion, .. }) => roots.dependencies.extend(assertion.iter().cloned().map(|reference| ReadDependency::Assertion { reference })),
        Some(OperationResult::Commit(receipt)) => roots.resources.extend(receipt.revisions.iter().map(|revision| revision.resource.clone())),
        Some(OperationResult::Package { install_id, .. }) => roots.resources.push(ResourceRef::Package { id: install_id.clone() }),
        Some(OperationResult::Release { head }) => roots.releases.push(head.release_id.clone()),
        Some(OperationResult::Restore { release_id }) => roots.releases.push(release_id.clone()),
        _ => {},
    }
    Ok(())
}

fn impact_roots(impact: &ActualImpact, roots: &mut RetentionRoots) {
    for access in &impact.access { roots.scopes.push(access.scope.clone()); roots.resources.extend(access.resources.iter().cloned()); roots.definitions.extend(access.fields.iter().cloned()); }
    roots.resources.extend(impact.source_ids.iter().cloned().map(|id| ResourceRef::Source { id }));
    roots.resources.extend(impact.state.iter().map(|reference| ResourceRef::State { id: reference.id.clone() }));
}
fn activation_roots(request: &world_protocol::bindings::ActivationRequest, roots: &mut RetentionRoots) {
    roots.resources.extend(request.graph.nodes.iter().map(|node| ResourceRef::Package { id: node.implementation.install_id.clone() }));
    roots.resources.extend(request.graph.nodes.iter().filter_map(|node| node.state.as_ref()).map(|state| ResourceRef::State { id: state.root.id.clone() }));
}
fn release_head_roots(head: &world_protocol::releases::ReleaseHeadCas, roots: &mut RetentionRoots) {
    roots.releases.push(head.next.clone()); roots.releases.extend(head.expected.iter().map(|head| head.release_id.clone()));
}

pub(crate) async fn restore_required_activation_locks(tx: &WorldTransaction<'_>) -> Result<BTreeSet<ActivationLockId>, Error> {
    let mut locks = BTreeSet::new();
    let mut after = String::new();
    loop {
        let rows = tx.query("SELECT run_id,operation_id,body FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id>$3 ORDER BY run_id LIMIT 256",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &after]).await?;
        let done = rows.len() < 256;
        for row in rows { after = row.get("run_id"); required_lock(tx.world(), &after, row.get("operation_id"), decode(row.get("body"))?, &mut locks)?; }
        if done { break; }
    }
    Ok(locks)
}
pub(crate) async fn read_restore_required_activation_locks(snapshot: &WorldSnapshot<'_>) -> Result<BTreeSet<ActivationLockId>, Error> {
    let mut locks = BTreeSet::new();
    let mut after = String::new();
    loop {
        let rows = snapshot.query("SELECT run_id,operation_id,body FROM world_run WHERE tenant_id=$1 AND world_id=$2 AND run_id>$3 ORDER BY run_id LIMIT 256",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &after]).await?;
        let done = rows.len() < 256;
        for row in rows { after = row.get("run_id"); required_lock(snapshot.world(), &after, row.get("operation_id"), decode(row.get("body"))?, &mut locks)?; }
        if done { break; }
    }
    Ok(locks)
}
fn required_lock(world: &WorldRef, id: &str, operation: String, run: RunRecord, locks: &mut BTreeSet<ActivationLockId>) -> Result<(), Error> {
    if run.operation.world != *world || run.id.as_str() != id || run.operation.operation_id.as_str() != operation { return Err(invalid()); }
    if !ledger::terminal(run.phase) { locks.extend(run.activation_lock_id); }
    Ok(())
}
fn number(value: Revision) -> Result<i64, Error> { i64::try_from(value.0).map_err(|cause| invalid().caused(cause)) }
fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, Error> { serde_json::from_value(value).map_err(|cause| invalid().caused(cause)) }
fn invalid() -> Error { Error::internal(FailureStage::Recover) }
