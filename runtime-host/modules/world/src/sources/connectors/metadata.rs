mod discovery;
mod plugin;
mod reader;
pub(super) use plugin::{read_plan as plugin_read_plan, validate_page as validate_plugin_page};

use super::{
    PreparedSource, SourceError,
    prepared::{Driver, SourceEndpoint},
};
use crate::{
    authorization::{self, Admission},
    store::{WorldSnapshot, WorldStore},
};
pub(super) use discovery::{check_discovery, read_discovery};
use reader::Reader;
use serde::de::DeserializeOwned;
use std::collections::{BTreeMap, BTreeSet};
use world_protocol::{
    authorization::{AccessMode, AccessScope, ActualImpact},
    bindings::ImplementationRef,
    definitions::{Definition, DefinitionBody, DefinitionLifecycle, Scope},
    expression::{Effect, ExpressionIr},
    facts::SourceAuthority,
    failure::{FailureStage, FieldPath},
    ids::*,
    releases::{BranchRef, ReleaseFailure},
    sources::{
        ConnectionRevision, SchemaDiscovery, SchemaMapping, SourceBinding, SourceConnectionConfig,
        SourceFailure, SourcePage, SourcePlanReason, SourceReadPlan,
    },
    time::Timestamp,
};

type Model = Definition<DefinitionBody>;

#[derive(Clone)]
pub(super) struct ReadMetadata {
    pub binding: Definition<SourceBinding>,
    pub connection: ConnectionRevision,
    pub schema: SchemaDiscovery,
    pub impact: ActualImpact,
    plan: SourceReadPlan,
    implementation: ImplementationRef,
    implementations: Vec<ImplementationRef>,
    provider: ProviderId,
    driver: Driver,
    branch: Option<BranchRef>,
}

struct ReadModel {
    definitions: BTreeMap<DefinitionRef, Model>,
    scopes: Vec<Scope>,
}
impl ReadModel {
    fn new(definitions: Vec<Model>, scopes: Vec<Scope>) -> Self {
        Self {
            definitions: definitions
                .into_iter()
                .map(|definition| (definition.reference.clone(), definition))
                .collect(),
            scopes,
        }
    }
    fn exact(
        &self,
        reference: &DefinitionRef,
        valid_at: &Timestamp,
    ) -> Result<&Model, SourceError> {
        let definition = self.definitions.get(reference).ok_or_else(|| {
            definition_error(
                world_protocol::definitions::DefinitionFailure::MissingReference {
                    reference: reference.clone(),
                },
            )
        })?;
        if !definition.valid_time.contains(valid_at) {
            return Err(definition_error(
                world_protocol::definitions::DefinitionFailure::ValidTimeConflict {
                    definitions: vec![reference.clone()],
                },
            ));
        }
        if matches!(&definition.lifecycle, DefinitionLifecycle::Deprecated { effective_at, .. } | DefinitionLifecycle::Split { effective_at, .. } if effective_at <= valid_at)
        {
            return Err(definition_error(
                world_protocol::definitions::DefinitionFailure::DeprecatedReference {
                    reference: reference.clone(),
                },
            ));
        }
        Ok(definition)
    }
    fn current(&self, id: &DefinitionId) -> Option<&Model> {
        self.definitions
            .values()
            .find(|definition| definition.reference.id == *id)
    }
}

async fn active_model(reader: &Reader<'_, '_>) -> Result<ReadModel, SourceError> {
    let release = reader.active_model().await?.ok_or_else(|| {
        SourceError::new(
            SourceFailure::Mapping {
                failure: world_protocol::sources::MappingFailure::RevisionMismatch,
            },
            FailureStage::Read,
        )
    })?;
    Ok(ReadModel::new(release.definitions, release.scopes))
}

pub(super) async fn read(
    store: &WorldStore,
    admission: &Admission,
    plan: &SourceReadPlan,
    prepared: &SourceEndpoint,
) -> Result<ReadMetadata, SourceError> {
    read_selected(store, admission, plan, prepared, None).await
}

pub(super) async fn read_branch(
    store: &WorldStore,
    admission: &Admission,
    plan: &SourceReadPlan,
    prepared: &SourceEndpoint,
    branch: &BranchRef,
) -> Result<ReadMetadata, SourceError> {
    if branch.world != plan.binding.world {
        return Err(SourceError::invalid(
            "branch.world",
            SourcePlanReason::InvalidValue,
        ));
    }
    read_selected(store, admission, plan, prepared, Some(branch.clone())).await
}

