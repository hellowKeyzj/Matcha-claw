mod http;
mod postgres;

use std::{collections::BTreeSet, sync::Arc};

use foundation::pipeline::PipelineContext;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::{DiscoverSchema, SourceSchemaQuery},
    authorization::{AccessMode, AccessScope, ActualImpact, AuthorizationFailure},
    expression::Effect,
    failure::FailureStage,
    ids::*,
    sources::*,
    time::Timestamp,
};

use super::{
    SourceBroker, SourceError, configure, metadata,
    prepared::{Driver, SourceEndpoint},
    values,
};
use crate::{
    authorization::{self, Admission},
    extensions::invocation::{self, CallBudget, InvocationLease},
    store::{WorldStore, WorldTransaction},
};

/// Only a completed source invocation can construct this witness; wire DTOs cannot.
pub(crate) struct DiscoveredSchema {
    schema: SchemaDiscovery,
    connection: ConnectionRevision,
    request: DiscoverSchema,
    prepared: SourceEndpoint,
    store: Arc<WorldStore>,
    lease: Arc<InvocationLease>,
    provider: NodeId,
}
impl DiscoveredSchema {
    pub(crate) fn schema(&self) -> &SchemaDiscovery {
        &self.schema
    }
    pub(crate) fn connection(&self) -> &ConnectionRevision {
        &self.connection
    }
    pub(crate) fn resource(&self) -> &str {
        &self.request.resource
    }
    pub(crate) async fn check_current(&self, admission: &Admission) -> Result<(), SourceError> {
        for provider in self.providers()? {
            invocation::check_current(&self.store, admission, &self.lease, &provider)
                .await
                .map_err(super::current_error)?;
        }
        Ok(())
    }
    fn providers(&self) -> Result<Vec<NodeId>, SourceError> {
        if self.prepared.driver() != Driver::Plugin {
            return Ok(vec![self.provider.clone()]);
        }
        let node = self.lease.graph().node(&self.provider).map_err(|failure| {
            SourceError::new(SourceFailure::Binding { failure }, FailureStage::Validate)
        })?;
        self.lease
            .graph()
            .composition_order(&node.binding_id)
            .map_err(|failure| {
                SourceError::new(SourceFailure::Binding { failure }, FailureStage::Validate)
            })
    }
    pub(crate) async fn recheck(
        &self,
        tx: &WorldTransaction<'_>,
        admission: &Admission,
    ) -> Result<(), SourceError> {
        for provider in self.providers()? {
            invocation::check_current_in_transaction(tx, admission, &self.lease, &provider)
                .await
                .map_err(super::current_error)?;
        }
        metadata::check_discovery(
            tx,
            admission,
            &self.request,
            &self.prepared,
            &self.connection,
        )
        .await
    }
}

pub(crate) async fn schema_head_impact(
    tx: &WorldTransaction<'_>,
    request: &SourceSchemaQuery,
) -> Result<ActualImpact, SourceError> {
    let world = tx.world();
    let rows = tx.query(
        "SELECT DISTINCT r.scope_id FROM world_source_connection_head h JOIN world_source_connection_revision r USING(tenant_id,world_id,connection_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND r.source_id=$3 ORDER BY r.scope_id LIMIT 4097",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &request.source_id.as_str()],
    ).await?;
    if rows.len() > 4096 {
        return Err(SourceError::new(
            SourceFailure::BudgetExceeded {
                dimension: world_protocol::budget::BudgetDimension::Steps,
            },
            FailureStage::Read,
        ));
    }
    if rows.is_empty() {
        return Err(authorization::AuthError::from(AuthorizationFailure::InsufficientScope).into());
    }
    let mut access = Vec::with_capacity(rows.len());
    for row in rows {
        let scope = ScopeId::try_new(row.get::<_, String>("scope_id")).map_err(|cause| {
            SourceError::caused_by(SourceFailure::ProtocolViolation, FailureStage::Read, cause)
        })?;
        access.push(AccessScope {
            resources: vec![ResourceRef::Source {
                id: request.source_id.clone(),
            }],
            fields: Vec::new(),
            modes: vec![AccessMode::Read],
            scope,
            valid_time: None,
        });
    }
    Ok(authorization::actual_impact(
        access,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        vec![request.source_id.clone()],
    )?)
}

