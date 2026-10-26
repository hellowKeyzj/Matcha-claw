use world_protocol::{
    definitions::{Definition, Property},
    facts::{Evidence, EvidenceAvailability, EvidenceLocator, EvidenceStatus},
    ids::{EvidenceId, EvidenceRef, Revision},
    materials::SourceAnchor,
    sources::{
        FormulaSemantics, MapRecordsRequest, MappedField, MappingFailure, MissingSemantics,
        NullSemantics, RecordCell, SchemaDiscovery, SourceField, SourceRow,
    },
    value::{Cell, UnknownReason, Value},
};

use super::transform;

pub(super) fn map_field(
    request: &MapRecordsRequest,
    mapped: &MappedField,
    definition: &Definition<Property>,
    source: Option<&SourceField>,
) -> Result<Option<Cell>, MappingFailure> {
    map_field_with_schema(
        &request.plan.schema,
        &request.observed_schema,
        mapped,
        definition,
        source,
    )
}

pub(crate) fn map_query_field(
    schema: &SchemaDiscovery,
    mapped: &MappedField,
    definition: &Definition<Property>,
    source: Option<&SourceField>,
) -> Result<Option<Cell>, MappingFailure> {
    map_field_with_schema(schema, schema, mapped, definition, source)
}

fn map_field_with_schema(
    schema: &SchemaDiscovery,
    observed: &SchemaDiscovery,
    mapped: &MappedField,
    definition: &Definition<Property>,
    source: Option<&SourceField>,
) -> Result<Option<Cell>, MappingFailure> {
    let unknown = || {
        Some(Cell::Unknown {
            reason: UnknownReason::NotObserved,
        })
    };
    let input = match source {
        Some(source) => {
            validate_observed_field(observed, source)?;
            if let RecordCell::Error { code } = &source.value {
                return Err(
                    if matches!(code, world_protocol::sources::RecordError::PermissionDenied) {
                        MappingFailure::PermissionDenied {
                            field: Some(source.id.clone()),
                        }
                    } else {
                        MappingFailure::InvalidValue {
                            field: source.id.clone(),
                            reason: *code,
                        }
                    },
                );
            }
            if let Some(formula) = &source.formula {
                if matches!(&source.value, RecordCell::Known { value } if formula.cached.as_ref() != Some(value))
                {
                    return Err(MappingFailure::InvalidValue {
                        field: source.id.clone(),
                        reason: world_protocol::sources::RecordError::InvalidFormula,
                    });
                }
                match mapped.formula {
                    FormulaSemantics::Reject => {
                        return Err(MappingFailure::FormulaUnavailable {
                            field: mapped.source_field.clone(),
                        });
                    }
                    FormulaSemantics::PreserveOnly => {
                        return Ok(Some(Cell::Unknown {
                            reason: UnknownReason::NeedsEvidence,
                        }));
                    }
                    FormulaSemantics::RequireCurrentCache => {
                        if !formula.cache_current {
                            return Err(MappingFailure::FormulaUnavailable {
                                field: mapped.source_field.clone(),
                            });
                        }
                        Some(formula.cached.as_ref().ok_or_else(|| {
                            MappingFailure::FormulaUnavailable {
                                field: mapped.source_field.clone(),
                            }
                        })?)
                    }
                }
            } else {
                match &source.value {
                    RecordCell::Missing => None,
                    RecordCell::Known { value } => Some(value),
                    RecordCell::Error {
                        code: world_protocol::sources::RecordError::PermissionDenied,
                    } => {
                        return Err(MappingFailure::PermissionDenied {
                            field: Some(source.id.clone()),
                        });
                    }
                    RecordCell::Error { code } => {
                        return Err(MappingFailure::InvalidValue {
                            field: source.id.clone(),
                            reason: *code,
                        });
                    }
                }
            }
        }
        None => None,
    };
    let Some(value) = input else {
        return match mapped.missing {
            MissingSemantics::Unknown => Ok(unknown()),
            MissingSemantics::Skip => Ok(None),
            MissingSemantics::Reject => Err(MappingFailure::InvalidValue {
                field: mapped.source_field.clone(),
                reason: world_protocol::sources::RecordError::UnsupportedValue,
            }),
        };
    };
    if matches!(value, Value::Null) && matches!(mapped.null, NullSemantics::Reject) {
        return Err(MappingFailure::NullNotAllowed {
            property: mapped.property.clone(),
        });
    }
    let schema = schema
        .fields
        .iter()
        .find(|field| field.id == mapped.source_field)
        .ok_or_else(|| MappingFailure::FieldRemoved {
            field: mapped.source_field.clone(),
        })?;
    crate::definitions::validate_value(&schema.value_type, schema.nullable, value).map_err(
        |failure| transform::value_failure(failure, &mapped.source_field, &mapped.property),
    )?;
    let value = transform::apply(
        &mapped.transform,
        value,
        &mapped.source_field,
        &mapped.property,
        &definition.body.value_type,
        definition.body.nullable,
    )?;
    Ok(Some(Cell::Known { value }))
}