async fn read_selected(
    store: &WorldStore,
    admission: &Admission,
    plan: &SourceReadPlan,
    prepared: &SourceEndpoint,
    branch: Option<BranchRef>,
) -> Result<ReadMetadata, SourceError> {
    if plan.binding.world != admission.invocation().world {
        return Err(SourceError::invalid(
            "binding",
            SourcePlanReason::InvalidValue,
        ));
    }
    if plan.limit == 0 || plan.limit > world_protocol::api::MAX_PAGE_ITEMS {
        return Err(SourceError::invalid(
            "limit",
            SourcePlanReason::UnsupportedLimit,
        ));
    }
    if plan.fields.is_empty()
        || plan.fields.iter().collect::<BTreeSet<_>>().len() != plan.fields.len()
    {
        return Err(SourceError::invalid("fields", SourcePlanReason::Empty));
    }
    let plan = plan.clone();
    let admission = admission.clone();
    let implementation = prepared.implementation().clone();
    let implementations = prepared.implementations().to_vec();
    let provider = prepared.provider().clone();
    let driver = prepared.driver();
    store
        .snapshot(plan.binding.world.clone(), move |snapshot| {
            Box::pin(async move {
                read_in(
                    &Reader::Snapshot(snapshot),
                    &admission,
                    &plan,
                    implementation,
                    implementations,
                    provider,
                    driver,
                    branch.as_ref(),
                )
                .await
            })
        })
        .await
}

