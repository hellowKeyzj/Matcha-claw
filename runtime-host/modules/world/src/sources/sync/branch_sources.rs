use super::{BranchCapture, SyncError, number};
use crate::{
    authorization::{self, Admission},
    extensions::invocation::CallBudget,
    sources::mapping,
    store::{WorldSnapshot, WorldTransaction},
};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    definitions::DefinitionBody,
    expression::Effect,
    ids::*,
    releases::{BranchRef, WorldBranch},
    sources::SourceBasis,
};

enum Reader<'a, 'b> {
    Transaction(&'a WorldTransaction<'b>),
    Snapshot(&'a WorldSnapshot<'b>),
}
impl Reader<'_, '_> {
    fn world(&self) -> &WorldRef {
        match self {
            Self::Transaction(tx) => tx.world(),
            Self::Snapshot(snapshot) => snapshot.world(),
        }
    }
    async fn model(&self, branch: &BranchRef) -> Result<WorldBranch, SyncError> {
        match self {
            Self::Transaction(tx) => crate::releases::read_branch_revision(tx, branch).await,
            Self::Snapshot(snapshot) => {
                crate::releases::read_branch_revision_snapshot(snapshot, branch).await
            }
        }
        .map_err(mapping::MappingError::from)?
        .ok_or_else(SyncError::protocol)
    }
    async fn selected(
        &self,
        branch: &WorldBranch,
        basis: &SourceBasis,
    ) -> Result<Option<BranchCapture>, SyncError> {
        if self.world() != &branch.world || basis.binding.world != branch.world {
            return Err(SyncError::protocol());
        }
        let sql = "SELECT DISTINCT branch_revision FROM world_source_branch_capture WHERE tenant_id=$1 AND world_id=$2 AND branch_id=$3 AND branch_revision<=$4 AND source_id=$5 AND binding_id=$6 AND binding_revision=$7 ORDER BY branch_revision";
        let revision = number(branch.revision.0)?;
        let binding_revision = number(basis.binding.revision.0)?;
        let params: &[&(dyn tokio_postgres::types::ToSql + Sync)] = &[
            &branch.world.tenant_id.as_str(),
            &branch.world.world_id.as_str(),
            &branch.id.as_str(),
            &revision,
            &basis.source_id.as_str(),
            &basis.binding.id.as_str(),
            &binding_revision,
        ];
        let rows = match self {
            Self::Transaction(tx) => tx.query(sql, params).await?,
            Self::Snapshot(snapshot) => snapshot.query(sql, params).await?,
        };
        let mut matched = None;
        for row in rows {
            let original = BranchRef {
                world: branch.world.clone(),
                id: branch.id.clone(),
                revision: Revision(
                    u64::try_from(row.get::<_, i64>("branch_revision"))
                        .map_err(|_| SyncError::protocol())?,
                ),
            };
            if !same_model(&self.model(&original).await?, branch) {
                continue;
            }
            let capture = match self {
                Self::Transaction(tx) => {
                    super::read_branch_capture(tx, &original, &basis.binding).await?
                }
                Self::Snapshot(snapshot) => {
                    super::read_branch_capture_snapshot(snapshot, &original, &basis.binding).await?
                }
            }
            .ok_or_else(SyncError::protocol)?;
            if capture.dto.basis != *basis
                || !branch.basis.snapshots.contains(&capture.version.blob)
            {
                continue;
            }
            if matched.is_some() {
                return Err(SyncError::protocol());
            }
            matched = Some(capture);
        }
        Ok(matched)
    }
    async fn sources(
        &self,
        admission: &Admission,
        branch: &WorldBranch,
        budget: &CallBudget,
        cancel: &CancellationToken,
    ) -> Result<Vec<BranchCapture>, SyncError> {
        let mut captures = Vec::new();
        for basis in &branch.basis.sources {
            check(budget, cancel)?;
            if let Some(capture) = self.selected(branch, basis).await? {
                match self {
                    Self::Transaction(tx) => {
                        capture.recheck(tx, admission, &tx.now().await?).await?
                    }
                    Self::Snapshot(snapshot) => {
                        capture
                            .recheck_snapshot(snapshot, admission, &snapshot.now().await?)
                            .await?
                    }
                }
                budget
                    .charge(
                        world_protocol::budget::BudgetDimension::Rows,
                        capture.raw.page.rows.len() as u64,
                    )
                    .map_err(
                        |error| world_protocol::sources::MappingFailure::BudgetExceeded {
                            dimension: error.dimension,
                        },
                    )?;
                captures.push(capture);
            }
        }
        Ok(captures)
    }
    async fn ready(
        &self,
        admission: &Admission,
        branch: &BranchRef,
        affected: &[DefinitionRef],
        budget: &CallBudget,
        cancel: &CancellationToken,
    ) -> Result<CandidateSources, SyncError> {
        check(budget, cancel)?;
        let model = self.model(branch).await?;
        let base = match self {
            Self::Transaction(tx) => {
                crate::releases::read_release(tx, &model.basis.release_id).await
            }
            Self::Snapshot(snapshot) => {
                crate::releases::read_release_snapshot(snapshot, &model.basis.release_id).await
            }
        }
        .map_err(mapping::MappingError::from)?
        .ok_or_else(SyncError::protocol)?;
        for old in &base.definitions {
            let DefinitionBody::SourceBinding(binding) = &old.body else {
                continue;
            };
            if !model.compile.definitions.iter().any(|definition| {
                definition.reference.id == old.reference.id
                    && matches!(definition.body, DefinitionBody::SourceBinding(_))
            }) {
                return Err(retirement_required(binding));
            }
        }
        let captures = self.sources(admission, &model, budget, cancel).await?;
        let mut selected = Vec::new();
        for definition in &model.compile.definitions {
            let DefinitionBody::SourceBinding(binding) = &definition.body else {
                continue;
            };
            if !affected.contains(&definition.reference) {
                continue;
            }
            if !matches!(
                definition.lifecycle,
                world_protocol::definitions::DefinitionLifecycle::Available
            ) {
                return Err(retirement_required(binding));
            }
            let capture = captures
                .iter()
                .find(|capture| capture.dto.binding == definition.reference)
                .ok_or_else(SyncError::protocol)?;
            if captures
                .iter()
                .filter(|capture| capture.dto.binding == definition.reference)
                .count()
                != 1
                || capture.plan.binding_body != *binding
                || !capture.dto.complete
                || !capture.dto.consistent
                || !capture.dto.failures.is_empty()
                || capture.dto.basis.gap.is_some()
            {
                return Err(SyncError::protocol());
            }
            selected.push(capture.clone());
        }
        selected.sort_by(|a, b| a.dto.binding.cmp(&b.dto.binding));
        Ok(CandidateSources {
            branch: branch.clone(),
            affected: affected.to_vec(),
            captures: selected,
        })
    }
}

