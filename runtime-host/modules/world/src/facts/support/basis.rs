use super::{contains, decode, dependencies, encode, number, reject};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use tokio_util::sync::CancellationToken;
use crate::extensions::invocation::CallBudget;
use crate::store::{StoreError, WorldSnapshot, WorldTransaction};
use tokio_postgres::{Row, types::ToSql};
use world_protocol::provenance::ProvenanceFailure;
use world_protocol::{
    commit::CommitFailure,
    definitions::{Definition, DefinitionBody, DefinitionLifecycle},
    facts::{Assertion, AssertionOrigin, AssertionStatus},
    failure::FailureStage,
    identity::SubjectRef,
    ids::*,
    provenance::{ConclusionSupport, QueryWatch, ReadDependency, SupportSet, SupportSnapshot, SupportStatus, WatchCoverage, WatchPurpose},
    releases::Release,
    time::{Timestamp, ValidTime},
    value::DirtyState,
};

#[derive(Clone, Copy, Eq, PartialEq, serde::Serialize)]
pub(in crate::facts) enum Validity {
    Valid,
    Pending,
    Invalid,
}

#[derive(Clone, Copy)]
pub(in crate::facts) enum Reader<'a, 'b> {
    Transaction(&'a WorldTransaction<'b>),
    Snapshot(&'a WorldSnapshot<'b>),
}
impl Reader<'_, '_> {
    pub(in crate::facts) fn world(&self) -> &WorldRef {
        match self {
            Self::Transaction(tx) => tx.world(),
            Self::Snapshot(snapshot) => snapshot.world(),
        }
    }