pub(crate) async fn schema_head(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &SourceSchemaQuery,
) -> Result<Option<SchemaDiscovery>, SourceError> {
    let impact = schema_head_impact(tx, request).await?;
    admission.require_access(&impact)?;
    let world = tx.world();
    let row = tx.query_opt(
        "SELECT h.revision AS head_revision,r.schema_id,r.revision,r.schema_digest,r.body FROM world_source_schema_head h LEFT JOIN world_source_schema_revision r USING(tenant_id,world_id,source_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.source_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &request.source_id.as_str()],
    ).await?;
    let schema = match row {
        None => None,
        Some(row) => {
            let body = row.get::<_, Option<serde_json::Value>>("body").ok_or_else(|| {
                SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Read)
            })?;
            let schema: SchemaDiscovery = metadata::decode(body)?;
            let revision = metadata::revision(schema.reference.revision)?;
            let digest = crate::definitions::canonical_digest(&schema)
                .map_err(crate::sources::mapping::MappingError::from)?;
            if schema.reference.world != *world
                || schema.source_id != request.source_id
                || row.get::<_, i64>("head_revision") != revision
                || row.get::<_, Option<i64>>("revision") != Some(revision)
                || row.get::<_, Option<String>>("schema_id").as_deref()
                    != Some(schema.reference.id.as_str())
                || row.get::<_, Option<String>>("schema_digest").as_deref()
                    != Some(digest.as_str())
            {
                return Err(SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Read));
            }
            Some(schema)
        }
    };
    let delivered = schema.as_ref().map_or(1, |schema| {
        (schema.fields.len() + schema.keys.len() + 1) as u64
    });
    authorization::check_admitted_output(tx, admission, &impact, delivered, &tx.now().await?).await?;
    Ok(schema)
}

pub(crate) async fn impact(
    tx: &WorldTransaction<'_>,
    request: &DiscoverSchema,
) -> Result<ActualImpact, SourceError> {
    let connection = connection(tx, request).await?;
    let mut access = configure::source_access(&connection, AccessMode::Manage);
    if let Some(reference) = &request.branch {
        let branch = crate::sources::mapping::authoring_branch(tx, reference).await?;
        check_branch(&branch, request, &connection)?;
        access.resources.push(ResourceRef::Branch {
            id: reference.id.clone(),
        });
    }
    Ok(authorization::actual_impact(
        vec![access],
        vec![Effect::SourceRead],
        Vec::new(),
        Vec::new(),
        vec![connection.source_id],
    )?)
}
pub(crate) async fn connection(
    tx: &WorldTransaction<'_>,
    request: &DiscoverSchema,
) -> Result<ConnectionRevision, SourceError> {
    validate_request(tx.world(), request)?;
    let connection = configure::current(tx, &request.connection)
        .await?
        .ok_or_else(|| {
            SourceError::new(
                SourceFailure::ConnectionMissing {
                    connection_id: request.connection.clone(),
                },
                FailureStage::Read,
            )
        })?;
    if connection.revision != request.connection_revision {
        return Err(SourceError::new(
            SourceFailure::RevisionConflict {
                expected: request.connection_revision,
                actual: connection.revision,
            },
            FailureStage::Read,
        ));
    }
    require_resource(&connection, &request.resource)?;
    Ok(connection)
}

