use std::collections::{BTreeMap, BTreeSet};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    authorization::{AccessMode, AccessScope}, definitions::DefinitionBody, expression::Effect,
    facts::{Assertion, AssertionOrigin, AssertionStatus, Claim, Polarity},
    identity::{IdentityRecord, IdentitySnapshot, Object, Relation, SubjectRef}, ids::*,
    provenance::{ConclusionSupport, ReadDependency}, query::{FieldCell, QueryFailure},
    releases::Release, time::{Timestamp, ValidTime}, value::{Cell, DirtyState, UnknownReason, Value},
};
use crate::{authorization::{self, Admission, VerifiedInvocation}, store::{WorldSnapshot, WorldTransaction}};
use super::current::ReadAuthority;
use tokio_postgres::{Row, types::ToSql};
use super::{QueryError, error::{decode, invalid}, plan::CheckedPlan};

#[derive(Clone)]
pub(super) struct ProjectedSubject {
    pub identity: IdentitySnapshot,
    pub fields: BTreeMap<DefinitionRef, FieldCell>,
    pub relation: Option<ProjectedRelation>,
}
#[derive(Clone)]
pub(super) struct ProjectedRelation {
    pub claim: Option<AssertionRef>, pub type_ref: DefinitionRef,
    pub roles: Vec<world_protocol::facts::RoleBinding>, pub cells: BTreeMap<RoleId, Cell>,
    pub valid_time: ValidTime,
}
pub(super) struct Projection {
    pub subjects: BTreeMap<SubjectRef, ProjectedSubject>,
    pub dependencies: Vec<ReadDependency>,
    pub labels: Vec<String>,
    pub sources: BTreeSet<SourceId>,
    pub incomplete: bool,
}