pub(super) fn validate_field(
    request: &MapRecordsRequest,
    field: &SourceField,
) -> Result<(), MappingFailure> {
    validate_observed_field(&request.observed_schema, field)
}

pub(in crate::sources) fn validate_observed_field(
    observed: &SchemaDiscovery,
    field: &SourceField,
) -> Result<(), MappingFailure> {
    let schema = observed
        .fields
        .iter()
        .find(|entry| entry.id == field.id)
        .ok_or_else(|| MappingFailure::SchemaMissing {
            reference: observed.reference.clone(),
        })?;
    if field.name != schema.name {
        return Err(MappingFailure::FieldRenamed {
            field: field.id.clone(),
        });
    }
    if !schema.readable {
        return Err(MappingFailure::PermissionDenied {
            field: Some(field.id.clone()),
        });
    }
    Ok(())
}

pub(super) fn field_evidence(
    request: &MapRecordsRequest,
    row: &SourceRow,
    mapped: &MappedField,
    source: Option<&SourceField>,
) -> Result<Evidence, MappingFailure> {
    let field_name = request
        .plan
        .schema
        .fields
        .iter()
        .find(|field| field.id == mapped.source_field)
        .ok_or(MappingFailure::RevisionMismatch)?
        .name
        .clone();
    if let Some(SourceAnchor::Record {
        namespace,
        native_key,
        fields,
    }) = source.and_then(|field| field.locator.as_ref())
    {
        if namespace != &request.plan.binding_body.namespace
            || native_key != &row.native_key
            || fields != &vec![field_name.clone()]
        {
            return Err(MappingFailure::RevisionMismatch);
        }
    }
    let anchor = SourceAnchor::Record {
        namespace: request.plan.binding_body.namespace.clone(),
        native_key: row.native_key.clone(),
        fields: vec![field_name],
    };
    evidence(
        request,
        &anchor,
        &(
            row.native_key.as_str(),
            row.incarnation.as_str(),
            mapped,
            source,
        ),
    )
}

pub(super) fn evidence(
    request: &MapRecordsRequest,
    anchor: &SourceAnchor,
    content: &impl serde::Serialize,
) -> Result<Evidence, MappingFailure> {
    let digest = crate::definitions::canonical_digest(&(
        "world.records.map.evidence.v1",
        &request.source_version,
        &request.plan.binding,
        &request.plan.authority,
        &request.basis,
        &request.plan.mapping.reference,
        &request.batch.valid_time,
        anchor,
        content,
    ))
    .map_err(|_| MappingFailure::InternalFault)?;
    let id = EvidenceId::try_new(format!("record-{}", &digest.as_str()[7..]))
        .map_err(|_| MappingFailure::InternalFault)?;
    Ok(Evidence {
        reference: EvidenceRef {
            world: request.plan.binding.world.clone(),
            id,
            revision: Revision(1),
        },
        locator: EvidenceLocator {
            source_version: request.batch.source_version.clone(),
            parse_artifact_id: None,
            anchor: anchor.clone(),
        },
        digest: Some(digest),
        origin_family: request.source_version.origin_family.clone(),
        derived_from: Vec::new(),
        observed_at: request.basis.observed_at.clone(),
        authority: Some(request.plan.authority.authority.clone()),
        access: request.source_version.access.clone(),
        retention: request.source_version.retention.clone(),
        status: EvidenceStatus::Active,
        availability: EvidenceAvailability::Available,
    })
}

pub(super) use super::relations::map_relations;