    pub(in crate::facts) async fn query(
        &self,
        statement: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Vec<Row>, StoreError> {
        match self {
            Self::Transaction(tx) => tx.query(statement, parameters).await,
            Self::Snapshot(snapshot) => snapshot.query(statement, parameters).await,
        }
    }

    pub(super) async fn query_opt(
        &self,
        locked: &'static str,
        unlocked: &'static str,
        parameters: &[&(dyn ToSql + Sync)],
    ) -> Result<Option<Row>, StoreError> {
        match self {
            Self::Transaction(tx) => tx.query_opt(locked, parameters).await,
            Self::Snapshot(snapshot) => snapshot.query_opt(unlocked, parameters).await,
        }
    }
}

fn read_checkpoint(budget: Option<&CallBudget>, cancellation: Option<&CancellationToken>) -> Result<(), StoreError> {
    if let (Some(budget), Some(cancellation)) = (budget, cancellation) {
        super::checkpoint(budget, cancellation)?;
    }
    Ok(())
}

pub(super) async fn stored_supports(
    reader: Reader<'_, '_>, conclusion: &AssertionRef, scope: &ScopeId,
    release: &ReleaseId, branch: Option<&BranchId>,
    budget: Option<&CallBudget>, cancellation: Option<&CancellationToken>,
) -> Result<Vec<SupportSet>, StoreError> {
    stored_supports_read(reader, conclusion, scope, release, branch, budget, cancellation, None).await
}

async fn stored_supports_read(
    reader: Reader<'_, '_>, conclusion: &AssertionRef, scope: &ScopeId,
    release: &ReleaseId, branch: Option<&BranchId>,
    budget: Option<&CallBudget>, cancellation: Option<&CancellationToken>,
    mut guard: Option<&mut super::verified::ReadGuard<'_, '_>>,
) -> Result<Vec<SupportSet>, StoreError> {
    if conclusion.world != *reader.world() { return Err(reject(ProvenanceFailure::CrossScope)); }
    let mut supports = Vec::new();
    let mut after = String::new();
    loop {
        read_checkpoint(budget, cancellation)?;
        let sql = if guard.is_some() {
            match reader {
                Reader::Transaction(_) => "SELECT r.support_id,r.body->'validTime' AS valid_time FROM world_support_revision r JOIN world_support_head h USING(tenant_id,world_id,support_id,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.conclusion_id=$3 AND r.conclusion_revision=$4 AND r.scope_id=$5 AND r.release_id=$6 AND r.branch_id IS NOT DISTINCT FROM $7 AND r.support_id>$8 ORDER BY r.support_id LIMIT 256 FOR SHARE OF h",
                Reader::Snapshot(_) => "SELECT r.support_id,r.body->'validTime' AS valid_time FROM world_support_revision r JOIN world_support_head h USING(tenant_id,world_id,support_id,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.conclusion_id=$3 AND r.conclusion_revision=$4 AND r.scope_id=$5 AND r.release_id=$6 AND r.branch_id IS NOT DISTINCT FROM $7 AND r.support_id>$8 ORDER BY r.support_id LIMIT 256",
            }
        } else {
            "SELECT r.support_id,r.body FROM world_support_revision r JOIN world_support_head h USING(tenant_id,world_id,support_id,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.conclusion_id=$3 AND r.conclusion_revision=$4 AND r.scope_id=$5 AND r.release_id=$6 AND r.branch_id IS NOT DISTINCT FROM $7 AND r.support_id>$8 ORDER BY r.support_id LIMIT 256"
        };
        let rows = reader.query(sql, &[&reader.world().tenant_id.as_str(), &reader.world().world_id.as_str(), &conclusion.id.as_str(), &number(conclusion.revision.0)?, &scope.as_str(), &release.as_str(), &branch.map(BranchId::as_str), &after]).await?;
        if rows.is_empty() { break; }
        for row in rows {
            read_checkpoint(budget, cancellation)?;
            after = row.get("support_id");
            if supports.len() == super::BATCH_LIMIT { return Err(super::limit(world_protocol::provenance::ProvenanceLimit::AlternativeSupports)); }
            let support = if let Some(guard) = guard.as_deref_mut() {
                let id = SupportId::try_new(after.clone()).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                let interval: ValidTime = decode(row.get("valid_time"))?;
                guard.resource(ResourceRef::Support { id }, scope, &interval, Vec::new(), Vec::new(), Vec::new()).await?;
                let row = reader.query_opt(
                    "SELECT r.body FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id=$3",
                    "SELECT r.body FROM world_support_head h JOIN world_support_revision r USING(tenant_id,world_id,support_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.support_id=$3",
                    &[&reader.world().tenant_id.as_str(), &reader.world().world_id.as_str(), &after],
                ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let support: SupportSet = decode(row.get("body"))?;
                if support.reference.id.as_str() != after || support.conclusion != *conclusion
                    || support.scope != *scope || support.valid_time != interval {
                    return Err(reject(ProvenanceFailure::CrossScope));
                }
                guard.support(&support).await?;
                support
            } else { decode(row.get("body"))? };
            supports.push(support);
        }
    }
    Ok(supports)
}

pub(super) struct SupportGraph {
    groups: BTreeMap<AssertionRef, SupportSnapshot>,
    assertions: BTreeMap<AssertionRef, Assertion>,
    states: BTreeMap<SupportId, Validity>,
    order: Vec<AssertionRef>,
}

impl SupportGraph {
    pub(super) fn basis(&self) -> impl serde::Serialize + '_ {
        (self.groups.iter().collect::<Vec<_>>(), self.assertions.iter().collect::<Vec<_>>(), &self.states, &self.order)
    }

    pub(super) fn stored(&self, root: &AssertionRef) -> Result<&[SupportSet], StoreError> {
        self.groups.get(root).map(|snapshot| snapshot.supports.as_slice()).ok_or_else(|| reject(ProvenanceFailure::MissingPremise))
    }

    pub(super) fn resolve(
        &self, conclusion: &AssertionRef, model: &Release, scope: &ScopeId,
        interval: Option<&ValidTime>, budget: Option<&CallBudget>, cancel: Option<&CancellationToken>,
    ) -> Result<SupportSnapshot, StoreError> {
        let branch = model.source_branch.as_ref().map(|branch| &branch.id);
        let mut resolved = BTreeMap::<AssertionRef, SupportSnapshot>::new();
        for reference in &self.order {
            read_checkpoint(budget, cancel)?;
            let mut snapshot = self.groups[reference].clone();
            if let Some(interval) = interval {
                snapshot.supports.retain(|support| support.valid_time.to.as_ref().is_none_or(|to| &interval.from < to)
                    && interval.to.as_ref().is_none_or(|to| &support.valid_time.from < to));
                for support in &mut snapshot.supports {
                    if support.valid_time.from < interval.from { support.valid_time.from = interval.from.clone(); }
                    if interval.to.as_ref().is_some_and(|to| support.valid_time.to.as_ref().is_none_or(|old| to < old)) {
                        support.valid_time.to = interval.to.clone();
                    }
                }
            }
            for support in &mut snapshot.supports {
                read_checkpoint(budget, cancel)?;
                if support.status != SupportStatus::Valid || support.dirty != DirtyState::Clean { continue; }
                let mut state = self.states[&support.reference.id];
                for dependency in dependencies(support) {
                    read_checkpoint(budget, cancel)?;
                    let ReadDependency::Assertion { reference: premise } = dependency else { continue; };
                    if let Some(assertion) = self.assertions.get(&premise) {
                        if assertion.scope != *scope || !contains(&assertion.valid_time, &support.valid_time) {
                            state = Validity::Invalid;
                        }
                        if self.states[&support.reference.id] == Validity::Valid && state != Validity::Invalid
                            && matches!(assertion.origin, AssertionOrigin::Derived {})
                            && let Some(snapshot) = resolved.get(&premise) {
                            match super::maintenance::resolve_interval(snapshot, &premise, scope, &model.id, branch, &support.valid_time) {
                                ConclusionSupport::Supported { .. } => {},
                                ConclusionSupport::Dirty { .. } => state = Validity::Pending,
                                ConclusionSupport::Unsupported => state = Validity::Invalid,
                            }
                        }
                    }
                }
                support.status = match state {
                    Validity::Valid => SupportStatus::Valid, Validity::Pending => SupportStatus::Pending,
                    Validity::Invalid => SupportStatus::Invalid,
                };
            }
            resolved.insert(reference.clone(), snapshot);
        }
        resolved.remove(conclusion).ok_or_else(|| reject(ProvenanceFailure::MissingPremise))
    }
}

/// Rebuild the cached groups against live dependencies, then resolve the acyclic AND/OR closure.
pub(super) async fn support_snapshot(
    reader: Reader<'_, '_>, conclusion: &AssertionRef, model: &Release, scope: &ScopeId,
    budget: Option<&CallBudget>, cancellation: Option<&CancellationToken>, at: &Timestamp,
) -> Result<SupportSnapshot, StoreError> {
    support_snapshot_read(reader, conclusion, model, scope, budget, cancellation, at, None).await
}

pub(super) async fn support_snapshot_read(
    reader: Reader<'_, '_>, conclusion: &AssertionRef, model: &Release, scope: &ScopeId,
    budget: Option<&CallBudget>, cancellation: Option<&CancellationToken>, at: &Timestamp,
    mut guard: Option<&mut super::verified::ReadGuard<'_, '_>>,
) -> Result<SupportSnapshot, StoreError> {
    let graph = support_graph_read(reader, std::slice::from_ref(conclusion), model, scope,
        budget, cancellation, at, guard.take()).await?;
    graph.resolve(conclusion, model, scope, None, budget, cancellation)
}

pub(super) async fn support_graph_read(
    reader: Reader<'_, '_>, roots: &[AssertionRef], model: &Release, scope: &ScopeId,
    budget: Option<&CallBudget>, cancellation: Option<&CancellationToken>, at: &Timestamp,
    mut guard: Option<&mut super::verified::ReadGuard<'_, '_>>,
) -> Result<SupportGraph, StoreError> {
    if roots.iter().any(|root| root.world != *reader.world()) || model.world != *reader.world() {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    let branch = model.source_branch.as_ref().map(|branch| &branch.id);
    let mut pending = VecDeque::from(roots.to_vec());
    let mut loaded = BTreeSet::new();
    let mut groups = BTreeMap::<AssertionRef, SupportSnapshot>::new();
    let mut assertions = BTreeMap::new();
    let mut states = BTreeMap::new();
    let mut children = BTreeMap::<AssertionRef, BTreeSet<AssertionRef>>::new();
    let mut count = 0;
    let mut dependency_count = 0;
    while let Some(reference) = pending.pop_front() {
        read_checkpoint(budget, cancellation)?;
        if !loaded.insert(reference.clone()) { continue; }
        if loaded.len() > super::BATCH_LIMIT {
            return Err(super::limit(world_protocol::provenance::ProvenanceLimit::ComponentNodes));
        }
        if let Some(guard) = guard.as_deref_mut() {
            let interval = guard.interval().clone();
            guard.dependency(&ReadDependency::Assertion { reference: reference.clone() }, scope, &interval).await?;
        }
        let mut snapshot = SupportSnapshot { assertions: vec![reference.clone()], evidence: Vec::new(), supports: Vec::new(), watches: Vec::new() };
        let mut needed = BTreeSet::new();
        for support in stored_supports_read(reader, &reference, scope, &model.id, branch, budget, cancellation, guard.as_deref_mut()).await? {
            read_checkpoint(budget, cancellation)?;
            count += 1;
            if count > super::BATCH_LIMIT {
                return Err(super::limit(world_protocol::provenance::ProvenanceLimit::AlternativeSupports));
            }
            let mut state = Validity::Valid;
            let mut derived = Vec::new();
            let active = support.status == SupportStatus::Valid && support.dirty == DirtyState::Clean;
            if active || guard.is_some() {
                for dependency in dependencies(&support) {
                    read_checkpoint(budget, cancellation)?;
                    dependency_count += 1;
                    if dependency_count > super::BATCH_LIMIT { return Err(super::limit(world_protocol::provenance::ProvenanceLimit::ProposalItems)); }
                    if let Some(guard) = guard.as_deref_mut() {
                        guard.dependency(&dependency, scope, &support.valid_time).await?;
                    }
                    let validity = if active { match check_read(reader, &dependency, Some((model, scope, &support.valid_time)), at).await {
                        Ok(validity) => validity,
                        Err(error) if matches!(super::provenance_failure(&error), ProvenanceFailure::BasisChanged { .. } | ProvenanceFailure::UnclosedRange { .. }) => Validity::Pending,
                        Err(error) => return Err(error),
                    } } else { Validity::Pending };
                    if validity == Validity::Invalid { state = Validity::Invalid; }
                    else if validity == Validity::Pending && state != Validity::Invalid { state = Validity::Pending; }
                    if let ReadDependency::Assertion { reference } = dependency {
                        if !assertions.contains_key(&reference) {
                            let row = reader.query_opt("SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", "SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", &[&reader.world().tenant_id.as_str(), &reader.world().world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?]).await?;
                            if let Some(row) = row { assertions.insert(reference.clone(), decode::<Assertion>(row.get("body"))?); }
                        }
                        if let Some(assertion) = assertions.get(&reference) {
                            if guard.is_none() && (assertion.scope != *scope || !contains(&assertion.valid_time, &support.valid_time)) {
                                state = Validity::Invalid;
                            }
                            if matches!(assertion.origin, AssertionOrigin::Derived {}) {
                                if guard.is_some() { pending.push_back(reference.clone()); }
                                if active { derived.push(reference); }
                            }
                        }
                    }
                }
                if state == Validity::Valid { needed.extend(derived); }
            }
            states.insert(support.reference.id.clone(), state);
            snapshot.supports.push(support);
        }
        pending.extend(needed.iter().cloned());
        children.insert(reference.clone(), needed);
        groups.insert(reference, snapshot);
    }
    let mut parents = BTreeMap::<AssertionRef, Vec<AssertionRef>>::new();
    for (parent, children) in &children {
        for child in children { parents.entry(child.clone()).or_default().push(parent.clone()); }
    }
    let mut ready: VecDeque<_> = children.iter().filter(|(_, children)| children.is_empty()).map(|(reference, _)| reference.clone()).collect();
    let mut order = Vec::new();
    while let Some(reference) = ready.pop_front() {
        read_checkpoint(budget, cancellation)?;
        order.push(reference.clone());
        for parent in parents.remove(&reference).unwrap_or_default() {
            let remaining = children.get_mut(&parent).ok_or_else(|| reject(ProvenanceFailure::InternalFault))?;
            remaining.remove(&reference);
            if remaining.is_empty() { ready.push_back(parent); }
        }
    }
    if order.len() != groups.len() {
        return Err(reject(ProvenanceFailure::CyclicSupport { assertions: children.into_iter().filter(|(_, children)| !children.is_empty()).map(|(reference, _)| reference).collect() }));
    }
    Ok(SupportGraph { groups, assertions, states, order })
}

pub(in crate::facts) async fn check_read(
    reader: Reader<'_, '_>,
    dependency: &ReadDependency,
    model: Option<(&Release, &ScopeId, &ValidTime)>,
    at: &Timestamp,
) -> Result<Validity, StoreError> {
    let world = reader.world();
    let tenant = world.tenant_id.as_str();
    let world_id = world.world_id.as_str();
    Ok(match dependency {
        ReadDependency::Assertion { reference } => {
            if reference.world != *world { return Err(reject(ProvenanceFailure::CrossScope)); }
            let row = reader.query_opt(
                "SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.assertion_id=$3 AND h.revision=$4 FOR SHARE OF h",
                "SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.assertion_id=$3 AND h.revision=$4",
                &[&tenant, &world_id, &reference.id.as_str(), &number(reference.revision.0)?],
            ).await?;
            match row {
                None => Validity::Invalid,
                Some(row) => match decode::<Assertion>(row.get("body"))?.status {
                    AssertionStatus::Accepted => Validity::Valid,
                    AssertionStatus::Candidate => Validity::Pending,
                    AssertionStatus::Rejected | AssertionStatus::Withdrawn => Validity::Invalid,
                },
            }
        }
        ReadDependency::Evidence { reference } => {
            if reference.world != *world { return Err(reject(ProvenanceFailure::CrossScope)); }
            let row = reader.query_opt(
                "SELECT r.status FROM world_evidence_revision r JOIN world_evidence_head h USING(tenant_id,world_id,evidence_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.evidence_id=$3 AND r.revision=$4 AND NOT EXISTS(SELECT 1 FROM world_evidence_revision n WHERE n.tenant_id=r.tenant_id AND n.world_id=r.world_id AND n.evidence_id=r.evidence_id AND n.revision>r.revision AND n.revision<=h.revision AND n.status IN ('withdrawn','content_deleted')) FOR SHARE OF h",
                "SELECT r.status FROM world_evidence_revision r JOIN world_evidence_head h USING(tenant_id,world_id,evidence_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.evidence_id=$3 AND r.revision=$4 AND NOT EXISTS(SELECT 1 FROM world_evidence_revision n WHERE n.tenant_id=r.tenant_id AND n.world_id=r.world_id AND n.evidence_id=r.evidence_id AND n.revision>r.revision AND n.revision<=h.revision AND n.status IN ('withdrawn','content_deleted'))",
                &[&tenant, &world_id, &reference.id.as_str(), &number(reference.revision.0)?],
            ).await?;
            match row.as_ref().map(|row| row.get::<_, String>("status")).as_deref() {
                Some("active") => Validity::Valid,
                _ => Validity::Invalid,
            }
        }
        ReadDependency::Definition { reference } => {
            if reference.world != *world { return Err(reject(ProvenanceFailure::CrossScope)); }
            if let Some((model, scope, valid_time)) = model {
                if model.world != *world { return Err(reject(ProvenanceFailure::CrossScope)); }
                return match model.definitions.iter().find(|definition| definition.reference == *reference) {
                    Some(definition) => {
                        crate::definitions::validate_applicability(definition, scope, valid_time, &model.scopes)
                            .map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, crate::definitions::DefinitionError::from(error)))?;
                        Ok(Validity::Valid)
                    }
                    None => Ok(Validity::Invalid),
                };
            }
            let row = reader.query_opt(
                "SELECT r.body FROM world_definition_head h JOIN world_definition_revision r USING(tenant_id,world_id,definition_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.definition_id=$3 AND h.revision=$4 FOR SHARE OF h",
                "SELECT r.body FROM world_definition_head h JOIN world_definition_revision r USING(tenant_id,world_id,definition_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.definition_id=$3 AND h.revision=$4",
                &[&tenant, &world_id, &reference.id.as_str(), &number(reference.revision.0)?],
            ).await?;
            match row {
                Some(row) if matches!(decode::<Definition<DefinitionBody>>(row.get("body"))?.lifecycle, DefinitionLifecycle::Available) => Validity::Valid,
                _ => Validity::Invalid,
            }
        }
        ReadDependency::Watch { id, generation } => {
            let row = reader.query_opt(
                "SELECT generation,body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3 FOR SHARE",
                "SELECT generation,body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3",
                &[&tenant, &world_id, &id.as_str()],
            ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
            let actual = Generation(row.get::<_, i64>("generation") as u64);
            if actual != *generation { return Err(reject(ProvenanceFailure::BasisChanged { watch_id: id.clone(), expected: *generation, actual })); }
            let watch: QueryWatch = decode(row.get("body"))?;
            if watch.next_boundary.as_ref().is_some_and(|boundary| boundary <= at) { return Ok(Validity::Pending); }
            match (watch.purpose, watch.coverage) {
                (WatchPurpose::NotExists | WatchPurpose::MissingField, WatchCoverage::Partial | WatchCoverage::Gap) => return Err(reject(ProvenanceFailure::UnclosedRange { watch_id: id.clone() })),
                (_, WatchCoverage::Partial | WatchCoverage::Gap) => Validity::Pending,
                _ => Validity::Valid,
            }
        }
        ReadDependency::Source { position, binding } => {
            if binding.world != *world { return Err(reject(ProvenanceFailure::CrossScope)); }
            let row = reader.query_opt(
                "SELECT c.applied,c.gap,p.binding_id,p.binding_revision,p.source_incarnation FROM world_source_checkpoint c JOIN world_source_partition p USING(tenant_id,world_id,source_id,partition_key) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.partition_key=$4 FOR SHARE OF c,p",
                "SELECT c.applied,c.gap,p.binding_id,p.binding_revision,p.source_incarnation FROM world_source_checkpoint c JOIN world_source_partition p USING(tenant_id,world_id,source_id,partition_key) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.partition_key=$4",
                &[&tenant, &world_id, &position.source_id.as_str(), &position.partition],
            ).await?;
            match row {
                Some(row) if row.get::<_, String>("binding_id") == binding.id.as_str()
                    && row.get::<_, i64>("binding_revision") == number(binding.revision.0)?
                    && row.get::<_, String>("source_incarnation") == position.incarnation
                    && row.get::<_, Option<serde_json::Value>>("applied") == Some(encode(position)?)
                    && row.get::<_, Option<serde_json::Value>>("gap").is_none() => Validity::Valid,
                _ => Validity::Pending,
            }
        }
        ReadDependency::SourceMapping { .. } | ReadDependency::SourceField { .. } => {
            let result = match reader {
                Reader::Transaction(tx) => crate::sources::mapping::recheck_dependencies(tx, std::slice::from_ref(dependency)).await,
                Reader::Snapshot(snapshot) => crate::sources::mapping::recheck_dependencies_snapshot(snapshot, std::slice::from_ref(dependency)).await,
            };
            result.map_err(|error| match error {
                crate::sources::mapping::MappingError::Store(error) => error,
                error => StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Validate, error),
            })?;
            Validity::Valid
        }
        ReadDependency::TimeBoundary { at: boundary } => if at < boundary { Validity::Valid } else { Validity::Pending },
        ReadDependency::Identity { subject, revision } => {
            let (locked, unlocked, id) = match subject {
                SubjectRef::Object { id } => (
                    "SELECT revision FROM world_object_identity WHERE tenant_id=$1 AND world_id=$2 AND object_id=$3 FOR SHARE",
                    "SELECT revision FROM world_object_identity WHERE tenant_id=$1 AND world_id=$2 AND object_id=$3",
                    id.as_str(),
                ),
                SubjectRef::Relation { id } => (
                    "SELECT revision FROM world_relation_identity WHERE tenant_id=$1 AND world_id=$2 AND relation_id=$3 FOR SHARE",
                    "SELECT revision FROM world_relation_identity WHERE tenant_id=$1 AND world_id=$2 AND relation_id=$3",
                    id.as_str(),
                ),
            };
            match reader.query_opt(locked, unlocked, &[&tenant, &world_id, &id]).await? {
                Some(row) if row.get::<_, i64>("revision") == number(revision.0)? => Validity::Valid,
                _ => Validity::Invalid,
            }
        }
        ReadDependency::AliasRange { digest, generation } => {
            match reader.query_opt(
                "SELECT generation FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND range_digest=$3 FOR SHARE",
                "SELECT generation FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND range_digest=$3",
                &[&tenant, &world_id, &digest.as_str()],
            ).await? {
                Some(row) if row.get::<_, i64>("generation") == number(generation.0)? => Validity::Valid,
                _ => Validity::Pending,
            }
        }
    })
}

