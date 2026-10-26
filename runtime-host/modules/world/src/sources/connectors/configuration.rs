use super::SourceError;
use std::collections::BTreeSet;
use world_protocol::{
    failure::FailureStage,
    sources::{
        self, ChangeStreamCapability, SnapshotCapability, SourceCapabilities,
        SourceConnectionConfig, SourceFailure, SourcePlanReason,
    },
    value::ValueType,
};

pub(super) fn validate(config: &SourceConnectionConfig) -> Result<(), SourceError> {
    if !matches!(config, SourceConnectionConfig::Plugin(_)) {
        network_origin(config)?;
    }
    match config {
        SourceConnectionConfig::Postgres(config) => {
            if config.host.trim().is_empty()
                || config.host.len() > 253
                || config.host.chars().any(|c| {
                    c.is_control()
                        || c.is_whitespace()
                        || matches!(c, '/' | '\\' | '@' | '?' | '#' | '%')
                })
                || config.port == 0
            {
                return Err(invalid("config.host", SourcePlanReason::InvalidEndpoint));
            }
            identifier(&config.database)?;
            identifier(&config.schema)?;
            capabilities(&config.declared_capabilities)?;
            let caps = &config.declared_capabilities;
            if !matches!(
                caps.snapshot,
                SnapshotCapability::Transactional | SnapshotCapability::None
            ) || caps.historical_read
                || caps.idempotency_key
                || caps.aggregate_pushdown
            {
                return Err(invalid(
                    "config.declaredCapabilities",
                    SourcePlanReason::CapabilityNotDeclared,
                ));
            }
            if !matches!(
                caps.change_stream,
                ChangeStreamCapability::None | ChangeStreamCapability::ResumableTransactions
            ) || (caps.change_stream != ChangeStreamCapability::None && config.logical.is_none())
            {
                return Err(invalid(
                    "config.declaredCapabilities.changeStream",
                    SourcePlanReason::CapabilityNotDeclared,
                ));
            }
            if let Some(logical) = &config.logical {
                if logical.slot.is_empty()
                    || logical.slot.len() > 63
                    || !logical.slot.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
                {
                    return Err(invalid(
                        "config.logical.slot",
                        SourcePlanReason::InvalidIdentifier,
                    ));
                }
            }
            let mut resources = BTreeSet::new();
            for resource in &config.resources {
                if !resources.insert(&resource.id) || resource.id.is_empty() {
                    return Err(invalid(
                        "config.resources",
                        SourcePlanReason::UnknownResource,
                    ));
                }
                identifier(&resource.table)?;
                let mut fields = BTreeSet::new();
                let mut columns = BTreeSet::new();
                for field in &resource.fields {
                    if !fields.insert(&field.id) || !columns.insert(&field.column) {
                        return Err(invalid(
                            "config.resources.fields",
                            SourcePlanReason::UnknownField,
                        ));
                    }
                    identifier(&field.column)?;
                    value_type(&field.value_type)?;
                }
                if resource.key.is_empty()
                    || resource.key.iter().collect::<BTreeSet<_>>().len() != resource.key.len()
                    || resource.key.iter().any(|key| {
                        !resource.fields.iter().any(|field| {
                            &field.id == key && field.readable && !field.nullable && !field.optional
                        })
                    })
                {
                    return Err(invalid(
                        "config.resources.key",
                        SourcePlanReason::InvalidKey,
                    ));
                }
            }
        }
        SourceConnectionConfig::HttpJson(config) => {
            let origin = reqwest::Url::parse(&config.origin).map_err(|cause| {
                SourceError::caused_by(
                    SourceFailure::InvalidPlan {
                        field: world_protocol::failure::FieldPath(vec![
                            "config".into(),
                            "origin".into(),
                        ]),
                        reason: SourcePlanReason::InvalidEndpoint,
                    },
                    FailureStage::Validate,
                    cause,
                )
            })?;
            if !matches!(origin.scheme(), "http" | "https")
                || origin.host_str().is_none()
                || !origin.username().is_empty()
                || origin.password().is_some()
                || origin.query().is_some()
                || origin.fragment().is_some()
                || origin.path() != "/"
            {
                return Err(invalid("config.origin", SourcePlanReason::InvalidEndpoint));
            }
            for path in std::iter::once(&config.read_path)
                .chain(config.schema_path.iter())
                .chain(config.query_path.iter())
                .chain(config.write_path.iter())
                .chain(config.inspect_path.iter())
                .chain(config.changes.iter().flat_map(|changes| {
                    std::iter::once(&changes.read_path).chain(changes.ack_path.iter())
                }))
            {
                endpoint(&origin, path)?;
            }
            if let Some(path) = &config.schema_path {
                if origin.join(path).map_or(true, |target| {
                    target.query_pairs().any(|(name, _)| name == "resource")
                }) {
                    return Err(invalid(
                        "config.schemaPath",
                        SourcePlanReason::InvalidEndpoint,
                    ));
                }
            }
            capabilities(&config.declared_capabilities)?;
            let caps = &config.declared_capabilities;
            // This adapter has no snapshot-token or mutation protocol. Configuring a path does not create one.
            if !matches!(
                caps.snapshot,
                SnapshotCapability::WeakPagination | SnapshotCapability::None
            ) || caps.historical_read
                || caps.conditional_write
                || caps.idempotency_key
                || caps.inspect_effect
                || caps.aggregate_pushdown
                || ((caps.predicate_pushdown || caps.ordering_pushdown)
                    && config.query_path.is_none())
                || (caps.change_stream != ChangeStreamCapability::None && config.changes.is_none())
            {
                return Err(invalid(
                    "config.declaredCapabilities",
                    SourcePlanReason::CapabilityNotDeclared,
                ));
            }
            let mut resources = BTreeSet::new();
            for resource in &config.resources {
                if resource.id.is_empty() || !resources.insert(&resource.id) {
                    return Err(invalid(
                        "config.resources",
                        SourcePlanReason::UnknownResource,
                    ));
                }
                pointer(&resource.rows_pointer)?;
                if let Some(continuation) = &resource.continuation_pointer {
                    pointer(continuation)?;
                }
                let mut fields = BTreeSet::new();
                for field in &resource.fields {
                    if !fields.insert(&field.id) {
                        return Err(invalid(
                            "config.resources.fields",
                            SourcePlanReason::UnknownField,
                        ));
                    }
                    pointer(&field.pointer)?;
                    value_type(&field.value_type)?;
                }
                if resource.key.is_empty()
                    || resource.key.iter().collect::<BTreeSet<_>>().len() != resource.key.len()
                    || resource.key.iter().any(|key| {
                        !resource.fields.iter().any(|field| {
                            &field.id == key && field.readable && !field.nullable && !field.optional
                        })
                    })
                {
                    return Err(invalid(
                        "config.resources.key",
                        SourcePlanReason::InvalidKey,
                    ));
                }
            }
        }
        SourceConnectionConfig::Plugin(config) => {
            capabilities(&config.declared_capabilities)?;
            let mut resources = BTreeSet::new();
            for resource in &config.resources {
                if resource.id.is_empty()
                    || resource.id.len() > 1024
                    || resource.id.chars().any(char::is_control)
                    || !resources.insert(&resource.id)
                {
                    return Err(invalid(
                        "config.resources",
                        SourcePlanReason::UnknownResource,
                    ));
                }
                let mut fields = BTreeSet::new();
                for field in &resource.fields {
                    if !fields.insert(&field.id)
                        || field.name.is_empty()
                        || field.name.len() > 1024
                        || field.name.chars().any(char::is_control)
                    {
                        return Err(invalid(
                            "config.resources.fields",
                            SourcePlanReason::UnknownField,
                        ));
                    }
                    value_type(&field.value_type)?;
                }
                if resource.key.is_empty()
                    || resource.key.iter().collect::<BTreeSet<_>>().len() != resource.key.len()
                    || resource.key.iter().any(|key| {
                        !resource.fields.iter().any(|field| {
                            &field.id == key && field.readable && !field.nullable && !field.optional
                        })
                    })
                {
                    return Err(invalid(
                        "config.resources.key",
                        SourcePlanReason::InvalidKey,
                    ));
                }
            }
        }
    }
    Ok(())
}