fn retirement_required(binding: &world_protocol::sources::SourceBinding) -> SyncError {
    super::source_failure(
        world_protocol::sources::SourceFailure::Release {
            failure: Box::new(world_protocol::releases::ReleaseFailure::BasisChanged {
                resources: vec![ResourceRef::Source {
                    id: binding.source_id.clone(),
                }],
            }),
        },
        world_protocol::failure::FailureStage::Validate,
    )
}

/// Structural material lineage is also used before admission; it never grants read authority.
pub(crate) async fn branch_snapshot_materials(
    tx: &WorldTransaction<'_>,
    branch: &WorldBranch,
    basis: &SourceBasis,
) -> Result<Vec<world_protocol::materials::SourceVersion>, SyncError> {
    match Reader::Transaction(tx).selected(branch, basis).await? {
        Some(capture) => Ok(vec![capture.version]),
        None => super::snapshot_materials(tx, basis).await,
    }
}

/// Captures remain bound to their original immutable model revision across status-only advances.
pub(crate) async fn read_branch_sources(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    branch: &WorldBranch,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<Vec<BranchCapture>, SyncError> {
    Reader::Transaction(tx)
        .sources(admission, branch, budget, cancel)
        .await
}
pub(crate) async fn read_branch_sources_snapshot(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    branch: &WorldBranch,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<Vec<BranchCapture>, SyncError> {
    Reader::Snapshot(snapshot)
        .sources(admission, branch, budget, cancel)
        .await
}

pub(crate) async fn selected_branch_capture(
    tx: &WorldTransaction<'_>,
    branch: &WorldBranch,
    binding: &DefinitionRef,
) -> Result<Option<BranchCapture>, SyncError> {
    selected_binding(&Reader::Transaction(tx), branch, binding).await
}
pub(crate) async fn selected_branch_capture_snapshot(
    snapshot: &WorldSnapshot<'_>,
    branch: &WorldBranch,
    binding: &DefinitionRef,
) -> Result<Option<BranchCapture>, SyncError> {
    selected_binding(&Reader::Snapshot(snapshot), branch, binding).await
}
async fn selected_binding(
    reader: &Reader<'_, '_>,
    branch: &WorldBranch,
    binding: &DefinitionRef,
) -> Result<Option<BranchCapture>, SyncError> {
    let mut selected = None;
    for basis in branch
        .basis
        .sources
        .iter()
        .filter(|basis| basis.binding == *binding)
    {
        if let Some(capture) = reader.selected(branch, basis).await? {
            if selected.is_some() {
                return Err(SyncError::protocol());
            }
            selected = Some(capture);
        }
    }
    Ok(selected)
}

pub(crate) async fn candidate_promotion_impact(
    tx: &WorldTransaction<'_>,
    branch: &WorldBranch,
    affected: &[DefinitionRef],
) -> Result<ActualImpact, SyncError> {
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision)
        .await
        .map_err(|error| {
            SyncError::caused(
                world_protocol::sources::SourceFailure::ProtocolViolation,
                world_protocol::failure::FailureStage::Validate,
                error,
            )
        })?;
    let mut access = vec![AccessScope {
        resources: vec![ResourceRef::Branch {
            id: branch.id.clone(),
        }],
        fields: Vec::new(),
        modes: vec![AccessMode::Read],
        scope: task.scope,
        valid_time: None,
    }];
    let mut labels = Vec::new();
    let mut sources = Vec::new();
    for definition in &branch.compile.definitions {
        if !affected.contains(&definition.reference)
            || !matches!(&definition.body, DefinitionBody::SourceBinding(_))
        {
            continue;
        }
        let capture = selected_branch_capture(tx, branch, &definition.reference)
            .await?
            .ok_or_else(SyncError::protocol)?;
        let material = capture.read_impact(tx).await?;
        access.extend(material.access);
        labels.extend(material.labels);
        sources.extend(material.source_ids);
        access.push(AccessScope {
            resources: vec![ResourceRef::Source {
                id: capture.dto.basis.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Write, AccessMode::Manage],
            scope: capture.plan.binding_body.scope.clone(),
            valid_time: None,
        });
        // Identity creation has no canonical ID yet; its sole owner requires scope-wide write.
        access.push(AccessScope {
            resources: Vec::new(),
            fields: Vec::new(),
            modes: vec![AccessMode::Read, AccessMode::Write],
            scope: capture.plan.binding_body.scope.clone(),
            valid_time: Some(capture.raw.valid_time.clone()),
        });
        access.push(AccessScope {
            resources: vec![
                ResourceRef::Source {
                    id: capture.dto.basis.source_id.clone(),
                },
                ResourceRef::Branch {
                    id: branch.id.clone(),
                },
                ResourceRef::Definition {
                    id: definition.reference.id.clone(),
                },
            ],
            fields: capture
                .plan
                .field_definitions
                .iter()
                .map(|d| d.reference.clone())
                .chain(
                    capture
                        .plan
                        .relation_definitions
                        .iter()
                        .map(|d| d.reference.clone()),
                )
                .collect(),
            modes: vec![AccessMode::Manage, AccessMode::Approve],
            scope: capture.plan.binding_body.scope.clone(),
            valid_time: Some(capture.plan.authority.valid_time.clone()),
        });
        for evidence in &capture.dto.evidence {
            labels.extend(evidence.access.labels.clone());
            access.push(AccessScope {
                resources: vec![ResourceRef::Evidence {
                    id: evidence.reference.id.clone(),
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read, AccessMode::Write],
                scope: capture.plan.binding_body.scope.clone(),
                valid_time: None,
            });
        }
        // Historical residues and removed rows retain their original valid-time authorization.
        let w = tx.world();
        for row in tx.query("SELECT body FROM world_source_claim WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 AND partition_key=$4 AND binding_id=$5", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &capture.dto.basis.source_id.as_str(), &capture.raw.assignment.partition, &definition.reference.id.as_str()]).await? {
            let assertion: world_protocol::facts::Assertion = super::decode(row.get("body"))?;
            access.push(AccessScope { resources: Vec::new(), fields: Vec::new(), modes: vec![AccessMode::Read, AccessMode::Write], scope: assertion.scope.clone(), valid_time: Some(assertion.valid_time.clone()) });
            for reference in assertion.evidence {
                let evidence = crate::facts::assertions::read_evidence(tx, &reference).await?.ok_or_else(SyncError::protocol)?;
                labels.extend(evidence.access.labels);
            }
        }
    }
    Ok(authorization::actual_impact(
        access,
        vec![Effect::Pure],
        labels,
        Vec::new(),
        sources,
    )?)
}

pub(crate) fn require_capture_after(
    current: &BranchCapture,
    previous: &SourceBasis,
) -> Result<(), SyncError> {
    require_basis_after(&current.dto.basis, previous)
}

pub(crate) fn require_basis_after(
    basis: &SourceBasis,
    previous: &SourceBasis,
) -> Result<(), SyncError> {
    if basis.source_id != previous.source_id
        || basis.incarnation != previous.incarnation
        || basis.binding != previous.binding
        || basis.schema != previous.schema
        || basis.mapping_revision != previous.mapping_revision
        || basis.authority_revision != previous.authority_revision
        || basis.identity_rule != previous.identity_rule
        || basis.gap.is_some()
        || previous.gap.is_some()
    {
        return Err(super::source_failure(
            world_protocol::sources::SourceFailure::PositionIncomparable,
            world_protocol::failure::FailureStage::Validate,
        ));
    }
    if basis == previous {
        return Ok(());
    }
    let (Some(at), Some(before)) = (&basis.position, &previous.position) else {
        return Err(super::source_failure(
            world_protocol::sources::SourceFailure::PositionIncomparable,
            world_protocol::failure::FailureStage::Validate,
        ));
    };
    crate::sources::connectors::cdc::require_position_after(at, before).map_err(SyncError::from)
}

pub(in crate::sources) fn same_model(original: &WorldBranch, current: &WorldBranch) -> bool {
    original.world == current.world
        && original.id == current.id
        && original.revision <= current.revision
        && original.task_id == current.task_id
        && original.task_revision == current.task_revision
        && original.candidate_id == current.candidate_id
        && original.change_set_id == current.change_set_id
        && original.basis.release_id == current.basis.release_id
        && original.basis.overlay == current.basis.overlay
        && original.basis.assumptions == current.basis.assumptions
        && original.compile == current.compile
}
pub(super) fn check(budget: &CallBudget, cancel: &CancellationToken) -> Result<(), SyncError> {
    if cancel.is_cancelled() {
        return Err(world_protocol::sources::MappingFailure::Cancelled.into());
    }
    budget
        .charge(world_protocol::budget::BudgetDimension::Steps, 1)
        .map_err(
            |error| world_protocol::sources::MappingFailure::BudgetExceeded {
                dimension: error.dimension,
            },
        )?;
    Ok(())
}

pub(crate) async fn require_candidate_ready(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    branch: &BranchRef,
    affected: &[DefinitionRef],
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<CandidateSources, SyncError> {
    Reader::Transaction(tx)
        .ready(admission, branch, affected, budget, cancel)
        .await
}
pub(crate) async fn require_candidate_ready_snapshot(
    snapshot: &WorldSnapshot<'_>,
    admission: &Admission,
    branch: &BranchRef,
    affected: &[DefinitionRef],
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<CandidateSources, SyncError> {
    Reader::Snapshot(snapshot)
        .ready(admission, branch, affected, budget, cancel)
        .await
}

#[derive(Clone)]
pub(crate) struct CandidateSources {
    pub(super) branch: BranchRef,
    pub(super) affected: Vec<DefinitionRef>,
    pub(super) captures: Vec<BranchCapture>,
}
impl CandidateSources {
    pub(crate) fn bases(&self) -> Vec<SourceBasis> {
        self.captures
            .iter()
            .map(|capture| capture.dto.basis.clone())
            .collect()
    }
}

/// Only a current admission's real Content read can construct this proof.
#[derive(Clone)]
pub(crate) struct VerifiedCandidateSources {
    pub(super) sources: CandidateSources,
}

pub(crate) async fn verify_candidate_sources(
    store: &crate::store::WorldStore,
    content: &crate::content::Content,
    admission: &Admission,
    sources: &CandidateSources,
    budget: &CallBudget,
    cancel: &CancellationToken,
) -> Result<VerifiedCandidateSources, SyncError> {
    for capture in &sources.captures {
        check(budget, cancel)?;
        super::verify_branch_capture(store, content, admission, capture, budget, cancel).await?;
    }
    Ok(VerifiedCandidateSources {
        sources: sources.clone(),
    })
}

/// Computes requirements only. Admission and the native broker remain separate authorities.
pub(crate) async fn branch_capture_impact(
    tx: &WorldTransaction<'_>,
    branch: &WorldBranch,
    affected: &[DefinitionRef],
) -> Result<ActualImpact, SyncError> {
    if tx.world() != &branch.world {
        return Err(SyncError::protocol());
    }
    let reference = BranchRef {
        world: branch.world.clone(),
        id: branch.id.clone(),
        revision: branch.revision,
    };
    let task = crate::evaluation::read_task(tx, &branch.task_id, branch.task_revision)
        .await
        .map_err(|error| {
            SyncError::caused(
                world_protocol::sources::SourceFailure::Release {
                    failure: Box::new(world_protocol::releases::ReleaseFailure::BasisChanged {
                        resources: vec![ResourceRef::Task {
                            id: branch.task_id.clone(),
                        }],
                    }),
                },
                world_protocol::failure::FailureStage::Validate,
                error,
            )
        })?;
    let mut result = authorization::actual_impact(
        vec![AccessScope {
            resources: vec![ResourceRef::Branch {
                id: branch.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Write],
            scope: task.scope,
            valid_time: None,
        }],
        vec![Effect::SourceRead, Effect::Pure],
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )?;
    let active = crate::releases::read_active_model(tx)
        .await
        .map_err(mapping::MappingError::from)?;
    for definition in &branch.compile.definitions {
        let DefinitionBody::SourceBinding(binding) = &definition.body else {
            continue;
        };
        if !affected.contains(&definition.reference) {
            continue;
        }
        let plan = mapping::compile_branch_binding(tx, &reference, &definition.reference).await?;
        let material = authorization::source_capture_impact(
            tx,
            &binding.scope,
            &binding.source_id,
            &binding.retention,
            &definition.valid_time,
        )
        .await?;
        result.access.extend(material.access);
        result.labels.extend(material.labels);
        result.source_ids.extend(material.source_ids);
        result.access.push(AccessScope {
            resources: vec![ResourceRef::Source {
                id: binding.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: binding.scope.clone(),
            valid_time: None,
        });
        result.access.push(AccessScope {
            resources: vec![ResourceRef::Branch {
                id: branch.id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read, AccessMode::Write],
            scope: binding.scope.clone(),
            valid_time: Some(definition.valid_time.clone()),
        });
        let w = tx.world();
        let row = tx.query_opt("SELECT body FROM world_source_connection_revision WHERE tenant_id=$1 AND world_id=$2 AND connection_id=$3 AND revision=$4", &[&w.tenant_id.as_str(), &w.world_id.as_str(), &binding.connection_id.as_str(), &number(binding.connection_revision.0)?]).await?.ok_or_else(SyncError::protocol)?;
        let connection: world_protocol::sources::ConnectionRevision =
            super::decode(row.get("body"))?;
        if connection.world != branch.world
            || connection.id != binding.connection_id
            || connection.revision != binding.connection_revision
            || connection.source_id != binding.source_id
        {
            return Err(SyncError::protocol());
        }
        if connection.scope != binding.scope {
            result.access.push(AccessScope {
                resources: vec![ResourceRef::Source {
                    id: connection.source_id,
                }],
                fields: Vec::new(),
                modes: vec![AccessMode::Read],
                scope: connection.scope,
                valid_time: None,
            });
        }
        for property in &plan.field_definitions {
            result.labels.extend(property.body.access_labels.clone());
            result.access.push(AccessScope {
                resources: vec![ResourceRef::Source {
                    id: binding.source_id.clone(),
                }],
                fields: vec![property.reference.clone()],
                modes: vec![AccessMode::Read],
                scope: property.scope.clone(),
                valid_time: None,
            });
            if let Some(current) = active.as_ref().and_then(|release| {
                release
                    .definitions
                    .iter()
                    .find(|current| current.reference.id == property.reference.id)
            }) {
                let DefinitionBody::Property(body) = &current.body else {
                    return Err(SyncError::protocol());
                };
                result.labels.extend(body.access_labels.clone());
                if current.scope != property.scope {
                    result.access.push(AccessScope {
                        resources: vec![ResourceRef::Source {
                            id: binding.source_id.clone(),
                        }],
                        fields: vec![property.reference.clone()],
                        modes: vec![AccessMode::Read],
                        scope: current.scope.clone(),
                        valid_time: None,
                    });
                }
            }
        }
    }
    Ok(authorization::actual_impact(
        result.access,
        result.effects,
        result.labels,
        result.state,
        result.source_ids,
    )?)
}
