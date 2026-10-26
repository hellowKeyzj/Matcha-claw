use std::collections::BTreeSet;

use super::ReadMetadata;
use crate::sources::{
    connectors::{SourceError, values},
    mapping,
};
use world_protocol::{
    failure::FailureStage,
    materials::SourceAnchor,
    sources::{
        RecordCell, SnapshotCapability, SourceConnectionConfig, SourceFailure, SourceGuarantee,
        SourcePage, SourcePlanReason, SourceReadPlan,
    },
    time::Timestamp,
};

pub(in super::super) fn read_plan(
    metadata: &ReadMetadata,
    plan: &SourceReadPlan,
) -> Result<SourceReadPlan, SourceError> {
    let resource = resource(metadata)?;
    let mut request = plan.clone();
    for key in &resource.key {
        if !request.fields.iter().any(|field| field == key.as_str()) {
            request.fields.push(key.to_string());
        }
    }
    Ok(request)
}

pub(in super::super) fn validate_page(
    metadata: &ReadMetadata,
    plan: &SourceReadPlan,
    page: &SourcePage,
) -> Result<(), SourceError> {
    let resource = resource(metadata)?;
    let binding = &metadata.binding.body;
    let basis = &page.basis;
    let expected: BTreeSet<_> = binding
        .field_mapping
        .iter()
        .map(|field| &field.property)
        .collect();
    let actual: BTreeSet<_> = basis.field_definitions.iter().collect();
    if basis.source_id != binding.source_id
        || basis.incarnation != binding.incarnation
        || basis.binding != metadata.binding.reference
        || basis.mapping_revision != binding.mapping.revision
        || basis.authority_revision != binding.authority.revision
        || basis.schema != binding.schema
        || basis.identity_rule != binding.identity_rule
        || actual != expected
        || actual.len() != basis.field_definitions.len()
        || basis.position.as_ref().is_some_and(|position| {
            position.source_id != binding.source_id || position.incarnation != binding.incarnation
        })
    {
        return Err(values::invalid_response("basis"));
    }
    let now = Timestamp::try_new(chrono::Utc::now().to_rfc3339()).map_err(|cause| {
        SourceError::caused_by(
            SourceFailure::ProtocolViolation,
            FailureStage::Validate,
            cause,
        )
    })?;
    if basis.observed_at > now
        || basis.captured_at.as_ref().is_some_and(|at| at > &now)
        || basis
            .last_reconciled_at
            .as_ref()
            .is_some_and(|at| at > &now)
    {
        return Err(values::invalid_response("basis.observedAt"));
    }
    if page.rows.len() > plan.limit as usize {
        return Err(SourceError::new(
            SourceFailure::ResponseLimit,
            FailureStage::Read,
        ));
    }
    if page.continuation.as_ref().is_some_and(|token| {
        token.is_empty() || token.len() > 4096 || plan.continuation.as_ref() == Some(token)
    }) || page.complete == page.continuation.is_some()
    {
        return Err(values::invalid_response("continuation"));
    }
    if basis.guarantee == SourceGuarantee::Authoritative
        && !matches!(
            binding.capabilities.snapshot,
            SnapshotCapability::Transactional | SnapshotCapability::StableKeyEnumeration
        )
    {
        return Err(values::invalid_response("basis.guarantee"));
    }
    let mut keys = BTreeSet::new();
    for row in &page.rows {
        if row.incarnation != binding.incarnation
            || row.native_key.is_empty()
            || !keys.insert(&row.native_key)
        {
            return Err(values::invalid_response("rows.nativeKey"));
        }
        let mut fields = BTreeSet::new();
        for field in &row.fields {
            if !fields.insert(field.id.as_str())
                || !plan.fields.iter().any(|id| id == field.id.as_str())
            {
                return Err(values::invalid_response("rows.fields"));
            }
            mapping::validate_observed_field(&metadata.schema, field).map_err(|failure| {
                SourceError::new(SourceFailure::Mapping { failure }, FailureStage::Validate)
            })?;
            let schema = metadata
                .schema
                .fields
                .iter()
                .find(|entry| entry.id == field.id)
                .ok_or_else(|| values::invalid_response("rows.fields"))?;
            match &field.value {
                RecordCell::Known { value } => {
                    crate::definitions::validate_value(&schema.value_type, schema.nullable, value)
                        .map_err(|failure| {
                        SourceError::new(
                            SourceFailure::Compile {
                                failure: world_protocol::compiler::CompileFailure::Definition {
                                    failure,
                                },
                            },
                            FailureStage::Validate,
                        )
                    })?
                }
                RecordCell::Missing if !schema.optional => {
                    return Err(values::invalid_response("rows.fields.value"));
                }
                _ => {}
            }
            if let Some(formula) = &field.formula {
                if formula.cache_current
                    && !matches!(&field.value, RecordCell::Known { value } if formula.cached.as_ref() == Some(value))
                {
                    return Err(values::invalid_response("rows.fields.formula"));
                }
            }
            if let Some(anchor) = &field.locator {
                if !matches!(anchor, SourceAnchor::Record { namespace, native_key, fields }
                    if namespace == &binding.namespace && native_key == &row.native_key && fields == &vec![field.name.clone()])
                {
                    return Err(values::invalid_response("rows.fields.locator"));
                }
            }
        }
        if plan.fields.iter().any(|id| {
            !fields.contains(id.as_str())
                && !metadata
                    .schema
                    .fields
                    .iter()
                    .any(|field| field.id.as_str() == id && field.optional)
        }) {
            return Err(values::invalid_response("rows.fields"));
        }
        let key = resource
            .key
            .iter()
            .map(|key| {
                let field = row
                    .fields
                    .iter()
                    .find(|field| &field.id == key)
                    .ok_or_else(|| values::invalid_response("rows.nativeKey"))?;
                if field.formula.as_ref().is_some_and(|formula| {
                    !formula.cache_current || !matches!(&field.value, RecordCell::Known { value } if formula.cached.as_ref() == Some(value))
                }) {
                    return Err(values::invalid_response("rows.nativeKey"));
                }
                Ok(field.value.clone())
            })
            .collect::<Result<Vec<_>, SourceError>>()?;
        if values::native_key(&key)? != row.native_key {
            return Err(values::invalid_response("rows.nativeKey"));
        }
    }
    Ok(())
}

fn resource(
    metadata: &ReadMetadata,
) -> Result<&world_protocol::sources::PluginResource, SourceError> {
    let SourceConnectionConfig::Plugin(config) = &metadata.connection.config else {
        return Err(SourceError::new(
            SourceFailure::ProtocolViolation,
            FailureStage::Validate,
        ));
    };
    let caps = &metadata.binding.body.capabilities;
    if metadata.plan.predicate.is_some() && !caps.predicate_pushdown {
        return Err(SourceError::invalid(
            "predicate",
            SourcePlanReason::UnsupportedPredicate,
        ));
    }
    if !metadata.plan.order.is_empty() && !caps.ordering_pushdown {
        return Err(SourceError::invalid(
            "order",
            SourcePlanReason::UnsupportedOrdering,
        ));
    }
    if metadata.plan.as_of.is_some() && !caps.historical_read {
        return Err(SourceError::new(
            SourceFailure::HistoryUnavailable,
            FailureStage::Read,
        ));
    }
    config
        .resources
        .iter()
        .find(|resource| resource.id == metadata.plan.resource)
        .ok_or_else(|| SourceError::invalid("resource", SourcePlanReason::UnknownResource))
}