pub(super) async fn validate_support(
    tx: &WorldTransaction<'_>,
    support: &SupportSet,
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    at: &Timestamp,
) -> Result<Validity, StoreError> {
    if support.reference.world != *tx.world()
        || support.conclusion.world != *tx.world()
        || support.rule.world != *tx.world()
    {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    if support.premises.is_empty() {
        return Err(reject(ProvenanceFailure::MissingPremise));
    }
    if support.premises.len() > super::BATCH_LIMIT {
        return Err(super::limit(
            world_protocol::provenance::ProvenanceLimit::ProposalItems,
        ));
    }
    let row = tx.query_opt(
        "SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &support.conclusion.id.as_str(), &number(support.conclusion.revision.0)?],
    ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    let conclusion: Assertion = decode(row.get("body"))?;
    if conclusion.scope != support.scope {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    if !contains(&conclusion.valid_time, &support.valid_time) {
        return Err(reject(ProvenanceFailure::InvalidInterval));
    }
    let model = crate::query::support_model(tx, &support.release_id, support.branch_id.as_ref())
        .await
        .map_err(super::query_error)?;
    let mut validity = Validity::Valid;
    for dependency in dependencies(support) {
        super::checkpoint(budget, cancellation)?;
        let state = check_read(
            Reader::Transaction(tx),
            &dependency,
            Some((&model, &support.scope, &support.valid_time)),
            at,
        )
        .await?;
        if state == Validity::Invalid {
            validity = Validity::Invalid;
        } else if state == Validity::Pending && validity != Validity::Invalid {
            validity = Validity::Pending;
        }
        match dependency {
            ReadDependency::Assertion { reference } => {
                let row = tx.query_opt("SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let premise: Assertion = decode(row.get("body"))?;
                if premise.scope != support.scope {
                    return Err(reject(ProvenanceFailure::CrossScope));
                }
                if !contains(&premise.valid_time, &support.valid_time) {
                    return Err(reject(ProvenanceFailure::InvalidInterval));
                }
                if matches!(
                    premise.origin,
                    world_protocol::facts::AssertionOrigin::Derived { .. }
                ) {
                    match super::maintenance::resolve_transaction_interval(
                        tx,
                        &reference,
                        &support.scope,
                        &support.release_id,
                        support.branch_id.as_ref(),
                        budget,
                        cancellation,
                        &support.valid_time,
                    )
                    .await?
                    {
                        world_protocol::provenance::ConclusionSupport::Supported { .. } => {}
                        world_protocol::provenance::ConclusionSupport::Dirty { .. }
                            if validity != Validity::Invalid =>
                        {
                            validity = Validity::Pending
                        }
                        world_protocol::provenance::ConclusionSupport::Dirty { .. } => {}
                        world_protocol::provenance::ConclusionSupport::Unsupported => {
                            validity = Validity::Invalid
                        }
                    }
                }
            }
            ReadDependency::Definition { reference } => {
                if let Some(rule) = model
                    .definitions
                    .iter()
                    .find(|definition| definition.reference == reference)
                {
                    if reference == support.rule && !matches!(rule.body, DefinitionBody::Rule(_)) {
                        return Err(reject(ProvenanceFailure::MissingPremise));
                    }
                }
            }
            _ => {}
        }
    }
    Ok(validity)
}

pub(crate) async fn support_retention(
    tx: &WorldTransaction<'_>,
    references: &[SupportRef],
) -> Result<crate::store::RetentionRoots, StoreError> {
    let mut roots = crate::store::RetentionRoots::default();
    for reference in references {
        if reference.world != *tx.world() {
            return Err(reject(ProvenanceFailure::CrossScope));
        }
        let row = tx.query_opt(
            "SELECT body FROM world_support_revision WHERE tenant_id=$1 AND world_id=$2 AND support_id=$3 AND revision=$4",
            &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?],
        ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
        let support: SupportSet = decode(row.get("body"))?;
        if support.reference != *reference {
            return Err(reject(ProvenanceFailure::MissingPremise));
        }
        retain_support(&mut roots, &support);
    }
    Ok(roots)
}

pub(crate) fn retain_support(roots: &mut crate::store::RetentionRoots, support: &SupportSet) {
    roots.scopes.push(support.scope.clone());
    roots.releases.push(support.release_id.clone());
    roots.resources.push(ResourceRef::Support {
        id: support.reference.id.clone(),
    });
    if let Some(id) = &support.branch_id {
        roots.resources.push(ResourceRef::Branch { id: id.clone() });
    }
    roots.dependencies.push(ReadDependency::Assertion {
        reference: support.conclusion.clone(),
    });
    roots.dependencies.extend(dependencies(support));
    for argument in &support.arguments {
        crate::facts::assertions::value_resources(&argument.value, &mut roots.resources);
    }
    if let world_protocol::value::DirtyState::Dirty { watches, .. } = &support.dirty {
        roots
            .resources
            .extend(watches.iter().cloned().map(|id| ResourceRef::Watch { id }));
    }
}

/// Definition observations must belong to a real evaluated or stored support context.
pub(super) async fn require_observed(
    tx: &WorldTransaction<'_>,
    observed: &[ReadDependency],
    supports: &[SupportSet],
    budget: &crate::extensions::invocation::CallBudget,
    cancellation: &tokio_util::sync::CancellationToken,
    at: &Timestamp,
) -> Result<(), StoreError> {
    if observed.len() > super::BATCH_LIMIT {
        return Err(super::limit(
            world_protocol::provenance::ProvenanceLimit::ProposalItems,
        ));
    }
    let mut contexts = BTreeMap::<String, Vec<&SupportSet>>::new();
    for support in supports {
        super::checkpoint(budget, cancellation)?;
        for dependency in dependencies(support) {
            contexts.entry(super::key(&dependency)?).or_default().push(support);
        }
    }
    let mut models = BTreeMap::new();
    for dependency in observed {
        super::checkpoint(budget, cancellation)?;
        let contexts = contexts
            .get(&super::key(dependency)?)
            .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
        for support in contexts {
            super::checkpoint(budget, cancellation)?;
            let key = (support.release_id.clone(), support.branch_id.clone());
            if !models.contains_key(&key) {
                let model = crate::query::support_model(
                    tx,
                    &support.release_id,
                    support.branch_id.as_ref(),
                )
                .await
                .map_err(super::query_error)?;
                models.insert(key.clone(), model);
            }
            require_current_in_model(
                tx,
                std::slice::from_ref(dependency),
                &models[&key],
                &support.scope,
                &support.valid_time,
                at,
            )
            .await?;
        }
    }
    Ok(())
}

pub(crate) async fn require_current(
    tx: &WorldTransaction<'_>,
    dependencies: &[ReadDependency],
    at: &Timestamp,
) -> Result<(), StoreError> {
    require_current_read(Reader::Transaction(tx), dependencies, None, at).await
}

pub(crate) async fn require_current_snapshot(
    snapshot: &WorldSnapshot<'_>,
    dependencies: &[ReadDependency],
    at: &Timestamp,
) -> Result<(), StoreError> {
    require_current_read(Reader::Snapshot(snapshot), dependencies, None, at).await
}

/// The caller supplies its canonical execution model and separately enforces current authorization.
pub(crate) async fn require_current_in_model(
    tx: &WorldTransaction<'_>,
    dependencies: &[ReadDependency],
    model: &Release,
    scope: &ScopeId,
    valid_time: &ValidTime,
    at: &Timestamp,
) -> Result<(), StoreError> {
    require_current_read(
        Reader::Transaction(tx),
        dependencies,
        Some((model, scope, valid_time)),
        at,
    )
    .await
}

pub(crate) async fn require_current_snapshot_in_model(
    snapshot: &WorldSnapshot<'_>,
    dependencies: &[ReadDependency],
    model: &Release,
    scope: &ScopeId,
    valid_time: &ValidTime,
    at: &Timestamp,
) -> Result<(), StoreError> {
    require_current_read(
        Reader::Snapshot(snapshot),
        dependencies,
        Some((model, scope, valid_time)),
        at,
    )
    .await
}

pub(in crate::facts) async fn require_current_read(
    reader: Reader<'_, '_>,
    dependencies: &[ReadDependency],
    model: Option<(&Release, &ScopeId, &ValidTime)>,
    at: &Timestamp,
) -> Result<(), StoreError> {
    require_current_guarded_read(reader, dependencies, model, at, None, None).await
}

pub(super) async fn require_current_guarded_read(
    reader: Reader<'_, '_>, dependencies: &[ReadDependency], model: Option<(&Release, &ScopeId, &ValidTime)>,
    at: &Timestamp, mut guard: Option<&mut super::verified::ReadGuard<'_, '_>>,
    limits: Option<(&CallBudget, &CancellationToken)>,
) -> Result<(), StoreError> {
    let (budget, cancellation) = (limits.map(|(budget, _)| budget), limits.map(|(_, cancel)| cancel));
    let mut derived = BTreeMap::new();
    for dependency in dependencies {
        read_checkpoint(budget, cancellation)?;
        if let (Some(guard), Some((_, scope, interval))) = (guard.as_deref_mut(), model) {
            guard.dependency(dependency, scope, interval).await?;
        }
        let mut validity = check_read(reader, dependency, model, at).await?;
        if validity == Validity::Valid {
            if let ReadDependency::Assertion { reference } = dependency {
                let row = reader.query_opt("SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", "SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", &[&reader.world().tenant_id.as_str(), &reader.world().world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                let assertion: Assertion = decode(row.get("body"))?;
                if matches!(assertion.origin, AssertionOrigin::Derived { .. }) {
                    validity = if let Some((model, scope, interval)) = model {
                        if !derived.contains_key(reference) {
                            let snapshot = support_snapshot_read(reader, reference, model, scope, budget, cancellation, at, guard.as_deref_mut()).await?;
                            derived.insert(reference.clone(), super::maintenance::resolve_interval(&snapshot, reference, scope, &model.id, model.source_branch.as_ref().map(|branch| &branch.id), interval));
                        }
                        match &derived[reference] { ConclusionSupport::Supported { .. } => Validity::Valid, ConclusionSupport::Dirty { .. } => Validity::Pending, ConclusionSupport::Unsupported => Validity::Invalid }
                    } else { Validity::Pending };
                }
            }
        }
        if validity != Validity::Valid {
            let resource = match dependency {
                ReadDependency::Assertion { reference } => ResourceRef::Assertion {
                    id: reference.id.clone(),
                },
                ReadDependency::Evidence { reference } => ResourceRef::Evidence {
                    id: reference.id.clone(),
                },
                ReadDependency::Definition { reference } => ResourceRef::Definition {
                    id: reference.id.clone(),
                },
                ReadDependency::Watch { id, .. } => ResourceRef::Watch { id: id.clone() },
                ReadDependency::Source { position, .. } => ResourceRef::Source {
                    id: position.source_id.clone(),
                },
                ReadDependency::SourceMapping { binding, .. } => ResourceRef::Definition {
                    id: binding.id.clone(),
                },
                ReadDependency::SourceField { schema, .. } => {
                    let row = reader.query_opt(
                        "SELECT source_id FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4",
                        "SELECT source_id FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4",
                        &[&reader.world().tenant_id.as_str(), &reader.world().world_id.as_str(), &schema.id.as_str(), &number(schema.revision.0)?],
                    ).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                    ResourceRef::Source {
                        id: SourceId::try_new(row.get::<_, String>("source_id")).map_err(
                            |error| {
                                StoreError::caused_by(
                                    CommitFailure::InternalFault,
                                    FailureStage::Read,
                                    error,
                                )
                            },
                        )?,
                    }
                }
                ReadDependency::Identity {
                    subject: SubjectRef::Object { id },
                    ..
                } => ResourceRef::Object { id: id.clone() },
                ReadDependency::Identity {
                    subject: SubjectRef::Relation { id },
                    ..
                } => ResourceRef::Relation { id: id.clone() },
                _ => return Err(reject(ProvenanceFailure::MissingPremise)),
            };
            return Err(StoreError::new(
                CommitFailure::ReadDependencyChanged { resource },
                FailureStage::Validate,
            ));
        }
    }
    Ok(())
}