async fn read_in(
    reader: &Reader<'_, '_>,
    admission: &Admission,
    plan: &SourceReadPlan,
    implementation: ImplementationRef,
    implementations: Vec<ImplementationRef>,
    provider: ProviderId,
    driver: Driver,
    branch: Option<&BranchRef>,
) -> Result<ReadMetadata, SourceError> {
    let now = reader.now().await?;
    let valid_at = plan.as_of.as_ref().unwrap_or(&now);
    reader.recheck(admission, &now).await?;
    let active = active_model(reader).await?;
    let isolated = match branch {
        Some(reference) => {
            let model = reader.branch(reference).await?.ok_or_else(|| {
                SourceError::new(
                    SourceFailure::Release {
                        failure: Box::new(ReleaseFailure::BranchMissing {
                            branch_id: reference.id.clone(),
                        }),
                    },
                    FailureStage::Read,
                )
            })?;
            Some(ReadModel::new(
                model.compile.definitions,
                model.compile.scopes,
            ))
        }
        None => None,
    };
    let model = isolated.as_ref().unwrap_or(&active);
    let canonical = model.exact(&plan.binding, valid_at)?;
    let DefinitionBody::SourceBinding(body) = &canonical.body else {
        return Err(SourceError::invalid(
            "binding",
            SourcePlanReason::InvalidValue,
        ));
    };
    if canonical.scope != body.scope {
        return Err(protocol());
    }
    if plan.resource != body.resource {
        return Err(SourceError::invalid(
            "resource",
            SourcePlanReason::UnknownResource,
        ));
    }
    let binding = Definition {
        reference: canonical.reference.clone(),
        scope: canonical.scope.clone(),
        valid_time: canonical.valid_time.clone(),
        body: body.clone(),
        content_digest: canonical.content_digest.clone(),
        dependencies: canonical.dependencies.clone(),
        evidence: canonical.evidence.clone(),
        previous_ref: canonical.previous_ref.clone(),
        lifecycle: canonical.lifecycle.clone(),
    };
    let world = reader.world();
    if branch.is_none() {
        let selected = reader.query_opt(
            "SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3",
            "SELECT revision FROM world_source_binding_head WHERE tenant_id=$1 AND world_id=$2 AND binding_id=$3 FOR SHARE",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.reference.id.as_str()],
        ).await?.ok_or_else(protocol)?;
        let actual = Revision(selected.get::<_, i64>("revision") as u64);
        if actual != binding.reference.revision {
            return Err(SourceError::new(
                SourceFailure::RevisionConflict {
                    expected: binding.reference.revision,
                    actual,
                },
                FailureStage::Read,
            ));
        }
    }
    let row = reader.query_opt(
        "SELECT r.body,h.revision AS current_revision FROM world_source_connection_revision r JOIN world_source_connection_head h USING(tenant_id,world_id,connection_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.connection_id=$3 AND r.revision=$4",
        "SELECT r.body,h.revision AS current_revision FROM world_source_connection_revision r JOIN world_source_connection_head h USING(tenant_id,world_id,connection_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.connection_id=$3 AND r.revision=$4 FOR SHARE OF h",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &binding.body.connection_id.as_str(), &revision(binding.body.connection_revision)?],
    ).await?.ok_or_else(|| SourceError::new(SourceFailure::ConnectionMissing { connection_id: binding.body.connection_id.clone() }, FailureStage::Read))?;
    let connection: ConnectionRevision = decode(row.get("body"))?;
    let actual = Revision(row.get::<_, i64>("current_revision") as u64);
    if actual != binding.body.connection_revision {
        return Err(SourceError::new(
            SourceFailure::RevisionConflict {
                expected: binding.body.connection_revision,
                actual,
            },
            FailureStage::Read,
        ));
    }
    if connection.world != *world
        || connection.id != binding.body.connection_id
        || connection.revision != binding.body.connection_revision
        || connection.source_id != binding.body.source_id
        || connection.connector != binding.body.connector
        || connection.connector != provider
    {
        return Err(protocol());
    }
    let contract = world_protocol::sources::read_contract().map_err(|cause| {
        SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
    })?;
    if !implementation.contracts.contains(&contract) {
        return Err(SourceError::invalid(
            "contracts",
            SourcePlanReason::CapabilityNotDeclared,
        ));
    }
    let (keys, declared) = match (&connection.config, driver) {
        (SourceConnectionConfig::Postgres(config), Driver::Postgres) => {
            let resource = config
                .resources
                .iter()
                .find(|resource| resource.id == plan.resource)
                .ok_or_else(|| {
                    SourceError::invalid("resource", SourcePlanReason::UnknownResource)
                })?;
            (
                resource.key.clone(),
                resource
                    .fields
                    .iter()
                    .map(|field| {
                        (
                            field.id.clone(),
                            field.value_type.clone(),
                            field.nullable,
                            field.optional,
                            field.readable,
                        )
                    })
                    .collect::<Vec<_>>(),
            )
        }
        (SourceConnectionConfig::HttpJson(config), Driver::HttpJson) => {
            let resource = config
                .resources
                .iter()
                .find(|resource| resource.id == plan.resource)
                .ok_or_else(|| {
                    SourceError::invalid("resource", SourcePlanReason::UnknownResource)
                })?;
            (
                resource.key.clone(),
                resource
                    .fields
                    .iter()
                    .map(|field| {
                        (
                            field.id.clone(),
                            field.value_type.clone(),
                            field.nullable,
                            field.optional,
                            field.readable,
                        )
                    })
                    .collect::<Vec<_>>(),
            )
        }
        (SourceConnectionConfig::Plugin(config), Driver::Plugin) => {
            let resource = config
                .resources
                .iter()
                .find(|resource| resource.id == plan.resource)
                .ok_or_else(|| {
                    SourceError::invalid("resource", SourcePlanReason::UnknownResource)
                })?;
            (
                resource.key.clone(),
                resource
                    .fields
                    .iter()
                    .map(|field| {
                        (
                            field.id.clone(),
                            field.value_type.clone(),
                            field.nullable,
                            field.optional,
                            field.readable,
                        )
                    })
                    .collect::<Vec<_>>(),
            )
        }
        _ => return Err(protocol()),
    };
    if keys.is_empty()
        || keys.iter().collect::<BTreeSet<_>>().len() != keys.len()
        || declared
            .iter()
            .map(|field| &field.0)
            .collect::<BTreeSet<_>>()
            .len()
            != declared.len()
    {
        return Err(SourceError::invalid(
            "resource",
            SourcePlanReason::InvalidKey,
        ));
    }
    let schema_ref = &binding.body.schema;
    if schema_ref.world != *world {
        return Err(protocol());
    }
    let row = reader.query_opt(
        "SELECT r.body,h.revision AS current_revision FROM world_source_schema_revision r JOIN world_source_schema_head h USING(tenant_id,world_id,source_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.schema_id=$3 AND r.revision=$4",
        "SELECT r.body,h.revision AS current_revision FROM world_source_schema_revision r JOIN world_source_schema_head h USING(tenant_id,world_id,source_id) WHERE r.tenant_id=$1 AND r.world_id=$2 AND r.schema_id=$3 AND r.revision=$4 FOR SHARE OF h",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &schema_ref.id.as_str(), &revision(schema_ref.revision)?],
    ).await?.ok_or_else(protocol)?;
    let actual = Revision(row.get::<_, i64>("current_revision") as u64);
    if actual != schema_ref.revision {
        return Err(SourceError::new(
            SourceFailure::RevisionConflict {
                expected: schema_ref.revision,
                actual,
            },
            FailureStage::Read,
        ));
    }
    let schema: SchemaDiscovery = decode(row.get("body"))?;
    if schema.reference != *schema_ref
        || schema.source_id != binding.body.source_id
        || schema.incarnation != binding.body.incarnation
        || schema.namespace != binding.body.namespace
    {
        return Err(protocol());
    }
    let authority = &binding.body.authority;
    let source_authority: SourceAuthority = reader
        .authority(branch, &binding.reference, authority)
        .await?
        .ok_or_else(|| {
            SourceError::new(
                SourceFailure::Mapping {
                    failure: world_protocol::sources::MappingFailure::AuthorityMismatch,
                },
                FailureStage::Admission,
            )
        })?;
    if source_authority.world != *world
        || source_authority.binding != binding.reference
        || source_authority.source_id != binding.body.source_id
        || source_authority.incarnation != binding.body.incarnation
        || source_authority.authority != *authority
        || source_authority.scope != binding.body.scope
        || !source_authority.valid_time.contains(&now)
    {
        return Err(SourceError::new(
            SourceFailure::PermissionDenied,
            FailureStage::Admission,
        ));
    }
    let mut fields = plan.fields.iter().cloned().collect::<BTreeSet<_>>();
    fields.extend(plan.order.iter().map(|order| order.field.clone()));
    fields.extend(keys.iter().map(ToString::to_string));
    let mut properties = BTreeSet::new();
    if let Some(predicate) = &plan.predicate {
        crate::definitions::validate_expression(predicate).map_err(|failure| {
            SourceError::new(
                SourceFailure::Compile {
                    failure: world_protocol::compiler::CompileFailure::Definition { failure },
                },
                FailureStage::Validate,
            )
        })?;
        expression_fields(predicate, &mut properties)?;
    }
    for property in &properties {
        let mapped = binding
            .body
            .field_mapping
            .iter()
            .find(|mapping| &mapping.property == property)
            .ok_or_else(|| SourceError::invalid("predicate", SourcePlanReason::UnknownField))?;
        fields.insert(mapped.source_field.clone());
    }
    for field in fields {
        let discovered = schema
            .fields
            .iter()
            .find(|discovered| discovered.id.as_str() == field)
            .ok_or_else(|| SourceError::invalid("fields", SourcePlanReason::UnknownField))?;
        let configured = declared
            .iter()
            .find(|field| field.0 == discovered.id)
            .ok_or_else(protocol)?;
        if !discovered.readable
            || !configured.4
            || !binding.body.selected_fields.contains(&discovered.id)
        {
            return Err(SourceError::invalid(
                "fields",
                SourcePlanReason::FieldNotReadable,
            ));
        }
        if configured.1 != discovered.value_type
            || configured.2 != discovered.nullable
            || configured.3 != discovered.optional
        {
            return Err(protocol());
        }
        for mapped in binding
            .body
            .field_mapping
            .iter()
            .filter(|mapping| mapping.source_field == discovered.id.as_str())
        {
            properties.insert(mapped.property.clone());
        }
    }
    let mut labels = Vec::new();
    let mut access = vec![AccessScope {
        resources: vec![ResourceRef::Source {
            id: binding.body.source_id.clone(),
        }],
        fields: Vec::new(),
        modes: vec![AccessMode::Read],
        scope: binding.scope.clone(),
        valid_time: None,
    }];
    if connection.scope != binding.scope {
        access.push(AccessScope {
            resources: vec![ResourceRef::Source {
                id: connection.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope: connection.scope.clone(),
            valid_time: None,
        });
    }
    for reference in &properties {
        let definition = model.exact(reference, valid_at)?;
        let DefinitionBody::Property(property) = &definition.body else {
            return Err(protocol());
        };
        labels.extend(property.access_labels.iter().cloned());
        access.push(AccessScope {
            resources: vec![ResourceRef::Source {
                id: binding.body.source_id.clone(),
            }],
            fields: vec![reference.clone()],
            modes: vec![AccessMode::Read],
            scope: definition.scope.clone(),
            valid_time: None,
        });
        if let Some(current) = active.current(&reference.id) {
            let DefinitionBody::Property(property) = &current.body else {
                return Err(protocol());
            };
            labels.extend(property.access_labels.iter().cloned());
            if current.scope != definition.scope {
                access.push(AccessScope {
                    resources: vec![ResourceRef::Source {
                        id: binding.body.source_id.clone(),
                    }],
                    fields: vec![reference.clone()],
                    modes: vec![AccessMode::Read],
                    scope: current.scope.clone(),
                    valid_time: None,
                });
            }
        }
    }
    if let Some(predicate) = &plan.predicate {
        let definitions =
            definition_closure(reader, model, canonical, &properties, valid_at).await?;
        let input = definitions
            .iter()
            .find(|definition| definition.reference.id == binding.body.identity_mapping.type_id)
            .ok_or_else(protocol)?;
        crate::compiler::check_source_predicate(
            predicate,
            canonical,
            &input.reference,
            &definitions,
            &model.scopes,
            &plan.row_symbol,
            &plan.resource,
        )
        .map_err(|failure| {
            SourceError::new(SourceFailure::Compile { failure }, FailureStage::Validate)
        })?;
    }
    let impact = authorization::actual_impact(
        access,
        vec![Effect::SourceRead],
        labels,
        Vec::new(),
        vec![binding.body.source_id.clone()],
    )?;
    admission.require_access(&impact)?;
    let required = super::configuration::read_access(&connection)?;
    for implementation in &implementations {
        reader.grants(implementation, &required).await?;
    }
    Ok(ReadMetadata {
        binding,
        connection,
        schema,
        impact,
        plan: plan.clone(),
        implementation,
        implementations,
        provider,
        driver,
        branch: branch.cloned(),
    })
}

pub(super) async fn check_output(
    store: &WorldStore,
    admission: &Admission,
    metadata: &ReadMetadata,
    page: &SourcePage,
) -> Result<(), SourceError> {
    let admission = admission.clone();
    let metadata = metadata.clone();
    let delivered = page
        .rows
        .iter()
        .map(|row| row.fields.len() as u64 + 1)
        .sum();
    store
        .snapshot(admission.invocation().world.clone(), move |snapshot| {
            Box::pin(async move {
                let reader = Reader::Snapshot(snapshot);
                let current = read_in(
                    &reader,
                    &admission,
                    &metadata.plan,
                    metadata.implementation.clone(),
                    metadata.implementations.clone(),
                    metadata.provider.clone(),
                    metadata.driver,
                    metadata.branch.as_ref(),
                )
                .await?;
                if current.binding != metadata.binding
                    || current.connection != metadata.connection
                    || current.schema != metadata.schema
                {
                    return Err(SourceError::new(
                        SourceFailure::Mapping {
                            failure: world_protocol::sources::MappingFailure::RevisionMismatch,
                        },
                        FailureStage::Validate,
                    ));
                }
                let now = snapshot.now().await?;
                reader
                    .output(&admission, &current.impact, delivered, &now)
                    .await?;
                Ok(())
            })
        })
        .await
}

pub(super) async fn recheck_output(
    tx: &crate::store::WorldTransaction<'_>,
    admission: &Admission,
    metadata: &ReadMetadata,
    page: &SourcePage,
    now: &Timestamp,
) -> Result<(), SourceError> {
    if tx.world() != &metadata.plan.binding.world || tx.world() != &admission.invocation().world {
        return Err(SourceError::invalid(
            "world",
            SourcePlanReason::InvalidValue,
        ));
    }
    let reader = Reader::Transaction(tx);
    let current = read_in(
        &reader,
        admission,
        &metadata.plan,
        metadata.implementation.clone(),
        metadata.implementations.clone(),
        metadata.provider.clone(),
        metadata.driver,
        metadata.branch.as_ref(),
    )
    .await?;
    if current.binding != metadata.binding
        || current.connection != metadata.connection
        || current.schema != metadata.schema
    {
        return Err(SourceError::new(
            SourceFailure::Mapping {
                failure: world_protocol::sources::MappingFailure::RevisionMismatch,
            },
            FailureStage::Validate,
        ));
    }
    let delivered = page
        .rows
        .iter()
        .map(|row| row.fields.len() as u64 + 1)
        .sum();
    reader
        .output(admission, &current.impact, delivered, now)
        .await
}

pub(super) async fn check_branch_output(
    store: &WorldStore,
    admission: &Admission,
    metadata: &ReadMetadata,
    page: &SourcePage,
    branch: &BranchRef,
) -> Result<(), SourceError> {
    if metadata.branch.as_ref() != Some(branch) {
        return Err(SourceError::invalid(
            "branch",
            SourcePlanReason::InvalidValue,
        ));
    }
    check_output(store, admission, metadata, page).await
}

pub(super) async fn definition(
    snapshot: &WorldSnapshot<'_>,
    reference: &DefinitionRef,
    valid_at: &Timestamp,
) -> Result<Model, SourceError> {
    if &reference.world != snapshot.world() {
        return Err(protocol());
    }
    Ok(active_model(&Reader::Snapshot(snapshot))
        .await?
        .exact(reference, valid_at)?
        .clone())
}
pub(super) async fn current_definition(
    snapshot: &WorldSnapshot<'_>,
    id: &DefinitionId,
) -> Result<Model, SourceError> {
    active_model(&Reader::Snapshot(snapshot))
        .await?
        .current(id)
        .cloned()
        .ok_or_else(protocol)
}
async fn definition_closure(
    reader: &Reader<'_, '_>,
    model: &ReadModel,
    binding: &Model,
    properties: &BTreeSet<DefinitionRef>,
    valid_at: &Timestamp,
) -> Result<Vec<Model>, SourceError> {
    let mut pending: Vec<_> = binding
        .dependencies
        .iter()
        .chain(properties)
        .cloned()
        .collect();
    let mut definitions = BTreeMap::from([(binding.reference.clone(), binding.clone())]);
    let world = reader.world();
    let DefinitionBody::SourceBinding(source) = &binding.body else {
        return Err(protocol());
    };
    let sql = "SELECT body FROM world_schema_mapping_revision WHERE tenant_id=$1 AND world_id=$2 AND mapping_id=$3 AND revision=$4";
    let mapping: SchemaMapping = decode(
        reader
            .query_opt(
                sql,
                sql,
                &[
                    &world.tenant_id.as_str(),
                    &world.world_id.as_str(),
                    &source.mapping.id.as_str(),
                    &revision(source.mapping.revision)?,
                ],
            )
            .await?
            .ok_or_else(protocol)?
            .get("body"),
    )?;
    if mapping.reference != source.mapping || mapping.type_ref.id != source.identity_mapping.type_id
    {
        return Err(protocol());
    }
    pending.push(mapping.type_ref);
    while let Some(reference) = pending.pop() {
        if definitions.contains_key(&reference) {
            continue;
        }
        if definitions.len() >= 65_536 {
            return Err(SourceError::invalid(
                "predicate",
                SourcePlanReason::UnsupportedPredicate,
            ));
        }
        let definition = model.exact(&reference, valid_at)?;
        pending.extend(definition.dependencies.iter().cloned());
        definitions.insert(reference, definition.clone());
    }
    Ok(definitions.into_values().collect())
}
fn expression_fields(
    expression: &ExpressionIr,
    fields: &mut BTreeSet<DefinitionRef>,
) -> Result<(), SourceError> {
    match expression {
        ExpressionIr::Literal { .. } => {}
        ExpressionIr::Field { property, .. } => {
            fields.insert(property.clone());
        }
        ExpressionIr::Unary { operand, .. }
        | ExpressionIr::IsNull { operand }
        | ExpressionIr::IsKnown { operand } => expression_fields(operand, fields)?,
        ExpressionIr::Binary { left, right, .. } => {
            expression_fields(left, fields)?;
            expression_fields(right, fields)?;
        }
        ExpressionIr::All { terms } | ExpressionIr::Any { terms } => {
            for term in terms {
                expression_fields(term, fields)?;
            }
        }
        _ => {
            return Err(SourceError::invalid(
                "predicate",
                SourcePlanReason::UnsupportedPredicate,
            ));
        }
    }
    Ok(())
}
pub(super) fn decode<T: DeserializeOwned>(value: serde_json::Value) -> Result<T, SourceError> {
    serde_json::from_value(value).map_err(|cause| {
        SourceError::caused_by(
            SourceFailure::ResponseInvalid {
                field: FieldPath(vec!["storedRecord".into()]),
            },
            FailureStage::Decode,
            cause,
        )
    })
}
pub(super) fn revision(value: Revision) -> Result<i64, SourceError> {
    i64::try_from(value.0)
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(protocol)
}
fn definition_error(failure: world_protocol::definitions::DefinitionFailure) -> SourceError {
    SourceError::new(
        SourceFailure::Compile {
            failure: world_protocol::compiler::CompileFailure::Definition { failure },
        },
        FailureStage::Validate,
    )
}
fn protocol() -> SourceError {
    SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Validate)
}