impl SourceBroker {
    pub(crate) async fn discover_schema(
        &self,
        request: DiscoverSchema,
        admission: &Admission,
        pipeline: &PipelineContext,
        cancel: CancellationToken,
        deadline: Instant,
        budget: CallBudget,
    ) -> Result<DiscoveredSchema, SourceError> {
        validate_request(&admission.invocation().world, &request)?;
        if cancel.is_cancelled() || pipeline.is_cancelled() {
            return Err(super::cancelled());
        }
        let prepared = self.prepared.clone();
        let limits = self
            .lease
            .limits(&self.provider)
            .ok_or_else(super::cancelled)?;
        let budget = if prepared.driver() == Driver::Plugin {
            budget
        } else {
            let now = Timestamp::try_new(chrono::Utc::now().to_rfc3339())
                .map_err(|_| values::invalid_response("observedAt"))?;
            let mut cap = limits.budget.clone();
            cap.max_wall_time = cap.max_wall_time.min(limits.call_timeout);
            let scoped = budget.scoped(&cap, &now).map_err(super::budget_error)?;
            scoped
                .charge(world_protocol::budget::BudgetDimension::SourceReads, 1)
                .map_err(super::budget_error)?;
            scoped
        };
        let deadline = deadline.min(budget.deadline());
        let maximum = usize::try_from(limits.maximum_frame_bytes)
            .unwrap_or(usize::MAX)
            .min(8 * 1024 * 1024);
        let broker = self.clone();
        let pipeline = pipeline.clone();
        let store = self.store.clone();
        let lease = self.lease.clone();
        let provider = self.provider.clone();
        let admission = admission.clone();
        let pipeline_cancel = pipeline.cancellation();
        self.cdc_task(cancel, deadline, move |work_cancel| Box::pin(async move {
            let work = async {
                invocation::check_current(&store, &admission, &lease, &provider).await.map_err(super::current_error)?;
                let connection = metadata::read_discovery(&store, &admission, &request, &prepared).await?;
                require_resource(&connection, &request.resource)?;
                if matches!(&connection.config, SourceConnectionConfig::HttpJson(config) if config.schema_path.is_none()) {
                    return Err(SourceError::new(SourceFailure::CapabilityMissing { capability: SourceCapability::SchemaDiscovery }, FailureStage::Prepare));
                }
                let observation = if prepared.driver() == Driver::Plugin {
                    require_plugin_method(&lease, &provider, &request.resource)?;
                    let response = broker.invoke_plugin(
                        world_protocol::slots::SlotRequest::ConnectorDiscover(SourceSchemaRequest { resource: request.resource.clone() }),
                        &admission, &pipeline, work_cancel.clone(), budget.clone(),
                    ).await?;
                    let world_protocol::slots::SlotResponse::ConnectorDiscover(observation) = response else {
                        return Err(values::invalid_response("slotResult"));
                    };
                    observation
                } else {
                    let native = prepared.native()?;
                    let access = broker.native_access()?;
                    let credential = access.credentials(&connection.world, &connection.id, connection.revision, work_cancel.clone(), deadline).await?;
                    match (&connection.config, native.driver) {
                        (SourceConnectionConfig::Postgres(config), Driver::Postgres) =>
                            postgres::discover(access, config, &request.resource, credential, work_cancel.clone(), deadline, &budget).await?,
                        (SourceConnectionConfig::HttpJson(config), Driver::HttpJson) =>
                            http::discover(config, &request.resource, credential, work_cancel.clone(), deadline, &budget, maximum).await?,
                        _ => return Err(SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Prepare)),
                    }
                };
                validate_observation(&observation, &budget)?;
                world_protocol::wire::encode(&observation, maximum)
                    .map_err(|_| SourceError::new(SourceFailure::ResponseLimit, FailureStage::Read))?;
                invocation::check_current(&store, &admission, &lease, &provider).await.map_err(super::current_error)?;
                let current = metadata::read_discovery(&store, &admission, &request, &prepared).await?;
                if current != connection { return Err(SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Read)); }
                let observed_at = Timestamp::try_new(chrono::Utc::now().to_rfc3339()).map_err(|_| values::invalid_response("observedAt"))?;
                let schema = SchemaDiscovery { reference: request.target_schema.clone(), source_id: connection.source_id.clone(),
                    incarnation: observation.incarnation, namespace: observation.namespace, fields: observation.fields,
                    keys: observation.keys, complete: observation.complete, observed_at };
                budget.check().map_err(super::budget_error)?;
                Ok(DiscoveredSchema { schema, connection, request, prepared, store, lease, provider })
            };
            tokio::pin!(work);
            tokio::select! {
                result = &mut work => result,
                _ = pipeline_cancel.cancelled() => { work_cancel.cancel(); Err(super::interrupted(work.await, super::cancelled())) },
            }
        })).await
    }
}

fn require_plugin_method(
    lease: &InvocationLease,
    provider: &NodeId,
    resource: &str,
) -> Result<(), SourceError> {
    let node = lease.graph().node(provider).map_err(|failure| {
        SourceError::new(SourceFailure::Binding { failure }, FailureStage::Prepare)
    })?;
    let expected = world_protocol::slots::request_port(
        &world_protocol::slots::SlotRequest::ConnectorDiscover(SourceSchemaRequest {
            resource: resource.into(),
        }),
    )
    .map_err(|cause| {
        SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
    })?;
    for id in lease
        .graph()
        .composition_order(&node.binding_id)
        .map_err(|failure| {
            SourceError::new(SourceFailure::Binding { failure }, FailureStage::Prepare)
        })?
    {
        let node = lease.graph().node(&id).map_err(|failure| {
            SourceError::new(SourceFailure::Binding { failure }, FailureStage::Prepare)
        })?;
        if !node.implementation.contracts.contains(&expected.contract)
            || !node.ports.iter().any(|port| {
                port.direction == world_protocol::bindings::PortDirection::Export
                    && port.name == expected.name
            })
        {
            return Err(SourceError::new(
                SourceFailure::CapabilityMissing {
                    capability: SourceCapability::SchemaDiscovery,
                },
                FailureStage::Prepare,
            ));
        }
        if !node
            .ports
            .iter()
            .filter(|port| {
                port.direction == world_protocol::bindings::PortDirection::Export
                    && port.name == expected.name
            })
            .eq(std::iter::once(&expected))
        {
            return Err(SourceError::new(
                SourceFailure::ProtocolViolation,
                FailureStage::Prepare,
            ));
        }
    }
    Ok(())
}