pub(super) fn network_origin(config: &SourceConnectionConfig) -> Result<String, SourceError> {
    match config {
        SourceConnectionConfig::Postgres(config) => {
            let raw = config
                .host
                .strip_prefix('[')
                .and_then(|host| host.strip_suffix(']'))
                .unwrap_or(&config.host);
            let host = match raw.parse::<std::net::IpAddr>() {
                Ok(std::net::IpAddr::V6(ip)) => format!("[{ip}]"),
                Ok(std::net::IpAddr::V4(ip)) => ip.to_string(),
                Err(_) => {
                    match reqwest::Url::parse(&format!("http://{}:{}", config.host, config.port))
                        .ok()
                        .and_then(|url| url.host_str().map(str::to_owned))
                    {
                        Some(host) if !raw.contains(':') => host.to_ascii_lowercase(),
                        _ => return Err(invalid("config.host", SourcePlanReason::InvalidEndpoint)),
                    }
                }
            };
            if config.port == 0 {
                return Err(invalid("config.port", SourcePlanReason::InvalidEndpoint));
            }
            Ok(format!("postgresql://{host}:{}", config.port))
        }
        SourceConnectionConfig::HttpJson(config) => {
            let origin = reqwest::Url::parse(&config.origin).map_err(|cause| {
                SourceError::caused_by(
                    SourceFailure::InvalidPlan {
                        field: world_protocol::failure::FieldPath(vec![
                            "config".into(),
                            "origin".into(),
                        ]),
                        reason: SourcePlanReason::InvalidEndpoint,
                    },
                    FailureStage::Validate,
                    cause,
                )
            })?;
            if !matches!(origin.scheme(), "http" | "https")
                || origin.host_str().is_none()
                || !origin.username().is_empty()
                || origin.password().is_some()
                || origin.query().is_some()
                || origin.fragment().is_some()
                || origin.path() != "/"
            {
                return Err(invalid("config.origin", SourcePlanReason::InvalidEndpoint));
            }
            Ok(origin.origin().ascii_serialization())
        }
        SourceConnectionConfig::Plugin(_) => {
            Err(invalid("config", SourcePlanReason::InvalidEndpoint))
        }
    }
}

