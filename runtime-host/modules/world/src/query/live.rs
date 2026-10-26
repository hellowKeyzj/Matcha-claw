use std::collections::{BTreeMap, BTreeSet};
use foundation::pipeline::PipelineContext;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{definitions::{Definition, DefinitionBody}, identity::{AliasResolution, SourceKey, SubjectRef}, ids::*, provenance::ReadDependency,
    query::{FieldCell, QueryFailure}, releases::Release, sources::*, time::Timestamp, value::DirtyState};
use crate::{authorization::Admission, extensions::invocation::CallBudget, sources::{connectors::{ReadSourcePage, SourceBroker}, mapping}, store::WorldSnapshot};
use super::{QueryError, error::{decode, invalid}, plan::CheckedPlan, projection::{ProjectedSubject, Projection}};

pub(super) struct LiveRead { pub binding: Definition<SourceBinding>, pub mapping: SchemaMapping, pub schema: SchemaDiscovery, pub plan: SourceReadPlan }
pub(super) async fn plans(snapshot: &WorldSnapshot<'_>, plan: &CheckedPlan, release: &Release, known_at: Option<&Timestamp>, maximum: u64) -> Result<Vec<LiveRead>, QueryError> {
    let mut result = Vec::new();
    for definition in &release.definitions {
        let DefinitionBody::SourceBinding(binding) = &definition.body else { continue; };
        if !plan.datasets.iter().any(|dataset| dataset.id == binding.identity_mapping.type_id) { continue; }
        let mapping = mapping::read_mapping_snapshot(snapshot, &binding.mapping).await?.ok_or_else(|| invalid("query.mapping"))?;
        let schema = mapping::read_schema_snapshot(snapshot, &binding.schema).await?.ok_or_else(|| invalid("query.schema"))?;
        if mapping.reference != binding.mapping || mapping.identity_rule != binding.identity_rule || mapping.schema != binding.schema
            || schema.reference != binding.schema || schema.source_id != binding.source_id { return Err(QueryFailure::BasisChanged.into()); }
        let row = snapshot.query_opt("SELECT body FROM world_source_connection_revision WHERE tenant_id=$1 AND world_id=$2 AND connection_id=$3 AND revision=$4",
            &[&snapshot.world().tenant_id.as_str(), &snapshot.world().world_id.as_str(), &binding.connection_id.as_str(), &i64::try_from(binding.connection_revision.0).map_err(|_| QueryFailure::InternalFault)?]).await?.ok_or_else(|| invalid("query.connection"))?;
        let connection: ConnectionRevision = decode(row.get("body"))?;
        let fields: BTreeSet<_> = binding.selected_fields.iter().cloned().collect();
        let resources: Vec<_> = match &connection.config {
            SourceConnectionConfig::Postgres(config) => config.resources.iter().filter(|resource| fields.iter().all(|field| resource.fields.iter().any(|entry| &entry.id == field))).map(|resource| resource.id.clone()).collect(),
            SourceConnectionConfig::HttpJson(config) => config.resources.iter().filter(|resource| fields.iter().all(|field| resource.fields.iter().any(|entry| &entry.id == field))).map(|resource| resource.id.clone()).collect(),
            SourceConnectionConfig::Plugin(config) => config.resources.iter().filter(|resource| fields.iter().all(|field| resource.fields.iter().any(|entry| &entry.id == field))).map(|resource| resource.id.clone()).collect(),
        };
        if !resources.contains(&binding.resource) { return Err(invalid("query.sourceResource")); }
        let row_symbol = SymbolId::try_new("source_row").map_err(|_| QueryFailure::InternalFault)?;
        let binding_definition = Definition { reference: definition.reference.clone(), scope: definition.scope.clone(), valid_time: definition.valid_time.clone(), body: binding.clone(), content_digest: definition.content_digest.clone(), dependencies: definition.dependencies.clone(), evidence: definition.evidence.clone(), previous_ref: definition.previous_ref.clone(), lifecycle: definition.lifecycle.clone() };
        result.push(LiveRead { binding: binding_definition, mapping, schema, plan: SourceReadPlan { binding: definition.reference.clone(), row_symbol, resource: binding.resource.clone(), fields: fields.into_iter().map(|field| field.to_string()).collect(), predicate: None, order: Vec::new(), limit: maximum.min(world_protocol::api::MAX_PAGE_ITEMS as u64).max(1) as u32, continuation: None, as_of: known_at.cloned() } });
    }
    Ok(result)
}
pub(super) async fn needs_live(snapshot: &WorldSnapshot<'_>, source: &LiveRead, mode: &world_protocol::query::ReadMode, now: &Timestamp) -> Result<bool, QueryError> {
    if matches!(mode, world_protocol::query::ReadMode::Authoritative) { return Ok(true); }
    let frontiers = crate::sources::sync::frontier(snapshot, &source.binding.reference).await?;
    if frontiers.is_empty() { return Ok(true); }
    for frontier in frontiers {
        if frontier.checkpoint.source.gap.is_some() { return Ok(true); }
        if let world_protocol::query::ReadMode::Projected { max_lag } = mode {
            let lag = frontier.last_reconciled_at.as_ref().map(|at| (now.unix_nanos() - at.unix_nanos()).max(0) / 1_000_000);
            if lag.is_none_or(|lag| lag > max_lag.0 as i128) { return Ok(true); }
        }
    }
    Ok(false)
}

