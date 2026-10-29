use world_protocol::{
    api::ConfigureConnection,
    authorization::{AccessMode, AccessScope, ActualImpact},
    bindings::{Entrypoint, SlotKind},
    commit::CommittedRevision,
    failure::FailureStage,
    ids::*,
    package::{ArtifactRuntime, InstalledRecord},
    sources::{self, ConnectionRevision, SourceConnectionConfig, SourceFailure, SourcePlanReason},
};

use super::{
    SourceError,
    metadata::{decode, revision},
};
use crate::{
    authorization::{self, Admission},
    store::{OutboxEvent, WorldTransaction},
};

pub(crate) async fn configure_impact(
    tx: &WorldTransaction<'_>,
    request: &ConfigureConnection,
) -> Result<ActualImpact, SourceError> {
    let connection = &request.connection;
    if &connection.world != tx.world() {
        return Err(SourceError::invalid(
            "connection.world",
            SourcePlanReason::InvalidValue,
        ));
    }
    let mut access = vec![source_access(connection, AccessMode::Manage)];
    let mut sources = vec![connection.source_id.clone()];
    if let Some(previous) = current(tx, &connection.id).await? {
        access.push(source_access(&previous, AccessMode::Manage));
        sources.push(previous.source_id);
    }
    Ok(authorization::actual_impact(
        access,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        sources,
    )?)
}

pub(crate) async fn configure(
    tx: &mut WorldTransaction<'_>,
    admission: &Admission,
    request: &ConfigureConnection,
) -> Result<ConnectionRevision, SourceError> {
    tx.require_domain(&WriterDomain::try_new("sources").expect("fixed domain"))?;
    let impact = configure_impact(tx, request).await?;
    admission.require_access(&impact)?;
    authorization::recheck(tx, admission, &tx.now().await?).await?;
    super::configuration::validate(&request.connection.config)?;
    validate_name(&request.connection.name)?;
    let connection = &request.connection;
    let world = tx.world().clone();
    let scope = tx.query_opt("SELECT 1 FROM world_scope_revision WHERE tenant_id=$1 AND world_id=$2 AND scope_id=$3 LIMIT 1",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &connection.scope.as_str()]).await?;
    if scope.is_none() {
        return Err(SourceError::invalid(
            "connection.scope",
            SourcePlanReason::InvalidValue,
        ));
    }
    require_provider(tx, connection).await?;
    // Claim the head before inserting history. Concurrent creation cannot leave a detached revision.
    tx.execute("INSERT INTO world_source_connection_head(tenant_id,world_id,connection_id,revision) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &connection.id.as_str(), &revision(connection.revision)?]).await?;
    let row = tx.query_opt("SELECT revision FROM world_source_connection_head WHERE tenant_id=$1 AND world_id=$2 AND connection_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &connection.id.as_str()]).await?
        .ok_or_else(|| missing(&connection.id))?;
    let head = Revision(row.get::<_, i64>("revision") as u64);
    let previous = current(tx, &connection.id).await?;
    let valid = match (&previous, request.expected_revision) {
        (None, None) => connection.revision == Revision(1) && head == Revision(1),
        (Some(previous), Some(expected)) => {
            previous.revision == expected
                && head == expected
                && expected.0.checked_add(1) == Some(connection.revision.0)
                && connection.source_id == previous.source_id
        }
        _ => false,
    };
    if !valid {
        return Err(SourceError::new(
            SourceFailure::RevisionConflict {
                expected: request.expected_revision.unwrap_or(Revision(0)),
                actual: previous
                    .as_ref()
                    .map_or(Revision(0), |previous| previous.revision),
            },
            FailureStage::Commit,
        ));
    }
    let body = serde_json::to_value(connection).map_err(codec)?;
    let digest = world_protocol::schema::hash(&serde_json::to_vec(&body).map_err(codec)?).map_err(
        |cause| SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause),
    )?;
    tx.execute("INSERT INTO world_source_connection_revision(tenant_id,world_id,connection_id,revision,source_id,scope_id,provider_id,content_digest,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &connection.id.as_str(), &revision(connection.revision)?,
          &connection.source_id.as_str(), &connection.scope.as_str(), &connection.connector.as_str(), &digest.as_str(), &body]).await?;
    if previous.is_some() {
        tx.execute("UPDATE world_source_connection_head SET revision=$4 WHERE tenant_id=$1 AND world_id=$2 AND connection_id=$3",
            &[&world.tenant_id.as_str(), &world.world_id.as_str(), &connection.id.as_str(), &revision(connection.revision)?]).await?;
    }
    tx.record_revision(CommittedRevision {
        resource: ResourceRef::Source {
            id: connection.source_id.clone(),
        },
        revision: connection.revision,
    })?;
    let event_id = EventId::try_new(format!(
        "connection-{}",
        &world_protocol::schema::hash(
            &serde_json::to_vec(&(&world, &connection.id, connection.revision)).map_err(codec)?
        )
        .map_err(|cause| SourceError::caused_by(
            SourceFailure::InternalFault,
            FailureStage::Prepare,
            cause
        ))?
        .as_str()[7..]
    ))
    .expect("digest event identifier");
    tx.emit(OutboxEvent {
        event_id,
        aggregate_kind: "source_connection".into(),
        aggregate_id: connection.id.to_string(),
        aggregate_revision: connection.revision.0,
        event_kind: "world.connection.configured".into(),
        payload: serde_json::to_value((&connection.id, connection.revision)).map_err(codec)?,
        causation_id: None,
        origin: "world.sources".into(),
    })
    .await?;
    Ok(connection.clone())
}