pub(in crate::sources::connectors) fn check_branch(
    branch: &world_protocol::releases::WorldBranch,
    request: &DiscoverSchema,
    connection: &ConnectionRevision,
) -> Result<(), SourceError> {
    let Some(reference) = &request.branch else {
        return Ok(());
    };
    if reference.world != connection.world
        || branch.world != reference.world
        || branch.id != reference.id
        || branch.revision != reference.revision
        || branch.status != world_protocol::learning::ChangeStatus::Proposed
    {
        return Err(SourceError::new(
            SourceFailure::Mapping {
                failure: MappingFailure::RevisionMismatch,
            },
            FailureStage::Validate,
        ));
    }
    for definition in &branch.compile.definitions {
        let world_protocol::definitions::DefinitionBody::SourceBinding(binding) = &definition.body
        else {
            continue;
        };
        if binding.connection_id == request.connection
            && binding.resource == request.resource
            && (binding.connection_revision != connection.revision
                || binding.source_id != connection.source_id
                || binding.schema != request.target_schema
                || definition.scope != connection.scope
                || binding.scope != connection.scope
                || binding.connector != connection.connector)
        {
            return Err(SourceError::new(
                SourceFailure::Mapping {
                    failure: MappingFailure::RevisionMismatch,
                },
                FailureStage::Validate,
            ));
        }
    }
    Ok(())
}

fn validate_request(world: &WorldRef, request: &DiscoverSchema) -> Result<(), SourceError> {
    if request.target_schema.world != *world
        || request
            .branch
            .as_ref()
            .is_some_and(|branch| branch.world != *world || branch.revision.0 == 0)
        || request
            .expected_schema
            .as_ref()
            .is_some_and(|reference| reference.world != *world)
        || request.connection_revision.0 == 0
        || request.resource.is_empty()
        || request.resource.len() > 256
        || request.target_schema.revision.0
            != request
                .expected_schema
                .as_ref()
                .map_or(0, |reference| reference.revision.0)
                .checked_add(1)
                .ok_or_else(|| {
                    SourceError::invalid("targetSchema.revision", SourcePlanReason::InvalidValue)
                })?
    {
        return Err(SourceError::invalid(
            "targetSchema",
            SourcePlanReason::InvalidValue,
        ));
    }
    Ok(())
}
fn require_resource(connection: &ConnectionRevision, resource: &str) -> Result<(), SourceError> {
    let exists = match &connection.config {
        SourceConnectionConfig::Postgres(config) => {
            config.resources.iter().any(|item| item.id == resource)
        }
        SourceConnectionConfig::HttpJson(config) => {
            config.resources.iter().any(|item| item.id == resource)
        }
        SourceConnectionConfig::Plugin(config) => {
            config.resources.iter().any(|item| item.id == resource)
        }
    };
    if !exists {
        return Err(SourceError::invalid(
            "resource",
            SourcePlanReason::UnknownResource,
        ));
    }
    Ok(())
}
fn validate_observation(
    observation: &SchemaObservation,
    budget: &CallBudget,
) -> Result<(), SourceError> {
    if observation.incarnation.is_empty()
        || observation.incarnation.len() > 4096
        || observation.incarnation.chars().any(char::is_control)
        || observation.namespace.is_empty()
        || observation.namespace.len() > 4096
        || observation.namespace.chars().any(char::is_control)
        || observation.fields.is_empty()
        || observation.fields.len() > 4096
        || observation.keys.len() > 4096
    {
        return Err(values::invalid_response("schema"));
    }
    let mut ids = BTreeSet::new();
    let mut names = BTreeSet::new();
    for field in &observation.fields {
        budget.check().map_err(super::budget_error)?;
        if !ids.insert(&field.id)
            || !names.insert(&field.name)
            || field.name.is_empty()
            || field.name.len() > 4096
            || field.name.chars().any(char::is_control)
        {
            return Err(values::invalid_response("fields"));
        }
        crate::definitions::validate_value_type(&field.value_type)
            .map_err(|_| values::invalid_response("fields.valueType"))?;
    }
    let mut keys = BTreeSet::new();
    for key in &observation.keys {
        if key.fields.is_empty()
            || key.fields.iter().collect::<BTreeSet<_>>().len() != key.fields.len()
            || key.fields.iter().any(|id| !ids.contains(id))
            || !keys.insert((&key.fields, key.basis as u8))
        {
            return Err(values::invalid_response("keys"));
        }
    }
    Ok(())
}