pub(super) fn read_access(
    connection: &world_protocol::sources::ConnectionRevision,
) -> Result<Vec<world_protocol::package::RequestedAccess>, SourceError> {
    use world_protocol::package::RequestedAccess;
    let mut access = vec![RequestedAccess::SourceRead {
        source_id: connection.source_id.clone(),
    }];
    if !matches!(&connection.config, SourceConnectionConfig::Plugin(_)) {
        access.push(RequestedAccess::Network {
            origin: network_origin(&connection.config)?,
        });
    }
    Ok(access)
}

fn capabilities(value: &SourceCapabilities) -> Result<(), SourceError> {
    if value.contract
        != sources::read_contract().map_err(|cause| {
            SourceError::caused_by(SourceFailure::InternalFault, FailureStage::Validate, cause)
        })?
    {
        return Err(invalid(
            "config.declaredCapabilities.contract",
            SourcePlanReason::CapabilityNotDeclared,
        ));
    }
    Ok(())
}
fn value_type(value: &ValueType) -> Result<(), SourceError> {
    crate::definitions::validate_value_type(value).map_err(|failure| {
        SourceError::new(
            SourceFailure::Compile {
                failure: world_protocol::compiler::CompileFailure::Definition { failure },
            },
            FailureStage::Validate,
        )
    })
}
fn identifier(value: &str) -> Result<(), SourceError> {
    if value.is_empty() || value.len() > 63 || value.chars().any(|c| c.is_control()) {
        return Err(invalid(
            "config.identifier",
            SourcePlanReason::InvalidIdentifier,
        ));
    }
    Ok(())
}
fn endpoint(origin: &reqwest::Url, path: &str) -> Result<(), SourceError> {
    if !path.starts_with('/')
        || path.starts_with("//")
        || path.chars().any(char::is_control)
        || origin.join(path).map_or(true, |target| {
            target.origin() != origin.origin() || target.fragment().is_some()
        })
    {
        return Err(invalid("config.path", SourcePlanReason::InvalidEndpoint));
    }
    Ok(())
}
fn pointer(value: &str) -> Result<(), SourceError> {
    if (!value.is_empty() && !value.starts_with('/'))
        || value
            .as_bytes()
            .windows(2)
            .any(|pair| pair[0] == b'~' && !matches!(pair[1], b'0' | b'1'))
        || value.ends_with('~')
    {
        return Err(invalid("config.pointer", SourcePlanReason::InvalidValue));
    }
    Ok(())
}
fn invalid(field: &str, reason: SourcePlanReason) -> SourceError {
    SourceError::invalid(field, reason)
}