pub(super) async fn current(
    tx: &WorldTransaction<'_>,
    id: &ConnectionId,
) -> Result<Option<ConnectionRevision>, SourceError> {
    let world = tx.world();
    tx.query_opt("SELECT r.body,r.revision,r.source_id,r.scope_id,r.provider_id FROM world_source_connection_head h JOIN world_source_connection_revision r USING(tenant_id,world_id,connection_id,revision) WHERE h.tenant_id=$1 AND h.world_id=$2 AND h.connection_id=$3",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &id.as_str()]).await?.map(|row| {
            let value: ConnectionRevision = decode(row.get("body"))?;
            if value.world != *world || value.id != *id || revision(value.revision)? != row.get::<_, i64>("revision")
                || value.source_id.as_str() != row.get::<_, String>("source_id") || value.scope.as_str() != row.get::<_, String>("scope_id")
                || value.connector.as_str() != row.get::<_, String>("provider_id") {
                return Err(SourceError::new(SourceFailure::ProtocolViolation, FailureStage::Read));
            }
            Ok(value)
        }).transpose()
}

pub(super) fn source_access(connection: &ConnectionRevision, mode: AccessMode) -> AccessScope {
    AccessScope {
        resources: vec![ResourceRef::Source {
            id: connection.source_id.clone(),
        }],
        fields: Vec::new(),
        modes: vec![mode],
        scope: connection.scope.clone(),
        valid_time: None,
    }
}

async fn require_provider(
    tx: &WorldTransaction<'_>,
    connection: &ConnectionRevision,
) -> Result<(), SourceError> {
    let registration = match &connection.config {
        SourceConnectionConfig::Postgres(_) => Some(sources::POSTGRES_REGISTRATION),
        SourceConnectionConfig::HttpJson(_) => Some(sources::HTTP_JSON_REGISTRATION),
        SourceConnectionConfig::Plugin(_) => None,
    };
    let contract = sources::read_contract().map_err(|cause| {
        SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
    })?;
    let rows = tx.query("SELECT body FROM world_package_install WHERE tenant_id=$1 AND world_id=$2 AND phase='installed' AND NOT pending_removal FOR SHARE",
        &[&tx.world().tenant_id.as_str(), &tx.world().world_id.as_str()]).await?;
    for row in rows {
        let record: InstalledRecord = decode(row.get("body"))?;
        if record.world != *tx.world() {
            return Err(SourceError::new(
                SourceFailure::ProtocolViolation,
                FailureStage::Prepare,
            ));
        }
        for provided in &record.manifest.provides {
            if provided.provider_id != connection.connector
                || provided.slot != SlotKind::Connector
                || !provided.contracts.contains(&contract)
            {
                continue;
            }
            if record.manifest.artifacts.iter().any(|artifact| {
                artifact.id == provided.artifact_id
                    && match (registration, artifact.runtime, &artifact.entrypoint) {
                        (
                            Some(expected),
                            ArtifactRuntime::Native,
                            Entrypoint::Builtin { registration, .. },
                        ) => registration == expected,
                        (None, ArtifactRuntime::WasmComponent, Entrypoint::Wasm { .. })
                        | (None, ArtifactRuntime::TrustedProcess, Entrypoint::Process { .. }) => {
                            true
                        }
                        _ => false,
                    }
            }) {
                return Ok(());
            }
        }
    }
    Err(SourceError::invalid(
        "connection.connector",
        SourcePlanReason::CapabilityNotDeclared,
    ))
}

fn validate_name(name: &str) -> Result<(), SourceError> {
    if name.trim().is_empty() || name.len() > 1024 || name.chars().any(char::is_control) {
        return Err(SourceError::invalid(
            "connection.name",
            SourcePlanReason::InvalidValue,
        ));
    }
    Ok(())
}
fn missing(id: &ConnectionId) -> SourceError {
    SourceError::new(
        SourceFailure::ConnectionMissing {
            connection_id: id.clone(),
        },
        FailureStage::Read,
    )
}
fn codec(cause: serde_json::Error) -> SourceError {
    SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Prepare, cause)
}
