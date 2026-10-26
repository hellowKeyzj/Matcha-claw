use std::collections::{BTreeMap, BTreeSet, VecDeque};
use tokio_util::sync::CancellationToken;
use crate::{authorization::{self, Admission, VerifiedInvocation}, extensions::invocation::CallBudget, store::{StoreError, WorldSnapshot, WorldTransaction}};
use super::{basis, decode, dependencies, number, reject, watches::auth_error};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact}, commit::CommitFailure,
    definitions::DefinitionBody, expression::Effect,
    facts::{Assertion, Evidence}, failure::FailureStage, identity::SubjectRef, ids::*,
    provenance::{ConclusionSupport, ProvenanceFailure, ProvenanceLimit, QueryWatch, ReadDependency, SupportSet, SupportSnapshot},
    releases::Release, time::{Timestamp, ValidTime},
};

/// The ordinary resolver owns truth; this guard only authorizes and seals its actual reads.
pub(crate) async fn resolve_verified_interval(
    tx: &WorldTransaction<'_>, verified: &VerifiedInvocation, conclusion: &AssertionRef,
    scope: &ScopeId, release: &ReleaseId, budget: &CallBudget, cancel: &CancellationToken,
    interval: &ValidTime,
) -> Result<(ConclusionSupport, Vec<ReadDependency>, ActualImpact, Digest), StoreError> {
    super::checkpoint(budget, cancel)?;
    if verified.invocation().world != *tx.world() || verified.invocation().branch_id.is_some()
        || conclusion.world != *tx.world() { return Err(reject(ProvenanceFailure::CrossScope)); }
    let now = tx.now().await?;
    let root = authorization::actual_impact(vec![AccessScope {
        resources: vec![ResourceRef::Assertion { id: conclusion.id.clone() }], fields: Vec::new(),
        modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(interval.clone()),
    }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new()).map_err(auth_error)?;
    authorization::check_impact_read(tx, verified, &root, &now).await.map_err(auth_error)?;
    let model = crate::query::support_model(tx, release, None).await.map_err(super::query_error)?;
    let current = crate::releases::read_active_model(tx).await.map_err(release_error)?
        .ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
    let mut guard = ReadGuard::new(tx, verified, &model, &current, budget, cancel, &now, interval);
    guard.impacts.push(root);
    let snapshot = basis::support_snapshot_read(basis::Reader::Transaction(tx), conclusion, &model,
        scope, Some(budget), Some(cancel), &now, Some(&mut guard)).await?;
    let result = super::maintenance::resolve_interval(&snapshot, conclusion, scope, release, None, interval);
    let (dependencies, impact, fingerprint) = guard.finish(&snapshot, &result).await?;
    Ok((result, dependencies, impact, fingerprint))
}

/// Branch premises still use the canonical truth kernel, with their caller's original read authority.
pub(in crate::facts) async fn recheck_authorized_dependencies(
    authority: ReadAuthority<'_, '_>, dependencies: &[ReadDependency], model: &Release, scope: &ScopeId,
    interval: &ValidTime, now: &Timestamp, limits: Option<(&CallBudget, &CancellationToken)>,
) -> Result<(bool, ActualImpact), StoreError> {
    if model.world != *authority.reader().world() || model.source_branch.is_some() {
        return Err(reject(ProvenanceFailure::CrossScope));
    }
    if dependencies.len() > super::BATCH_LIMIT { return Err(super::limit(ProvenanceLimit::ProposalItems)); }
    let current = current_model(authority.reader()).await?;
    let mut guard = ReadGuard::with_authority(authority, model, &current, limits, now, interval);
    let mut valid = true;
    for dependency in dependencies {
        match basis::require_current_guarded_read(authority.reader(), std::slice::from_ref(dependency),
            Some((model, scope, interval)), now, Some(&mut guard), limits).await {
            Ok(()) => {},
            Err(error) if matches!(error.reason, CommitFailure::ReadDependencyChanged { .. }) => valid = false,
            Err(error) => return Err(error),
        }
    }
    let (_, impact, _) = guard.finish_basis(&(dependencies, valid)).await?;
    Ok((valid, impact))
}

/// Pre-admission metadata discovery returns requirements, never authority or a truth result.
pub(in crate::facts) async fn dependency_closure_impact(
    reader: basis::Reader<'_, '_>, dependencies: &[ReadDependency], model: &Release, scope: &ScopeId,
    interval: &ValidTime, now: &Timestamp,
) -> Result<Option<ActualImpact>, StoreError> {
    if model.world != *reader.world() || model.source_branch.is_some() { return Err(reject(ProvenanceFailure::CrossScope)); }
    if dependencies.is_empty() { return Ok(None); }
    if dependencies.len() > super::BATCH_LIMIT { return Err(super::limit(ProvenanceLimit::ProposalItems)); }
    let current = current_model(reader).await?;
    let mut guard = ReadGuard::collect(reader, model, &current, now, interval);
    for dependency in dependencies { guard.dependency(dependency, scope, interval).await?; }
    let roots = dependencies.iter().filter_map(|dependency| match dependency {
        ReadDependency::Assertion { reference } => Some(reference.clone()), _ => None,
    }).collect::<Vec<_>>();
    let graph = basis::support_graph_read(reader, &roots, model, scope, None, None, now, Some(&mut guard)).await?;
    if guard.impacts.is_empty() { return Ok(None); }
    let (_, impact, _) = guard.finish_basis(&graph.basis()).await?;
    Ok(Some(impact))
}

async fn current_model(reader: basis::Reader<'_, '_>) -> Result<Release, StoreError> {
    match reader {
        basis::Reader::Transaction(tx) => crate::releases::read_active_model(tx).await.map_err(release_error)?,
        basis::Reader::Snapshot(snapshot) => match crate::releases::read_active_release_snapshot(snapshot).await.map_err(release_error)? {
            Some(id) => crate::releases::read_release_snapshot(snapshot, &id).await.map_err(release_error)?,
            None => None,
        },
    }.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))
}