#[derive(Clone, Copy)]
enum Reader<'a, 's> { Snapshot(&'a WorldSnapshot<'s>), Transaction(&'a WorldTransaction<'s>), Verified(&'a WorldTransaction<'s>, &'a VerifiedInvocation) }
impl Reader<'_, '_> {
    fn world(&self) -> &WorldRef { match self { Self::Snapshot(read) => read.world(), Self::Transaction(read) | Self::Verified(read, _) => read.world() } }
    async fn query(&self, sql: &'static str, parameters: &[&(dyn ToSql + Sync)]) -> Result<Vec<Row>, QueryError> {
        Ok(match self { Self::Snapshot(read) => read.query(sql, parameters).await?, Self::Transaction(read) | Self::Verified(read, _) => read.query(sql, parameters).await? })
    }
    async fn query_opt(&self, sql: &'static str, parameters: &[&(dyn ToSql + Sync)]) -> Result<Option<Row>, QueryError> {
        Ok(match self { Self::Snapshot(read) => read.query_opt(sql, parameters).await?, Self::Transaction(read) | Self::Verified(read, _) => read.query_opt(sql, parameters).await? })
    }
    async fn check(&self, authority: ReadAuthority<'_>, impact: &world_protocol::authorization::ActualImpact, now: &Timestamp) -> Result<(), QueryError> {
        match self {
            Self::Snapshot(snapshot) => {
                let ReadAuthority::Admitted(admission) = authority else { return Err(QueryFailure::BasisChanged.into()); };
                authorization::recheck_read(snapshot, admission, now).await?;
                admission.require_access(impact)?;
            },
            Self::Transaction(tx) | Self::Verified(tx, _) => authority.check(tx, impact, now).await?,
        }
        Ok(())
    }
    async fn evidence(&self, authority: ReadAuthority<'_>, references: &[EvidenceRef], scope: &ScopeId, interval: &ValidTime, now: &Timestamp) -> Result<Vec<world_protocol::facts::Evidence>, QueryError> {
        Ok(match (self, authority) {
            (Self::Snapshot(read), ReadAuthority::Admitted(admission)) => crate::facts::assertions::require_evidence_snapshot(read, admission, references, scope, Some(interval), now).await?,
            (Self::Transaction(read), ReadAuthority::Admitted(admission)) => crate::facts::assertions::require_evidence_custody_transaction(read, admission, references, scope, Some(interval), now).await?,
            (Self::Verified(read, verified), _) => crate::facts::assertions::require_evidence_preflight(read, verified, references, scope, Some(interval), now).await?,
            _ => return Err(QueryFailure::BasisChanged.into()),
        })
    }
    async fn support(&self, assertion: &AssertionRef, scope: &ScopeId, release: &Release, interval: &ValidTime, budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken) -> Result<ConclusionSupport, QueryError> {
        Ok(match self {
            Self::Snapshot(read) => {
                let support = crate::facts::support::snapshot(read, assertion, scope, &release.id, release.source_branch.as_ref().map(|branch| &branch.id), budget, cancel).await?;
                crate::facts::support::resolve_interval(&support, assertion, scope, &release.id, release.source_branch.as_ref().map(|branch| &branch.id), interval)
            }
            Self::Transaction(read) => crate::facts::support::resolve_transaction_interval(read, assertion, scope, &release.id, release.source_branch.as_ref().map(|branch| &branch.id), budget, cancel, interval).await?,
            Self::Verified(read, verified) => crate::facts::support::resolve_verified_interval(read, verified, assertion, scope, &release.id, budget, cancel, interval).await?.0,
        })
    }
}

pub(super) async fn read(
    snapshot: &WorldSnapshot<'_>, plan: &CheckedPlan, release: &Release, scope: &ScopeId,
    valid_at: &Timestamp, known_at: Option<&Timestamp>, admission: &Admission, maximum: u64,
    budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken, algorithm: bool,
) -> Result<(Projection, Vec<Assertion>), QueryError> {
    let now = snapshot.now().await?;
    authorization::recheck_read(snapshot, admission, &now).await?;
    let (projection, admitted, _, _) = read_inner(Reader::Snapshot(snapshot), plan, release, scope, &point(valid_at)?, known_at, ReadAuthority::Admitted(admission), maximum, budget, cancel, &now, algorithm).await?;
    Ok((projection, admitted))
}
pub(super) async fn read_transaction(
    tx: &WorldTransaction<'_>, plan: &CheckedPlan, release: &Release, scope: &ScopeId,
    interval: &ValidTime, admission: &Admission, maximum: u64,
    budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken,
) -> Result<Projection, QueryError> {
    let now = tx.now().await?;
    authorization::recheck(tx, admission, &now).await?;
    Ok(read_inner(Reader::Transaction(tx), plan, release, scope, interval, None, ReadAuthority::Admitted(admission), maximum, budget, cancel, &now, false).await?.0)
}

struct RuleSubject {
    identity: IdentitySnapshot, dataset: DefinitionRef, facts: Vec<Assertion>,
}
enum RuleData {
    Facts { subjects: BTreeMap<SubjectRef, RuleSubject>, support: Option<crate::facts::support::IntervalBasis> },
    Captures { captures: Vec<crate::sources::sync::BranchCapture>, derivations: Vec<crate::facts::assertions::BranchDerivationRecord>, identities: BTreeMap<SubjectRef, IdentitySnapshot> },
}
pub(super) struct RuleProjection {
    data: RuleData, cuts: Vec<Timestamp>,
    impact: Option<world_protocol::authorization::ActualImpact>, fingerprint: Digest,
}
impl RuleProjection {
    pub(super) fn captures(captures: Vec<crate::sources::sync::BranchCapture>, derivations: Vec<crate::facts::assertions::BranchDerivationRecord>, identities: BTreeMap<SubjectRef, IdentitySnapshot>, cuts: Vec<Timestamp>, impact: world_protocol::authorization::ActualImpact, fingerprint: Digest) -> Self {
        Self { data: RuleData::Captures { captures, derivations, identities }, cuts, impact: Some(impact), fingerprint }
    }
    pub(super) fn cuts(&self) -> &[Timestamp] { &self.cuts }
    pub(super) fn impact(&self) -> Option<&world_protocol::authorization::ActualImpact> { self.impact.as_ref() }
    pub(super) fn fingerprint(&self) -> &Digest { &self.fingerprint }
    pub(super) fn branch_inputs(&self) -> Result<Vec<(AssertionRef, Digest)>, QueryError> {
        match &self.data {
            RuleData::Facts { .. } => Ok(Vec::new()),
            RuleData::Captures { derivations, .. } => derivations.iter().map(|record| Ok((record.assertion.reference.clone(), record.durable_digest()?))).collect(),
        }
    }
    pub(super) fn materialize(&self, plan: &CheckedPlan, release: &Release, interval: &ValidTime, now: &Timestamp,
        budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken,
    ) -> Result<Projection, QueryError> {
        let (subjects, support) = match &self.data {
            RuleData::Facts { subjects, support } => (subjects, support),
            RuleData::Captures { captures, derivations, identities } => {
                let mut result = super::branch::project(release, plan, captures, &interval.from, budget, cancel)?;
                super::branch::merge_derivations(&mut result, release, plan, derivations, identities, interval, now, budget, cancel)?;
                for subject in result.subjects.values_mut() {
                    if let Some(relation) = &mut subject.relation { relation.valid_time = interval.clone(); }
                }
                return Ok(result);
            }
        };
        let mut result = Projection { subjects: BTreeMap::new(), dependencies: Vec::new(), labels: Vec::new(), sources: BTreeSet::new(), incomplete: false };
        for (subject, stored) in subjects {
            if !plan.datasets.contains(&stored.dataset) { continue; }
            checkpoint(budget, cancel)?;
            let definition = release.definitions.iter().find(|item| item.reference == stored.dataset).ok_or(QueryFailure::BasisChanged)?;
            let mut active = Vec::new(); let mut dirty = Vec::new();
            for assertion in &stored.facts {
                checkpoint(budget, cancel)?;
                if assertion.status != AssertionStatus::Accepted || !crate::definitions::valid_time_contains(&assertion.valid_time, interval) { continue; }
                if matches!(assertion.origin, AssertionOrigin::Derived {}) {
                    match support.as_ref().ok_or(QueryFailure::BasisChanged)?.resolve(&assertion.reference, interval)? {
                        ConclusionSupport::Supported { .. } => {},
                        ConclusionSupport::Dirty { generation, .. } => { dirty.push((assertion.clone(), generation)); continue; },
                        ConclusionSupport::Unsupported => continue,
                    }
                }
                result.dependencies.push(ReadDependency::Assertion { reference: assertion.reference.clone() });
                result.dependencies.extend(assertion.evidence.iter().cloned().map(|reference| ReadDependency::Evidence { reference }));
                active.push(assertion.clone());
            }
            result.dependencies.push(ReadDependency::Identity { subject: subject.clone(), revision: stored.identity.revision });
            let (projected, incomplete) = project_subject(stored.identity.clone(), subject, definition, &plan.fields, release, &active, &dirty, interval, now, true, false)?;
            result.incomplete |= incomplete;
            result.subjects.insert(subject.clone(), projected);
        }
        Ok(result)
    }
}
pub(super) async fn read_rule(
    tx: &WorldTransaction<'_>, authority: ReadAuthority<'_>, datasets: &[DefinitionRef], fields: &BTreeSet<DefinitionRef>, release: &Release,
    scope: &ScopeId, interval: &ValidTime, maximum: u64, budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken,
) -> Result<RuleProjection, QueryError> {
    if release.source_branch.is_some() {
        return super::branch::read_rule(tx, authority, datasets, fields, release, scope, interval, maximum, budget, cancel).await;
    }
    let now = tx.now().await?;
    let reader = Reader::Verified(tx, authority.verified());
    let mut subjects = BTreeMap::new(); let mut roots = Vec::new(); let mut impacts = Vec::new();
    for dataset in datasets {
        checkpoint(budget, cancel)?;
        let dataset_impact = authorization::actual_impact(vec![AccessScope { resources: vec![ResourceRef::Definition { id: dataset.id.clone() }], fields: fields.iter().cloned().collect(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(interval.clone()) }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
        authority.check(tx, &dataset_impact, &now).await?; impacts.push(dataset_impact);
        let definition = release.definitions.iter().find(|item| item.reference == *dataset).ok_or(QueryFailure::BasisChanged)?;
        crate::definitions::validate_applicability(definition, scope, interval, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
        let kind = match &definition.body { DefinitionBody::ObjectType(_) => "object", DefinitionBody::RelationType(_) => "relation", _ => return Err(invalid("query.dataset")) };
        let mut after = String::new();
        loop {
            checkpoint(budget, cancel)?;
            let rows = reader.query("SELECT object_id AS id,revision FROM world_object_identity WHERE tenant_id=$1 AND world_id=$2 AND type_id=$3 AND object_id>$4 AND $5='object' UNION ALL SELECT relation_id AS id,revision FROM world_relation_identity WHERE tenant_id=$1 AND world_id=$2 AND type_id=$3 AND relation_id>$4 AND $5='relation' ORDER BY id LIMIT 256", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &dataset.id.as_str(), &after, &kind]).await?;
            if rows.is_empty() { break; }
            for row in rows {
                checkpoint(budget, cancel)?; after = row.get("id");
                let (subject, record) = if kind == "object" {
                    let id = ObjectId::try_new(after.clone()).map_err(|_| QueryFailure::InternalFault)?;
                    (SubjectRef::Object { id: id.clone() }, IdentityRecord::Object(Object { world: tx.world().clone(), id, type_id: dataset.id.clone() }))
                } else {
                    let id = RelationId::try_new(after.clone()).map_err(|_| QueryFailure::InternalFault)?;
                    (SubjectRef::Relation { id: id.clone() }, IdentityRecord::Relation(Relation { world: tx.world().clone(), id, type_id: dataset.id.clone() }))
                };
                let impact = authorization::actual_impact(vec![AccessScope { resources: vec![resource(&subject)], fields: fields.iter().cloned().collect(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(interval.clone()) }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
                authority.check(tx, &impact, &now).await?; impacts.push(impact);
                let (facts, reads) = read_facts(reader, authority, &subject, None, scope, interval, &now, budget, cancel).await?; impacts.extend(reads);
                let mut retained = Vec::new();
                for assertion in facts {
                    checkpoint(budget, cancel)?;
                    if matches!(&assertion.claim, Claim::Attribute(claim) if !fields.contains(&claim.property)) { continue; }
                    if assertion.recorded_at > now || assertion.valid_time.to.as_ref().is_some_and(|to| to <= &interval.from)
                        || interval.to.as_ref().is_some_and(|to| to <= &assertion.valid_time.from)
                        || !crate::definitions::scope_contains(tx.world(), &assertion.scope, scope, &release.scopes).map_err(|_| invalid("query.scope"))? { continue; }
                    let covered = ValidTime::try_new(assertion.valid_time.from.clone().max(interval.from.clone()), match (&assertion.valid_time.to, &interval.to) { (Some(a), Some(b)) => Some(a.min(b).clone()), (a, b) => a.as_ref().or(b.as_ref()).cloned() }).map_err(|_| invalid("validTime"))?;
                    let evidence = if assertion.status == AssertionStatus::Accepted { reader.evidence(authority, &assertion.evidence, scope, &covered, &now).await? } else { Vec::new() };
                    let mut labels: Vec<_> = evidence.into_iter().flat_map(|item| item.access.labels).collect();
                    let properties = match &assertion.claim { Claim::Attribute(claim) => vec![claim.property.clone()], Claim::Relation(_) => Vec::new() };
                    for property in &properties {
                        let definition = release.definitions.iter().find(|item| item.reference == *property).ok_or(QueryFailure::BasisChanged)?;
                        if let DefinitionBody::Property(body) = &definition.body { labels.extend(body.access_labels.clone()); }
                    }
                    let sources = match &assertion.origin { AssertionOrigin::Source { binding, .. } => release.definitions.iter().find(|item| item.reference == *binding).and_then(|item| match &item.body { DefinitionBody::SourceBinding(body) => Some(body.source_id.clone()), _ => None }).into_iter().collect(), _ => Vec::new() };
                    let impact = authorization::actual_impact(vec![AccessScope { resources: vec![resource(&subject)], fields: properties, modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(covered) }], vec![Effect::Pure], labels, Vec::new(), sources)?;
                    authority.check(tx, &impact, &now).await?; impacts.push(impact);
                    if roots.len() == world_protocol::api::MAX_QUERY_NODES { return Err(world_protocol::provenance::ProvenanceFailure::LimitExceeded { resource: world_protocol::provenance::ProvenanceLimit::ComponentNodes, limit: world_protocol::api::MAX_QUERY_NODES as u64 }.into()); }
                    roots.push(assertion.reference.clone()); retained.push(assertion);
                }
                subjects.insert(subject, RuleSubject { identity: IdentitySnapshot { record, revision: Revision(row.get::<_, i64>("revision") as u64) }, dataset: dataset.clone(), facts: retained });
                if subjects.len() as u64 > maximum { return Err(QueryFailure::BudgetExceeded { limit: world_protocol::query::TruncationReason::Objects }.into()); }
            }
        }
    }
    roots.sort(); roots.dedup();
    let support = if roots.is_empty() { None } else { Some(crate::facts::support::interval_basis(tx, authority.verified(), &roots, scope, &release.id, budget, cancel, interval).await?) };
    let mut cuts = BTreeSet::from([interval.from.clone()]);
    cuts.extend(interval.to.iter().cloned());
    if let Some(support) = &support { cuts.extend(support.cuts().iter().cloned()); impacts.push(support.impact().clone()); }
    let mut access = Vec::new(); let mut effects = Vec::new(); let mut labels = Vec::new(); let mut state = Vec::new(); let mut sources = Vec::new();
    for impact in impacts { access.extend(impact.access); effects.extend(impact.effects); labels.extend(impact.labels); state.extend(impact.state); sources.extend(impact.source_ids); }
    let impact = if access.is_empty() { None } else {
        let impact = authorization::actual_impact(access, effects, labels, state, sources)?;
        authority.check(tx, &impact, &now).await?;
        Some(impact)
    };
    let observed = subjects.iter().map(|(subject, stored)| (subject, &stored.identity, &stored.dataset, &stored.facts)).collect::<Vec<_>>();
    let fingerprint = crate::definitions::canonical_digest(&(observed, support.as_ref().map(|support| support.fingerprint()), &impact, &cuts))?;
    Ok(RuleProjection { data: RuleData::Facts { subjects, support }, cuts: cuts.into_iter().collect(), impact, fingerprint })
}
fn checkpoint(budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken) -> Result<(), QueryError> {
    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
    budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)
}
async fn read_inner(
    reader: Reader<'_, '_>, plan: &CheckedPlan, release: &Release, scope: &ScopeId,
    interval: &ValidTime, known_at: Option<&Timestamp>, authority: ReadAuthority<'_>, maximum: u64,
    budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken, now: &Timestamp, algorithm: bool,
) -> Result<(Projection, Vec<Assertion>, Option<world_protocol::authorization::ActualImpact>, Digest), QueryError> {
    let mut result = Projection { subjects: BTreeMap::new(), dependencies: Vec::new(), labels: Vec::new(), sources: BTreeSet::new(), incomplete: false };
    let mut admitted = Vec::new();
    let mut impacts = Vec::new(); let mut support_bases = Vec::new();
    for dataset in &plan.datasets {
        let dataset_impact = authorization::actual_impact(vec![AccessScope { resources: vec![ResourceRef::Definition { id: dataset.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: None }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
        if matches!(reader, Reader::Verified(..)) { reader.check(authority, &dataset_impact, now).await?; }
        impacts.push(dataset_impact);
        let definition = release.definitions.iter().find(|definition| definition.reference == *dataset).ok_or_else(|| invalid("query.dataset"))?;
        crate::definitions::validate_applicability(definition, scope, interval, &release.scopes).map_err(crate::definitions::DefinitionError::from)?;
        let kind = match definition.body { DefinitionBody::ObjectType(_) => "object", DefinitionBody::RelationType(_) => "relation", _ => return Err(invalid("query.dataset")) };
        let mut after = String::new();
        loop {
            if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
            let rows = reader.query(
                "SELECT object_id AS id,revision FROM world_object_identity WHERE tenant_id=$1 AND world_id=$2 AND type_id=$3 AND object_id>$4 AND $5='object' UNION ALL SELECT relation_id AS id,revision FROM world_relation_identity WHERE tenant_id=$1 AND world_id=$2 AND type_id=$3 AND relation_id>$4 AND $5='relation' ORDER BY id LIMIT 256",
                &[&reader.world().tenant_id.as_str(), &reader.world().world_id.as_str(), &dataset.id.as_str(), &after, &kind],
            ).await?;
            if rows.is_empty() { break; }
            for row in rows {
                if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
                budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
                after = row.get("id");
                let (subject, record) = if kind == "object" {
                    let id = ObjectId::try_new(after.clone()).map_err(|_| QueryFailure::InternalFault)?;
                    (SubjectRef::Object { id: id.clone() }, IdentityRecord::Object(Object { world: reader.world().clone(), id, type_id: dataset.id.clone() }))
                } else {
                    let id = RelationId::try_new(after.clone()).map_err(|_| QueryFailure::InternalFault)?;
                    (SubjectRef::Relation { id: id.clone() }, IdentityRecord::Relation(Relation { world: reader.world().clone(), id, type_id: dataset.id.clone() }))
                };
                let impact = authorization::actual_impact(vec![AccessScope { resources: vec![resource(&subject)], fields: plan.fields.iter().cloned().collect(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(interval.clone()) }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
                reader.check(authority, &impact, now).await?;
                impacts.push(impact);
                let mut identity = IdentitySnapshot { record, revision: Revision(row.get::<_, i64>("revision") as u64) };
                if let Some(known) = known_at {
                    let Some(row) = reader.query_opt("SELECT body FROM world_identity_revision WHERE tenant_id=$1 AND world_id=$2 AND subject_kind=$3 AND subject_id=$4 AND recorded_at<=$5::text::timestamptz ORDER BY revision DESC LIMIT 1",
                        &[&reader.world().tenant_id.as_str(), &reader.world().world_id.as_str(), &kind, &after, &known.as_str()]).await? else { continue; };
                    identity = decode(row.get("body"))?;
                }
                let (facts, reads) = read_facts(reader, authority, &subject, known_at, scope, interval, now, budget, cancel).await?;
                impacts.extend(reads);
                let mut active = Vec::new();
                let mut dirty = Vec::new();
                for assertion in facts {
                    if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
                    budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
                    if matches!(&assertion.claim, Claim::Attribute(attribute) if !plan.fields.contains(&attribute.property)) { continue; }
                    if assertion.status != AssertionStatus::Accepted || assertion.recorded_at > *known_at.unwrap_or(now) { continue; }
                    if !crate::definitions::valid_time_contains(&assertion.valid_time, interval) {
                        if assertion.valid_time.to.as_ref().is_none_or(|to| to > &interval.from) && interval.to.as_ref().is_none_or(|to| to > &assertion.valid_time.from) { result.incomplete = true; }
                        continue;
                    }
                    if !crate::definitions::scope_contains(reader.world(), &assertion.scope, scope, &release.scopes).map_err(|_| invalid("query.scope"))? { continue; }
                    if matches!(reader, Reader::Verified(..)) {
                        let impact = authorization::actual_impact(vec![AccessScope { resources: vec![ResourceRef::Assertion { id: assertion.reference.id.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(assertion.valid_time.clone()) }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
                        reader.check(authority, &impact, now).await?;
                        impacts.push(impact);
                    }
                    let evidence = reader.evidence(authority, &assertion.evidence, scope, interval, now).await?;
                    if let Reader::Verified(tx, _) = reader {
                        let dependencies = assertion.evidence.iter().cloned().map(|reference| ReadDependency::Evidence { reference }).collect::<Vec<_>>();
                        if let Some(impact) = crate::facts::support::dependency_impact(tx, &dependencies, release, scope, interval).await? {
                            reader.check(authority, &impact, now).await?;
                            impacts.push(impact);
                        }
                    }
                    let mut labels: Vec<_> = evidence.into_iter().flat_map(|evidence| evidence.access.labels).collect();
                    result.dependencies.extend(assertion.evidence.iter().cloned().map(|reference| ReadDependency::Evidence { reference }));
                    let fields = match &assertion.claim {
                        Claim::Attribute(attribute) => {
                            let Some(definition) = release.definitions.iter().find(|definition| definition.reference == attribute.property) else { continue; };
                            let DefinitionBody::Property(property) = &definition.body else { continue; };
                            labels.extend(property.access_labels.clone());
                            vec![attribute.property.clone()]
                        }
                        Claim::Relation(_) => Vec::new(),
                    };
                    let sources = match &assertion.origin {
                        AssertionOrigin::Source { binding, .. } => release.definitions.iter().find(|definition| definition.reference == *binding).and_then(|definition| match &definition.body { DefinitionBody::SourceBinding(body) => Some(body.source_id.clone()), _ => None }).into_iter().collect(),
                        _ => Vec::new(),
                    };
                    let impact = authorization::actual_impact(vec![AccessScope { resources: vec![resource(&subject)], fields, modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(interval.clone()) }], vec![Effect::Pure], labels.clone(), Vec::new(), sources)?;
                    reader.check(authority, &impact, now).await?;
                    result.labels.extend(labels);
                    result.sources.extend(impact.source_ids.clone());
                    impacts.push(impact);
                    result.dependencies.push(ReadDependency::Assertion { reference: assertion.reference.clone() });
                    if matches!(assertion.origin, AssertionOrigin::Derived { .. }) {
                        let support = if let Reader::Verified(tx, verified) = reader {
                            let (support, dependencies, impact, basis) = crate::facts::support::resolve_verified_interval(tx, verified, &assertion.reference, scope, &release.id, budget, cancel, interval).await?;
                            // OR alternatives are observations, not new logical AND premises.
                            impacts.push(impact); support_bases.push(crate::definitions::canonical_digest(&(basis, dependencies))?);
                            support
                        } else { reader.support(&assertion.reference, scope, release, interval, budget, cancel).await? };
                        match support {
                            ConclusionSupport::Supported { .. } => {},
                            ConclusionSupport::Dirty { generation, .. } => { dirty.push((assertion.clone(), generation)); continue; },
                            ConclusionSupport::Unsupported => continue,
                        }
                    }
                    active.push(assertion);
                }
                result.dependencies.push(ReadDependency::Identity { subject: subject.clone(), revision: identity.revision });
                let (projected, incomplete) = project_subject(identity, &subject, definition, &plan.fields, release, &active, &dirty, interval, now, matches!(reader, Reader::Verified(..)), algorithm)?;
                result.incomplete |= incomplete;
                if algorithm { admitted.extend(active); }
                result.subjects.insert(subject, projected);
                if result.subjects.len() as u64 > maximum { return Err(QueryFailure::BudgetExceeded { limit: world_protocol::query::TruncationReason::Objects }.into()); }
            }
        }
    }
    result.labels.sort(); result.labels.dedup();
    let mut access = Vec::new(); let mut effects = Vec::new(); let mut labels = Vec::new(); let mut state = Vec::new(); let mut sources = Vec::new();
    for impact in impacts { access.extend(impact.access); effects.extend(impact.effects); labels.extend(impact.labels); state.extend(impact.state); sources.extend(impact.source_ids); }
    let impact = if access.is_empty() { None } else { Some(authorization::actual_impact(access, effects, labels, state, sources)?) };
    Ok((result, admitted, impact, crate::definitions::canonical_digest(&support_bases)?))
}

async fn read_facts(reader: Reader<'_, '_>, authority: ReadAuthority<'_>, subject: &SubjectRef, known_at: Option<&Timestamp>, scope: &ScopeId, interval: &ValidTime, now: &Timestamp,
    budget: &crate::extensions::invocation::CallBudget, cancel: &CancellationToken,
) -> Result<(Vec<Assertion>, Vec<world_protocol::authorization::ActualImpact>), QueryError> {
    checkpoint(budget, cancel)?;
    let (kind, id) = match subject { SubjectRef::Object { id } => ("object", id.as_str()), SubjectRef::Relation { id } => ("relation", id.as_str()) };
    if let Reader::Verified(tx, _) = reader {
        let heads = tx.query("SELECT h.assertion_id,h.revision FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND r.subject_kind=$3 AND r.subject_id=$4 ORDER BY h.assertion_id FOR SHARE OF h", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &kind, &id]).await?;
        let mut facts = Vec::new(); let mut impacts = Vec::new();
        for head in heads {
            checkpoint(budget, cancel)?;
            let assertion = AssertionId::try_new(head.get::<_, String>("assertion_id")).map_err(|_| QueryFailure::InternalFault)?;
            let impact = authorization::actual_impact(vec![AccessScope { resources: vec![ResourceRef::Assertion { id: assertion.clone() }], fields: Vec::new(), modes: vec![AccessMode::Read], scope: scope.clone(), valid_time: Some(interval.clone()) }], vec![Effect::Pure], Vec::new(), Vec::new(), Vec::new())?;
            reader.check(authority, &impact, now).await?;
            impacts.push(impact);
            if let Some(row) = tx.query_opt("SELECT body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND assertion_id=$3 AND revision=$4", &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str(), &assertion.as_str(), &head.get::<_, i64>("revision")]).await? { facts.push(decode(row.get("body"))?); }
        }
        return Ok((facts, impacts));
    }
    let rows = match known_at {
        None => reader.query("SELECT r.body FROM world_assertion_head h JOIN world_assertion_revision r USING(tenant_id,world_id,assertion_id,revision) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.subject_kind=$3 AND r.subject_id=$4 ORDER BY r.assertion_id", &[&reader.world().tenant_id.as_str(), &reader.world().world_id.as_str(), &kind, &id]).await?,
        Some(at) => reader.query("SELECT DISTINCT ON(assertion_id) body FROM world_assertion_revision WHERE tenant_id=$1 AND world_id=$2 AND subject_kind=$3 AND subject_id=$4 AND recorded_at<=$5::text::timestamptz ORDER BY assertion_id,revision DESC", &[&reader.world().tenant_id.as_str(), &reader.world().world_id.as_str(), &kind, &id, &at.as_str()]).await?,
    };
    Ok((rows.into_iter().map(|row| decode(row.get("body"))).collect::<Result<_, _>>()?, Vec::new()))
}

fn project_subject(
    identity: IdentitySnapshot, subject: &SubjectRef, definition: &world_protocol::definitions::Definition<DefinitionBody>,
    fields: &BTreeSet<DefinitionRef>, release: &Release, active: &[Assertion], dirty: &[(Assertion, Generation)],
    interval: &ValidTime, now: &Timestamp, verified: bool, algorithm: bool,
) -> Result<(ProjectedSubject, bool), QueryError> {
    let type_id = match &identity.record { IdentityRecord::Object(value) => &value.type_id, IdentityRecord::Relation(value) => &value.type_id };
    let mut projected_fields = BTreeMap::new();
    let mut incomplete = !dirty.is_empty();
    for property in fields {
        let definition = release.definitions.iter().find(|item| item.reference == *property).ok_or(QueryFailure::BasisChanged)?;
        let DefinitionBody::Property(body) = &definition.body else { return Err(QueryFailure::BasisChanged.into()); };
        if !body.domain.contains(type_id) { continue; }
        let pending = dirty.iter().filter_map(|(assertion, generation)| matches!(&assertion.claim, Claim::Attribute(claim) if &claim.subject == subject && &claim.property == property).then_some(*generation)).max();
        let field = if algorithm {
            FieldCell { property: property.clone(), cell: Cell::Unknown { reason: if pending.is_some() { UnknownReason::PendingRecomputation } else { UnknownReason::NotObserved } },
                evidence: active.iter().filter(|assertion| matches!(&assertion.claim, Claim::Attribute(claim) if &claim.subject == subject && &claim.property == property)).flat_map(|assertion| assertion.evidence.clone()).collect(),
                dirty: pending.map_or(DirtyState::Clean, |generation| DirtyState::Dirty { generation, invalidated_at: now.clone(), watches: Vec::new() }) }
        } else { field_cell(subject, property, body, active, pending, now) };
        projected_fields.insert(property.clone(), field);
    }
    let relation = if let (SubjectRef::Relation { id }, DefinitionBody::RelationType(body)) = (subject, &definition.body) {
        let claims = active.iter().filter(|assertion| matches!(&assertion.claim, Claim::Relation(claim) if &claim.relation_id == id)).collect::<Vec<_>>();
        let positive = claims.iter().filter(|assertion| assertion.polarity == Polarity::Positive).collect::<Vec<_>>();
        if positive.len() == 1 && !claims.iter().any(|assertion| assertion.polarity == Polarity::Negative && assertion.claim == positive[0].claim) {
            let Claim::Relation(claim) = &positive[0].claim else { return Err(QueryFailure::InternalFault.into()); };
            Some(relation(release, claim, Some(positive[0].reference.clone()), interval)?)
        } else if verified {
            incomplete = true;
            let cell = if claims.is_empty() { Cell::Unknown { reason: if dirty.is_empty() { UnknownReason::NotObserved } else { UnknownReason::PendingRecomputation } } }
                else { Cell::Conflicted { assertions: claims.iter().map(|assertion| assertion.reference.clone()).collect() } };
            Some(ProjectedRelation { claim: None, type_ref: definition.reference.clone(), roles: Vec::new(),
                cells: body.roles.iter().map(|role| (role.id.clone(), cell.clone())).collect(), valid_time: interval.clone() })
        } else { None }
    } else { None };
    Ok((ProjectedSubject { identity, fields: projected_fields, relation }, incomplete))
}

pub(super) fn field_cell(subject: &SubjectRef, property: &DefinitionRef, body: &world_protocol::definitions::Property, active: &[Assertion], pending: Option<Generation>, now: &Timestamp) -> FieldCell {
    let candidates: Vec<_> = active.iter().filter(|assertion| matches!(&assertion.claim, Claim::Attribute(attribute) if &attribute.subject == subject && &attribute.property == property)).collect();
    let mut values = Vec::new();
    for assertion in &candidates {
        let Claim::Attribute(attribute) = &assertion.claim else { continue; };
        if assertion.polarity == Polarity::Positive && !values.contains(&attribute.value) { values.push(attribute.value.clone()); }
    }
    let cell = reconcile_cell(body, values, &candidates, pending);

    FieldCell { property: property.clone(), cell, evidence: candidates.iter().flat_map(|assertion| assertion.evidence.clone()).collect(), dirty: pending.map_or(DirtyState::Clean, |generation| DirtyState::Dirty { generation, invalidated_at: now.clone(), watches: Vec::new() }) }
}

pub(super) fn reconcile_cell(body: &world_protocol::definitions::Property, values: Vec<Value>, candidates: &[&Assertion], pending: Option<Generation>) -> Cell {
    let conflict = body.cardinality.maximum.is_some_and(|maximum| values.len() > maximum as usize)
        || candidates.iter().any(|assertion| matches!(&assertion.claim, Claim::Attribute(attribute)
            if assertion.polarity == Polarity::Negative && values.contains(&attribute.value)));
    if conflict { Cell::Conflicted { assertions: candidates.iter().map(|assertion| assertion.reference.clone()).collect() } }
    else if body.cardinality.maximum != Some(1) && !values.is_empty() { Cell::Known { value: Value::List { items: values } } }
    else if let Some(value) = values.into_iter().next() { Cell::Known { value } }
    else { Cell::Unknown { reason: if pending.is_some() { UnknownReason::PendingRecomputation } else { UnknownReason::NotObserved } } }
}

pub(super) fn relation(release: &Release, claim: &world_protocol::facts::RelationClaim, reference: Option<AssertionRef>, valid_time: &ValidTime) -> Result<ProjectedRelation, QueryError> {
    let definition = release.definitions.iter().find(|definition| definition.reference == claim.relation_type).ok_or(QueryFailure::BasisChanged)?;
    let DefinitionBody::RelationType(body) = &definition.body else { return Err(QueryFailure::BasisChanged.into()); };
    let mut cells = BTreeMap::new();
    for role in &body.roles {
        let values: Vec<_> = claim.roles.iter().filter(|binding| binding.role == role.id).map(|binding| Value::Object { id: binding.object_id.clone() }).collect();
        if values.len() < role.cardinality.minimum as usize || role.cardinality.maximum.is_some_and(|maximum| values.len() > maximum as usize) { return Err(QueryFailure::BasisChanged.into()); }
        let value = if role.cardinality.maximum == Some(1) { values.into_iter().next().unwrap_or(Value::Null) } else { Value::List { items: values } };
        cells.insert(role.id.clone(), Cell::Known { value });
    }
    if claim.roles.iter().any(|binding| !cells.contains_key(&binding.role)) { return Err(QueryFailure::BasisChanged.into()); }
    Ok(ProjectedRelation { claim: reference, type_ref: claim.relation_type.clone(), roles: claim.roles.clone(), cells, valid_time: valid_time.clone() })
}

pub(super) fn resource(subject: &SubjectRef) -> ResourceRef {
    match subject { SubjectRef::Object { id } => ResourceRef::Object { id: id.clone() }, SubjectRef::Relation { id } => ResourceRef::Relation { id: id.clone() } }
}
pub(crate) fn point(at: &Timestamp) -> Result<ValidTime, QueryError> {
    let parsed = chrono::DateTime::parse_from_rfc3339(at.as_str()).map_err(|_| invalid("validAt"))?;
    let end = parsed.checked_add_signed(chrono::TimeDelta::nanoseconds(1)).ok_or_else(|| invalid("validAt"))?;
    let end = Timestamp::try_new(end.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)).map_err(|_| invalid("validAt"))?;
    ValidTime::try_new(at.clone(), Some(end)).map_err(|_| invalid("validAt"))
}
