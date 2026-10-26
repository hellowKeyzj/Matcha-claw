use super::{reader::Reader, *};
use crate::store::WorldTransaction;
use world_protocol::api::DiscoverSchema;

pub(in super::super) async fn read_discovery(
    store: &WorldStore,
    admission: &Admission,
    request: &DiscoverSchema,
    prepared: &SourceEndpoint,
) -> Result<ConnectionRevision, SourceError> {
    let request = request.clone();
    let admission = admission.clone();
    let implementations = prepared.implementations().to_vec();
    let provider = prepared.provider().clone();
    let driver = prepared.driver();
    store
        .snapshot(admission.invocation().world.clone(), move |snapshot| {
            Box::pin(async move {
                read(
                    &Reader::Snapshot(snapshot),
                    &admission,
                    &request,
                    &implementations,
                    &provider,
                    driver,
                )
                .await
            })
        })
        .await
}

pub(in super::super) async fn check_discovery(
    tx: &WorldTransaction<'_>,
    admission: &Admission,
    request: &DiscoverSchema,
    prepared: &SourceEndpoint,
    connection: &ConnectionRevision,
) -> Result<(), SourceError> {
    let current = read(
        &Reader::Transaction(tx),
        admission,
        request,
        prepared.implementations(),
        prepared.provider(),
        prepared.driver(),
    )
    .await?;
    if &current != connection {
        return Err(SourceError::new(
            SourceFailure::RevisionConflict {
                expected: connection.revision,
                actual: current.revision,
            },
            FailureStage::Validate,
        ));
    }
    Ok(())
}

async fn read(
    reader: &Reader<'_, '_>,
    admission: &Admission,
    request: &DiscoverSchema,
    implementations: &[ImplementationRef],
    provider: &ProviderId,
    driver: Driver,
) -> Result<ConnectionRevision, SourceError> {
    if reader.world() != &admission.invocation().world
        || request.target_schema.world != *reader.world()
        || request
            .expected_schema
            .as_ref()
            .is_some_and(|schema| schema.world != *reader.world())
        || request.connection_revision.0 == 0
        || request.target_schema.revision.0 == 0
        || request
            .expected_schema
            .as_ref()
            .map_or(0, |schema| schema.revision.0)
            .checked_add(1)
            != Some(request.target_schema.revision.0)
    {
        return Err(SourceError::invalid(
            "targetSchema",
            SourcePlanReason::InvalidValue,
        ));
    }
    let now = reader.now().await?;
    reader.recheck(admission, &now).await?;
    let world = reader.world();
    let row = reader.query_opt(
        "SELECT r.body,r.revision,r.source_id,r.scope_id,r.provider_id FROM world_source_connection_head h JOIN world_source_connection_revision r USING(tenant_id,world_id,connection_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.connection_id=$3",
        "SELECT r.body,r.revision,r.source_id,r.scope_id,r.provider_id FROM world_source_connection_head h JOIN world_source_connection_revision r USING(tenant_id,world_id,connection_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.connection_id=$3 FOR SHARE OF h",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &request.connection.as_str()],
    ).await?.ok_or_else(|| SourceError::new(SourceFailure::ConnectionMissing { connection_id: request.connection.clone() }, FailureStage::Read))?;
    let connection: ConnectionRevision = decode(row.get("body"))?;
    if connection.world != *world
        || connection.id != request.connection
        || revision(connection.revision)? != row.get::<_, i64>("revision")
        || connection.source_id.as_str() != row.get::<_, String>("source_id")
        || connection.scope.as_str() != row.get::<_, String>("scope_id")
        || connection.connector.as_str() != row.get::<_, String>("provider_id")
    {
        return Err(protocol());
    }
    if connection.revision != request.connection_revision {
        return Err(SourceError::new(
            SourceFailure::RevisionConflict {
                expected: request.connection_revision,
                actual: connection.revision,
            },
            FailureStage::Read,
        ));
    }
    let resource_exists = match (&connection.config, driver) {
        (SourceConnectionConfig::Postgres(config), Driver::Postgres) => config
            .resources
            .iter()
            .any(|resource| resource.id == request.resource),
        (SourceConnectionConfig::HttpJson(config), Driver::HttpJson) => config
            .resources
            .iter()
            .any(|resource| resource.id == request.resource),
        (SourceConnectionConfig::Plugin(config), Driver::Plugin) => config
            .resources
            .iter()
            .any(|resource| resource.id == request.resource),
        _ => return Err(protocol()),
    };
    if !resource_exists {
        return Err(SourceError::invalid(
            "resource",
            SourcePlanReason::UnknownResource,
        ));
    }
    if connection.connector != *provider {
        return Err(protocol());
    }
    let contract = world_protocol::sources::read_contract().map_err(|cause| {
        SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
    })?;
    if implementations.is_empty()
        || implementations
            .iter()
            .any(|implementation| !implementation.contracts.contains(&contract))
    {
        return Err(SourceError::invalid(
            "contracts",
            SourcePlanReason::CapabilityNotDeclared,
        ));
    }
    super::super::configuration::validate(&connection.config)?;
    let mut access = super::super::configure::source_access(&connection, AccessMode::Manage);
    if let Some(reference) = &request.branch {
        if &reference.world != reader.world() {
            return Err(protocol());
        }
        let branch = reader
            .current_branch(reference)
            .await?
            .ok_or_else(protocol)?;
        super::super::discovery::check_branch(&branch, request, &connection)?;
        let exact = reader.branch(reference).await?.ok_or_else(protocol)?;
        if branch != exact
            || !branch.compile.activation_lock.nodes.iter().any(|node| {
                node.provider_id == connection.connector
                    && implementations.contains(&node.implementation)
                    && node.slot == world_protocol::bindings::SlotKind::Connector
            })
        {
            return Err(protocol());
        }
        access.resources.push(ResourceRef::Branch {
            id: reference.id.clone(),
        });
    }
    let impact = authorization::actual_impact(
        vec![access],
        vec![Effect::SourceRead],
        Vec::new(),
        Vec::new(),
        vec![connection.source_id.clone()],
    )?;
    admission.require_access(&impact)?;
    let required = super::super::configuration::read_access(&connection)?;
    for implementation in implementations {
        reader.grants(implementation, &required).await?;
    }
    let head = reader.query_opt(
        "SELECT r.schema_id,r.revision,r.body FROM world_source_schema_head h JOIN world_source_schema_revision r USING(tenant_id,world_id,source_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.source_id=$3",
        "SELECT r.schema_id,r.revision,r.body FROM world_source_schema_head h JOIN world_source_schema_revision r USING(tenant_id,world_id,source_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.source_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &connection.source_id.as_str()],
    ).await?;
    let actual = head
        .map(|row| -> Result<SchemaRef, SourceError> {
            let schema: SchemaDiscovery = decode(row.get("body"))?;
            if schema.reference.world != *world
                || schema.source_id != connection.source_id
                || schema.reference.id.as_str() != row.get::<_, String>("schema_id")
                || revision(schema.reference.revision)? != row.get::<_, i64>("revision")
            {
                return Err(protocol());
            }
            Ok(schema.reference)
        })
        .transpose()?;
    if actual != request.expected_schema {
        return Err(SourceError::new(
            SourceFailure::Mapping {
                failure: world_protocol::sources::MappingFailure::RevisionMismatch,
            },
            FailureStage::Validate,
        ));
    }
    Ok(connection)
}