pub(crate) async fn source_plans(snapshot: &WorldSnapshot<'_>, request: &world_protocol::query::QueryRequest, release: &Release, maximum: u64) -> Result<Vec<SourceReadPlan>, QueryError> {
    if request.branch_id.is_some() || request.page.cursor.is_some() { return Ok(Vec::new()); }
    let checked = super::plan::check(&request.query, release)?;
    Ok(plans(snapshot, &checked, release, request.known_at.as_ref(), maximum).await?.into_iter().map(|source| source.plan).collect())
}

pub(crate) async fn source_connectors(snapshot: &WorldSnapshot<'_>, request: &world_protocol::query::QueryRequest, release: &Release, maximum: u64) -> Result<BTreeSet<ProviderId>, QueryError> {
    if request.branch_id.is_some() || request.page.cursor.is_some() { return Ok(BTreeSet::new()); }
    let checked = super::plan::check(&request.query, release)?;
    let sources = plans(snapshot, &checked, release, request.known_at.as_ref(), maximum).await?;
    Ok(sources.into_iter().map(|source| source.binding.body.connector).collect())
}

pub(super) async fn capture(broker: &SourceBroker, plan: &LiveRead, admission: &Admission, pipeline: &PipelineContext, cancel: &CancellationToken, deadline: Instant, budget: &CallBudget) -> Result<ReadSourcePage, QueryError> {
    let mut snapshot = broker.open_snapshot(plan.plan.clone(), admission, pipeline, cancel.clone(), deadline, budget.clone()).await?;
    let page = snapshot.collect_trusted(deadline).await?;
    let body = page.page();
    if !body.complete || body.continuation.is_some() || body.basis.gap.is_some() || body.basis.guarantee != SourceGuarantee::Authoritative {
        return Err(QueryFailure::GuaranteeUnsatisfied { mode: world_protocol::query::ReadMode::Authoritative, source_id: Some(plan.binding.body.source_id.clone()) }.into());
    }
    Ok(page)
}
pub(super) async fn overlay(snapshot: &WorldSnapshot<'_>, projection: &mut Projection, plan: &LiveRead, read: &ReadSourcePage, scope: &ScopeId, valid_at: &Timestamp, release: &Release, admission: &Admission, budget: &CallBudget, cancel: &CancellationToken, algorithm_fields: Option<&BTreeSet<DefinitionRef>>) -> Result<BTreeMap<SubjectRef, ProjectedSubject>, QueryError> {
    let source = &plan.binding.body;
    let basis = &read.page().basis;
    if basis.binding != plan.binding.reference || basis.mapping_revision != source.mapping.revision || basis.authority_revision != source.authority.revision || basis.schema != source.schema || basis.identity_rule != source.identity_rule { return Err(QueryFailure::BasisChanged.into()); }
    let mut captured = BTreeMap::new();
    for row in &read.page().rows {
        if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
        budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
        let key = SourceKey { world: snapshot.world().clone(), source_id: source.source_id.clone(), namespace: source.namespace.clone(), native_key: row.native_key.clone(), incarnation: row.incarnation.clone(), valid_time: super::projection::point(valid_at)? };
        let identity = crate::identity::resolve(snapshot, &key, scope).await?;
        projection.dependencies.extend(identity.dependencies);
        let identity = match identity.resolution {
            AliasResolution::Existing { identity, .. } => identity,
            AliasResolution::Ambiguous { .. } | AliasResolution::NotFound => return Err(QueryFailure::GuaranteeUnsatisfied { mode: world_protocol::query::ReadMode::Authoritative, source_id: Some(source.source_id.clone()) }.into()),
        };
        let subject = match &identity.record { world_protocol::identity::IdentityRecord::Object(object) => SubjectRef::Object { id: object.id.clone() }, world_protocol::identity::IdentityRecord::Relation(relation) => SubjectRef::Relation { id: relation.id.clone() } };
        let impact = crate::authorization::actual_impact(vec![world_protocol::authorization::AccessScope { resources: vec![super::projection::resource(&subject)], fields: plan.mapping.fields.iter().map(|field| field.property.clone()).collect(), modes: vec![world_protocol::authorization::AccessMode::Read], scope: scope.clone(), valid_time: Some(super::projection::point(valid_at)?) }], vec![world_protocol::expression::Effect::SourceRead], Vec::new(), Vec::new(), vec![source.source_id.clone()])?;
        admission.require_access(&impact)?;
        let mut actual = ProjectedSubject { identity: identity.clone(), fields: BTreeMap::new(), relation: None };
        for field in &plan.mapping.fields {
            let definition = release.definitions.iter().find(|entry| entry.reference == field.property).ok_or_else(|| invalid("query.mapping.property"))?;
            let DefinitionBody::Property(property) = &definition.body else { return Err(invalid("query.mapping.property")); };
            let property_definition = Definition { reference: definition.reference.clone(), scope: definition.scope.clone(), valid_time: definition.valid_time.clone(), body: property.clone(), content_digest: definition.content_digest.clone(), dependencies: definition.dependencies.clone(), evidence: definition.evidence.clone(), previous_ref: definition.previous_ref.clone(), lifecycle: definition.lifecycle.clone() };
            let cell = mapping::map_query_field(&plan.schema, field, &property_definition, row.fields.iter().find(|entry| entry.id == field.source_field))
                .map_err(crate::sources::mapping::MappingError::from)?;
            projection.labels.extend(property.access_labels.clone());
            let field = FieldCell { property: field.property.clone(), cell: cell.unwrap_or(world_protocol::value::Cell::Unknown { reason: world_protocol::value::UnknownReason::Unmapped }), evidence: Vec::new(), dirty: DirtyState::Clean };
            actual.fields.insert(field.property.clone(), field);
        }
        for mapped in &plan.mapping.relations {
            let SubjectRef::Relation { id } = &subject else { return Err(QueryFailure::BasisChanged.into()); };
            let definition = release.definitions.iter().find(|definition| definition.reference == mapped.relation_type).ok_or(QueryFailure::BasisChanged)?;
            let DefinitionBody::RelationType(body) = &definition.body else { return Err(QueryFailure::BasisChanged.into()); };
            let definition = Definition { reference: definition.reference.clone(), scope: definition.scope.clone(), valid_time: definition.valid_time.clone(), body: body.clone(), content_digest: definition.content_digest.clone(), dependencies: definition.dependencies.clone(), evidence: definition.evidence.clone(), previous_ref: definition.previous_ref.clone(), lifecycle: definition.lifecycle.clone() };
            let endpoints = mapping::map_query_roles(&plan.schema, mapped, &definition, row).map_err(crate::sources::mapping::MappingError::from)?;
            let mut roles = Vec::new();
            for endpoint in endpoints {
                budget.charge(world_protocol::budget::BudgetDimension::Steps, 1).map_err(super::execution::budget_error)?;
                if cancel.is_cancelled() { return Err(QueryFailure::Cancelled.into()); }
                let target = definition.body.roles.iter().find(|role| role.id == endpoint.role).ok_or(QueryFailure::BasisChanged)?;
                let bindings: Vec<_> = release.definitions.iter().filter_map(|definition| match &definition.body {
                    DefinitionBody::SourceBinding(binding) if binding.source_id == endpoint.target_source && binding.namespace == endpoint.target_namespace && binding.identity_mapping.type_id == target.target_type.id => Some(binding), _ => None,
                }).collect();
                if bindings.len() != 1 { return Err(QueryFailure::GuaranteeUnsatisfied { mode: world_protocol::query::ReadMode::Authoritative, source_id: Some(endpoint.target_source.clone()) }.into()); }
                let resolved = crate::identity::resolve_native_key_snapshot(snapshot, &endpoint.target_source, &endpoint.target_namespace, &endpoint.native_key, scope, &super::projection::point(valid_at)?).await?
                    .ok_or_else(|| QueryFailure::GuaranteeUnsatisfied { mode: world_protocol::query::ReadMode::Authoritative, source_id: Some(endpoint.target_source.clone()) })?;
                let target_source = resolved.key.source_id.clone(); projection.dependencies.extend(resolved.dependencies);
                let AliasResolution::Existing { identity, .. } = resolved.resolution else { return Err(QueryFailure::GuaranteeUnsatisfied { mode: world_protocol::query::ReadMode::Authoritative, source_id: Some(endpoint.target_source) }.into()); };
                let world_protocol::identity::IdentityRecord::Object(object) = identity.record else { return Err(QueryFailure::BasisChanged.into()); };
                if object.type_id != target.target_type.id { return Err(QueryFailure::BasisChanged.into()); }
                let impact = crate::authorization::actual_impact(vec![world_protocol::authorization::AccessScope { resources: vec![ResourceRef::Object { id: object.id.clone() }], fields: Vec::new(), modes: vec![world_protocol::authorization::AccessMode::Read], scope: scope.clone(), valid_time: Some(super::projection::point(valid_at)?) }], vec![world_protocol::expression::Effect::Pure], Vec::new(), Vec::new(), vec![target_source])?;
                admission.require_access(&impact)?;
                roles.push(world_protocol::facts::RoleBinding { role: endpoint.role, object_id: object.id });
            }
            let claim = world_protocol::facts::RelationClaim { relation_id: id.clone(), relation_type: mapped.relation_type.clone(), roles };
            actual.relation = Some(super::projection::relation(release, &claim, None, &super::projection::point(valid_at)?)?);
        }
        let projected = projection.subjects.entry(subject.clone()).or_insert_with(|| ProjectedSubject { identity: actual.identity.clone(), fields: BTreeMap::new(), relation: actual.relation.clone() });
        if let Some(fields) = algorithm_fields {
            for field in actual.fields.values().filter(|field| fields.contains(&field.property)) {
                projected.fields.entry(field.property.clone()).or_insert_with(|| FieldCell { property: field.property.clone(), cell: world_protocol::value::Cell::Unknown { reason: world_protocol::value::UnknownReason::NotObserved }, evidence: Vec::new(), dirty: DirtyState::Clean });
            }
        } else { projected.fields.extend(actual.fields.clone()); }
        if matches!(&actual.identity.record, world_protocol::identity::IdentityRecord::Relation(_)) { projected.relation = actual.relation.clone(); }
        if captured.insert(subject, actual).is_some() { return Err(QueryFailure::BasisChanged.into()); }
    }
    projection.sources.insert(source.source_id.clone());
    projection.dependencies.push(ReadDependency::SourceMapping { mapping: source.mapping.clone(), identity_rule: source.identity_rule.clone(), authority: source.authority.clone(), binding: plan.binding.reference.clone() });
    Ok(captured)
}