#[derive(Clone, Copy)]
pub(in crate::facts) enum ReadAuthority<'a, 'b> {
    Transaction(&'a WorldTransaction<'b>, &'a VerifiedInvocation),
    Snapshot(&'a WorldSnapshot<'b>, &'a Admission),
}
impl<'a, 'b> ReadAuthority<'a, 'b> {
    fn reader(self) -> basis::Reader<'a, 'b> {
        match self { Self::Transaction(tx, _) => basis::Reader::Transaction(tx), Self::Snapshot(snapshot, _) => basis::Reader::Snapshot(snapshot) }
    }
    async fn check(self, impact: &ActualImpact, now: &Timestamp) -> Result<(), StoreError> {
        match self {
            Self::Transaction(tx, verified) => { authorization::check_impact_read(tx, verified, impact, now).await.map_err(auth_error)?; },
            Self::Snapshot(snapshot, admission) => {
                authorization::recheck_read(snapshot, admission, now).await.map_err(auth_error)?;
                admission.require_access(impact).map_err(auth_error)?;
            }
        }
        Ok(())
    }
    async fn output(self, impact: &ActualImpact, delivered: u64, now: &Timestamp) -> Result<(), StoreError> {
        match self {
            Self::Transaction(tx, verified) => { authorization::check_impact_read_output(tx, verified, impact, delivered, now).await.map_err(auth_error)?; },
            Self::Snapshot(snapshot, admission) => { authorization::check_admitted_output_read(snapshot, admission, impact, delivered, now).await.map_err(auth_error)?; }
        }
        Ok(())
    }
}

pub(super) struct ReadGuard<'a, 'b> {
    reader: basis::Reader<'a, 'b>, authority: Option<ReadAuthority<'a, 'b>>,
    model: &'a Release, current: &'a Release, limits: Option<(&'a CallBudget, &'a CancellationToken)>,
    now: &'a Timestamp, interval: &'a ValidTime, impacts: Vec<ActualImpact>,
    observed: BTreeMap<String, ReadDependency>, metadata: BTreeMap<String, serde_json::Value>,
    seen: BTreeSet<String>, entities: BTreeSet<ResourceRef>, cuts: BTreeSet<Timestamp>,
}
impl<'a, 'b> ReadGuard<'a, 'b> {
    pub(super) fn new(
        tx: &'a WorldTransaction<'b>, verified: &'a VerifiedInvocation, model: &'a Release,
        current: &'a Release, budget: &'a CallBudget, cancel: &'a CancellationToken,
        now: &'a Timestamp, interval: &'a ValidTime,
    ) -> Self {
        Self::with_authority(ReadAuthority::Transaction(tx, verified), model, current, Some((budget, cancel)), now, interval)
    }

    fn with_authority(authority: ReadAuthority<'a, 'b>, model: &'a Release, current: &'a Release,
        limits: Option<(&'a CallBudget, &'a CancellationToken)>, now: &'a Timestamp, interval: &'a ValidTime,
    ) -> Self {
        let mut cuts = BTreeSet::from([interval.from.clone()]);
        cuts.extend(interval.to.iter().cloned());
        Self { reader: authority.reader(), authority: Some(authority), model, current, limits, now, interval, impacts: Vec::new(),
            observed: BTreeMap::new(), metadata: BTreeMap::new(), seen: BTreeSet::new(), entities: BTreeSet::new(), cuts }
    }

    fn collect(reader: basis::Reader<'a, 'b>, model: &'a Release, current: &'a Release,
        now: &'a Timestamp, interval: &'a ValidTime,
    ) -> Self {
        let mut cuts = BTreeSet::from([interval.from.clone()]);
        cuts.extend(interval.to.iter().cloned());
        Self { reader, authority: None, model, current, limits: None, now, interval, impacts: Vec::new(),
            observed: BTreeMap::new(), metadata: BTreeMap::new(), seen: BTreeSet::new(), entities: BTreeSet::new(), cuts }
    }

    fn checkpoint(&self) -> Result<(), StoreError> {
        if let Some((budget, cancel)) = self.limits { super::checkpoint(budget, cancel)?; }
        Ok(())
    }

    pub(super) fn interval(&self) -> &ValidTime { self.interval }
    pub(super) fn cuts(&self) -> Vec<Timestamp> { self.cuts.iter().cloned().collect() }
    fn cut(&mut self, at: &Timestamp) -> Result<(), StoreError> {
        if at >= &self.interval.from && self.interval.to.as_ref().is_none_or(|to| at <= to) {
            self.cuts.insert(at.clone());
            if self.cuts.len() > super::BATCH_LIMIT { return Err(super::limit(ProvenanceLimit::ProposalItems)); }
        }
        Ok(())
    }
    fn cut_interval(&mut self, interval: &ValidTime) -> Result<(), StoreError> {
        self.cut(&interval.from)?;
        if let Some(to) = &interval.to { self.cut(to)?; }
        Ok(())
    }

    async fn impact(&mut self, impact: ActualImpact) -> Result<(), StoreError> {
        self.checkpoint()?;
        if let Some(authority) = self.authority { authority.check(&impact, self.now).await?; }
        for access in &impact.access { self.entities.extend(access.resources.iter().cloned()); }
        if self.entities.len() > super::BATCH_LIMIT { return Err(super::limit(ProvenanceLimit::ComponentNodes)); }
        if !self.impacts.contains(&impact) { self.impacts.push(impact); }
        Ok(())
    }

    pub(super) async fn resource(
        &mut self, resource: ResourceRef, scope: &ScopeId, interval: &ValidTime,
        fields: Vec<DefinitionRef>, labels: Vec<String>, sources: Vec<SourceId>,
    ) -> Result<(), StoreError> {
        self.impact(authorization::actual_impact(vec![AccessScope {
            resources: vec![resource], fields, modes: vec![AccessMode::Read],
            scope: scope.clone(), valid_time: Some(interval.clone()),
        }], vec![Effect::Pure], labels, Vec::new(), sources).map_err(auth_error)?).await
    }

    fn record(&mut self, key: &impl serde::Serialize, value: &impl serde::Serialize) -> Result<(), StoreError> {
        self.checkpoint()?;
        let key = digest(key)?.to_string();
        if self.metadata.len() == super::BATCH_LIMIT && !self.metadata.contains_key(&key) {
            return Err(super::limit(ProvenanceLimit::ProposalItems));
        }
        self.metadata.insert(key, super::encode(value)?);
        Ok(())
    }

    pub(super) async fn support(&mut self, support: &SupportSet) -> Result<(), StoreError> {
        if support.reference.world != *self.reader.world() || support.conclusion.world != *self.reader.world()
            || support.rule.world != *self.reader.world() || support.release_id != self.model.id || support.branch_id.is_some() {
            return Err(reject(ProvenanceFailure::CrossScope));
        }
        self.cut_interval(&support.valid_time)?;
        self.record(&("support", &support.reference), support)?;
        for dependency in dependencies(support) {
            self.dependency(&dependency, &support.scope, &support.valid_time).await?;
        }
        let mut resources = Vec::new();
        for argument in &support.arguments { crate::facts::assertions::value_resources(&argument.value, &mut resources); }
        for resource in resources { self.resource(resource, &support.scope, &support.valid_time, Vec::new(), Vec::new(), Vec::new()).await?; }
        Ok(())
    }

    pub(super) async fn dependency(&mut self, dependency: &ReadDependency, scope: &ScopeId, interval: &ValidTime) -> Result<(), StoreError> {
        let mut pending = VecDeque::from([dependency.clone()]);
        while let Some(dependency) = pending.pop_front() {
            self.checkpoint()?;
            let key = digest(&(&dependency, scope, interval))?.to_string();
            if !self.seen.insert(key) { continue; }
            if self.seen.len() > super::BATCH_LIMIT { return Err(super::limit(ProvenanceLimit::ProposalItems)); }
            self.observed.insert(digest(&dependency)?.to_string(), dependency.clone());
            match dependency {
                ReadDependency::Assertion { reference } => {
                    self.world(&reference.world)?;
                    let resource = ResourceRef::Assertion { id: reference.id.clone() };
                    self.resource(resource.clone(), scope, interval, Vec::new(), Vec::new(), Vec::new()).await?;
                    self.reader.query_opt("SELECT revision FROM world_assertion_head WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 FOR SHARE", "SELECT revision FROM world_assertion_head WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &reference.id.as_str()]).await?;
                    let row = self.reader.query_opt("SELECT r.scope_id,r.predicate_id,r.predicate_revision,r.body->'validTime' AS valid_time FROM world_assertion_revision r WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.assertion_id=$3 AND r.revision=$4", "SELECT r.scope_id,r.predicate_id,r.predicate_revision,r.body->'validTime' AS valid_time FROM world_assertion_revision r WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.assertion_id=$3 AND r.revision=$4", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?]).await?;
                    if let Some(row) = row {
                        let actual_scope = ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                        let actual_interval: ValidTime = decode(row.get("valid_time"))?;
                        let predicate = DefinitionRef { world: self.reader.world().clone(), id: DefinitionId::try_new(row.get::<_, String>("predicate_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?, revision: Revision(u64::try_from(row.get::<_, i64>("predicate_revision")).map_err(|_| reject(ProvenanceFailure::InternalFault))?) };
                        let labels = self.labels(&predicate);
                        self.resource(resource, &actual_scope, &actual_interval, vec![predicate.clone()], labels, Vec::new()).await?;
                        let row = self.reader.query_opt("SELECT r.body,h.revision AS head_revision FROM world_assertion_revision r LEFT JOIN world_assertion_head h USING(tenant_id,world_id,assertion_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.assertion_id=$3 AND r.revision=$4", "SELECT r.body,h.revision AS head_revision FROM world_assertion_revision r LEFT JOIN world_assertion_head h USING(tenant_id,world_id,assertion_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.assertion_id=$3 AND r.revision=$4", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                        let assertion: Assertion = decode(row.get("body"))?;
                        if assertion.reference != reference || assertion.scope != actual_scope || assertion.valid_time != actual_interval { return Err(reject(ProvenanceFailure::InternalFault)); }
                        self.cut_interval(&assertion.valid_time)?;
                        self.record(&("assertion", &reference), &(&assertion, row.get::<_, Option<i64>>("head_revision")))?;
                        pending.extend(assertion.evidence.iter().cloned().map(|reference| ReadDependency::Evidence { reference }));
                        pending.push_back(ReadDependency::Definition { reference: predicate });
                        for subject in crate::facts::assertions::claim_subjects(&assertion.claim) {
                            let resource = match subject { SubjectRef::Object { id } => ResourceRef::Object { id }, SubjectRef::Relation { id } => ResourceRef::Relation { id } };
                            self.resource(resource, &actual_scope, &actual_interval, Vec::new(), Vec::new(), Vec::new()).await?;
                        }
                        if let world_protocol::facts::AssertionOrigin::Source { binding, .. } = assertion.origin {
                            pending.push_back(ReadDependency::Definition { reference: binding });
                        }
                    } else { self.record(&("assertion", &reference), &Option::<Assertion>::None)?; }
                }
                ReadDependency::Evidence { reference } => {
                    self.world(&reference.world)?;
                    let resource = ResourceRef::Evidence { id: reference.id.clone() };
                    self.resource(resource.clone(), scope, interval, Vec::new(), Vec::new(), Vec::new()).await?;
                    let head = self.reader.query_opt("SELECT revision FROM world_evidence_head WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3 FOR SHARE", "SELECT revision FROM world_evidence_head WHERE tenant_id=$1 AND world_id=$2 AND evidence_id=$3", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &reference.id.as_str()]).await?;
                    self.record(&("evidence_head", &reference.id), &head.map(|row| row.get::<_, i64>("revision")))?;
                    let rows = self.reader.query("SELECT r.body FROM world_evidence_revision r WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.evidence_id=$3 AND (r.revision=$4 OR r.revision=(SELECT h.revision FROM world_evidence_head h WHERE h.tenant_id=r.tenant_id AND h.world_id=r.world_id AND h.evidence_id=r.evidence_id)) ORDER BY r.revision", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &reference.id.as_str(), &number(reference.revision.0)?]).await?;
                    for row in rows {
                        let evidence: Evidence = decode(row.get("body"))?;
                        let source = evidence.locator.source_version.source_id.clone();
                        self.resource(resource.clone(), scope, interval, Vec::new(), evidence.access.labels.clone(), vec![source.clone()]).await?;
                        self.resource(ResourceRef::Source { id: source }, scope, interval, Vec::new(), evidence.access.labels.clone(), vec![evidence.locator.source_version.source_id.clone()]).await?;
                        self.record(&("evidence", &evidence.reference), &evidence)?;
                        self.observed.insert(digest(&ReadDependency::Evidence { reference: evidence.reference.clone() })?.to_string(), ReadDependency::Evidence { reference: evidence.reference.clone() });
                        let source = match self.reader {
                            basis::Reader::Transaction(tx) => crate::content::read_source_version_metadata(tx, &evidence.locator.source_version).await,
                            basis::Reader::Snapshot(snapshot) => crate::content::read_source_version_metadata_snapshot(snapshot, &evidence.locator.source_version).await,
                        }.map_err(|error| match error { crate::content::Error::Store(error) => error, error => StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Read, error) })?;
                        let material = match self.reader {
                            basis::Reader::Transaction(tx) => authorization::material_read_impact(tx, &source).await,
                            basis::Reader::Snapshot(snapshot) => authorization::material_read_impact_snapshot(snapshot, &source).await,
                        }.map_err(auth_error)?;
                        self.impact(material).await?;
                        self.record(&("source_version", &source.reference), &source)?;
                    }
                }
                ReadDependency::Definition { reference } => {
                    self.world(&reference.world)?;
                    self.resource(ResourceRef::Definition { id: reference.id.clone() }, scope, interval, vec![reference.clone()], self.labels(&reference), Vec::new()).await?;
                    let definitions: Vec<_> = self.model.definitions.iter().filter(|item| item.reference == reference)
                        .chain(self.current.definitions.iter().filter(|item| item.reference.id == reference.id)).cloned().collect();
                    for definition in definitions {
                        let labels = match &definition.body { DefinitionBody::Property(property) => property.access_labels.clone(), _ => Vec::new() };
                        self.resource(ResourceRef::Definition { id: definition.reference.id.clone() }, &definition.scope, interval, vec![definition.reference.clone()], labels, Vec::new()).await?;
                        self.record(&("definition", &definition.reference), &definition)?;
                        if let DefinitionBody::SourceBinding(binding) = definition.body {
                            self.resource(ResourceRef::Source { id: binding.source_id.clone() }, &binding.scope, interval, Vec::new(), Vec::new(), vec![binding.source_id]).await?;
                            pending.extend(binding.field_mapping.into_iter().map(|field| ReadDependency::Definition { reference: field.property }));
                        }
                    }
                }
                ReadDependency::Watch { id, .. } => {
                    let row = self.reader.query_opt("SELECT scope_id FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3", "SELECT scope_id FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &id.as_str()]).await?;
                    let watch_scope = row.map(|row| ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))).transpose()?.unwrap_or_else(|| scope.clone());
                    self.resource(ResourceRef::Watch { id: id.clone() }, &watch_scope, interval, Vec::new(), Vec::new(), Vec::new()).await?;
                    let row = self.reader.query_opt("SELECT generation,body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3 FOR SHARE", "SELECT generation,body FROM world_watch WHERE tenant_id=$1 AND world_id=$2 AND watch_id=$3", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &id.as_str()]).await?;
                    if let Some(row) = row {
                        let watch: QueryWatch = decode(row.get("body"))?;
                        if watch.scope != watch_scope || watch.world != *self.reader.world() { return Err(reject(ProvenanceFailure::CrossScope)); }
                        if let Some(world_protocol::expression::TimeWindow::Fixed { interval }) = &watch.window { self.cut_interval(interval)?; }
                        if let Some(boundary) = &watch.next_boundary { self.cut(boundary)?; }
                        self.record(&("watch", &id), &(row.get::<_, i64>("generation"), &watch))?;
                        pending.extend(watch.datasets.into_iter().map(|reference| ReadDependency::Definition { reference }));
                    } else { self.record(&("watch", &id), &Option::<QueryWatch>::None)?; }
                }
                ReadDependency::Source { position, binding } => {
                    self.world(&binding.world)?;
                    self.resource(ResourceRef::Source { id: position.source_id.clone() }, scope, interval, Vec::new(), Vec::new(), vec![position.source_id.clone()]).await?;
                    self.resource(ResourceRef::Definition { id: binding.id.clone() }, scope, interval, vec![binding.clone()], Vec::new(), Vec::new()).await?;
                    let row = self.reader.query_opt("SELECT c.applied,c.gap,p.binding_id,p.binding_revision,p.source_incarnation FROM world_source_checkpoint c JOIN world_source_partition p USING(tenant_id,world_id,source_id,partition_key) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.partition_key=$4 FOR SHARE OF c,p", "SELECT c.applied,c.gap,p.binding_id,p.binding_revision,p.source_incarnation FROM world_source_checkpoint c JOIN world_source_partition p USING(tenant_id,world_id,source_id,partition_key) WHERE c.tenant_id=$1 AND c.world_id=$2 AND c.source_id=$3 AND c.partition_key=$4", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &position.source_id.as_str(), &position.partition]).await?;
                    let value = row.map(|row| (row.get::<_, Option<serde_json::Value>>("applied"), row.get::<_, Option<serde_json::Value>>("gap"), row.get::<_, String>("binding_id"), row.get::<_, i64>("binding_revision"), row.get::<_, String>("source_incarnation")));
                    self.record(&("source", &position.source_id, &position.partition), &value)?;
                    pending.push_back(ReadDependency::Definition { reference: binding });
                }
                ReadDependency::SourceMapping { binding, authority, .. } => {
                    self.world(&binding.world)?;
                    self.resource(ResourceRef::Definition { id: binding.id.clone() }, scope, interval, vec![binding.clone()], Vec::new(), Vec::new()).await?;
                    let head = self.reader.query_opt("SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR SHARE", "SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &binding.id.as_str()]).await?;
                    self.record(&("source_binding_head", &binding.id), &head.map(|row| row.get::<_, i64>("revision")))?;
                    let rows = self.reader.query("SELECT r.revision,r.source_id,r.scope_id,r.content_digest FROM world_source_binding_revision r WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.binding_id=$3 AND (r.revision=$4 OR r.revision=(SELECT h.revision FROM world_source_binding_head h WHERE h.tenant_id=r.tenant_id AND h.world_id=r.world_id AND h.binding_id=r.binding_id)) ORDER BY r.revision", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &binding.id.as_str(), &number(binding.revision.0)?]).await?;
                    for row in rows {
                        let source = SourceId::try_new(row.get::<_, String>("source_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                        let binding_scope = ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                        self.resource(ResourceRef::Source { id: source.clone() }, &binding_scope, interval, Vec::new(), Vec::new(), vec![source.clone()]).await?;
                        self.record(&("source_binding", &binding.id, row.get::<_, i64>("revision")), &(source, binding_scope, row.get::<_, String>("content_digest")))?;
                    }
                    pending.push_back(ReadDependency::Definition { reference: binding.clone() });
                    let row = self.reader.query_opt("SELECT r.scope_id,r.source_id FROM world_source_authority_revision r WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.policy_id=$3 AND r.revision=$4", "SELECT r.scope_id,r.source_id FROM world_source_authority_revision r WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.policy_id=$3 AND r.revision=$4", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &authority.policy_id.as_str(), &number(authority.revision.0)?]).await?;
                    if let Some(row) = row {
                        let source = SourceId::try_new(row.get::<_, String>("source_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                        let authority_scope = ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                        self.resource(ResourceRef::Source { id: source.clone() }, &authority_scope, interval, Vec::new(), Vec::new(), vec![source]).await?;
                        let row = self.reader.query_opt("SELECT r.body,r.status,h.revision AS head_revision FROM world_source_authority_revision r LEFT JOIN world_source_authority_head h USING(tenant_id,world_id,policy_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.policy_id=$3 AND r.revision=$4", "SELECT r.body,r.status,h.revision AS head_revision FROM world_source_authority_revision r LEFT JOIN world_source_authority_head h USING(tenant_id,world_id,policy_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.policy_id=$3 AND r.revision=$4", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &authority.policy_id.as_str(), &number(authority.revision.0)?]).await?.ok_or_else(|| reject(ProvenanceFailure::MissingPremise))?;
                        self.record(&("source_authority", &authority), &(row.get::<_, serde_json::Value>("body"), row.get::<_, String>("status"), row.get::<_, Option<i64>>("head_revision")))?;
                    }
                }
                ReadDependency::SourceField { schema, .. } => {
                    self.world(&schema.world)?;
                    let row = self.reader.query_opt("SELECT source_id FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4", "SELECT source_id FROM world_source_schema_revision WHERE tenant_id=$1 AND world_id=$2 AND schema_id=$3 AND revision=$4", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &schema.id.as_str(), &number(schema.revision.0)?]).await?;
                    if let Some(row) = row {
                        let source = SourceId::try_new(row.get::<_, String>("source_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                        self.resource(ResourceRef::Source { id: source.clone() }, scope, interval, Vec::new(), Vec::new(), vec![source.clone()]).await?;
                        let head = self.reader.query_opt("SELECT revision FROM world_source_schema_head WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3 FOR SHARE", "SELECT revision FROM world_source_schema_head WHERE tenant_id=$1 AND world_id=$2 AND source_id=$3", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &source.as_str()]).await?;
                        self.record(&("schema_head", &source), &head.map(|row| row.get::<_, i64>("revision")))?;
                        let rows = self.reader.query("SELECT r.revision,r.body FROM world_source_schema_revision r WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.source_id=$3 AND (r.revision=$4 OR r.revision=(SELECT h.revision FROM world_source_schema_head h WHERE h.tenant_id=r.tenant_id AND h.world_id=r.world_id AND h.source_id=r.source_id)) ORDER BY r.revision", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &source.as_str(), &number(schema.revision.0)?]).await?;
                        for row in rows { self.record(&("schema", &source, row.get::<_, i64>("revision")), &row.get::<_, serde_json::Value>("body"))?; }
                    }
                }
                ReadDependency::Identity { subject, .. } => {
                    let (resource, locked, unlocked, id) = match subject {
                        SubjectRef::Object { id } => (ResourceRef::Object { id: id.clone() }, "SELECT revision FROM world_object_identity WHERE tenant_id=$1 AND world_id=$2 AND object_id=$3 FOR SHARE", "SELECT revision FROM world_object_identity WHERE tenant_id=$1 AND world_id=$2 AND object_id=$3", id.to_string()),
                        SubjectRef::Relation { id } => (ResourceRef::Relation { id: id.clone() }, "SELECT revision FROM world_relation_identity WHERE tenant_id=$1 AND world_id=$2 AND relation_id=$3 FOR SHARE", "SELECT revision FROM world_relation_identity WHERE tenant_id=$1 AND world_id=$2 AND relation_id=$3", id.to_string()),
                    };
                    self.resource(resource.clone(), scope, interval, Vec::new(), Vec::new(), Vec::new()).await?;
                    let row = self.reader.query_opt(locked, unlocked, &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &id]).await?;
                    self.record(&("identity", resource), &row.map(|row| row.get::<_, i64>("revision")))?;
                }
                ReadDependency::AliasRange { digest: range, .. } => {
                    let row = self.reader.query_opt("SELECT source_id FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND range_digest=$3", "SELECT source_id FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND range_digest=$3", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &range.as_str()]).await?;
                    if let Some(row) = row {
                        let source = SourceId::try_new(row.get::<_, String>("source_id")).map_err(|_| reject(ProvenanceFailure::InternalFault))?;
                        self.resource(ResourceRef::Source { id: source.clone() }, scope, interval, Vec::new(), Vec::new(), vec![source]).await?;
                        let row = self.reader.query_opt("SELECT generation FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND range_digest=$3 FOR SHARE", "SELECT generation FROM world_alias_range WHERE tenant_id=$1 AND world_id=$2 AND range_digest=$3", &[&self.reader.world().tenant_id.as_str(), &self.reader.world().world_id.as_str(), &range.as_str()]).await?;
                        self.record(&("alias_range", &range), &row.map(|row| row.get::<_, i64>("generation")))?;
                    }
                }
                ReadDependency::TimeBoundary { at } => { self.cut(&at)?; self.record(&("time_boundary", &at), &(self.now < &at))?; }
            }
        }
        Ok(())
    }

    fn world(&self, world: &WorldRef) -> Result<(), StoreError> {
        if world != self.reader.world() { Err(reject(ProvenanceFailure::CrossScope)) } else { Ok(()) }
    }

    fn labels(&self, reference: &DefinitionRef) -> Vec<String> {
        self.model.definitions.iter().filter(|item| item.reference == *reference)
            .chain(self.current.definitions.iter().filter(|item| item.reference.id == reference.id))
            .filter_map(|item| match &item.body { DefinitionBody::Property(property) => Some(property.access_labels.iter().cloned()), _ => None }).flatten().collect()
    }

    async fn finish(self, snapshot: &SupportSnapshot, result: &ConclusionSupport) -> Result<(Vec<ReadDependency>, ActualImpact, Digest), StoreError> {
        self.finish_basis(&(snapshot, result)).await
    }

    pub(super) async fn finish_basis(self, basis: &impl serde::Serialize) -> Result<(Vec<ReadDependency>, ActualImpact, Digest), StoreError> {
        self.checkpoint()?;
        let (mut access, mut effects, mut labels, mut state, mut sources) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for impact in self.impacts { access.extend(impact.access); effects.extend(impact.effects); labels.extend(impact.labels); state.extend(impact.state); sources.extend(impact.source_ids); }
        let impact = authorization::actual_impact(access, effects, labels, state, sources).map_err(auth_error)?;
        if let Some(authority) = self.authority { authority.output(&impact, self.metadata.len() as u64, self.now).await?; }
        let dependencies = self.observed.into_values().collect::<Vec<_>>();
        let fingerprint = digest(&("world.support-read.v1", &self.model.id, basis, &self.cuts, &dependencies, &impact, self.metadata))?;
        Ok((dependencies, impact, fingerprint))
    }
}

fn digest(value: &impl serde::Serialize) -> Result<Digest, StoreError> {
    crate::definitions::canonical_digest(value).map_err(|error| StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Prepare, crate::definitions::DefinitionError::from(error)))
}
fn release_error(error: crate::releases::Error) -> StoreError {
    StoreError::caused_by(CommitFailure::InvalidBatch, FailureStage::Read, error)
}
