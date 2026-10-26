use std::collections::BTreeMap;

use world_protocol::{
    ids::SourceFieldId,
    sources::{MappingFailure, SchemaDiscovery},
    value::ValueType,
};

/// Discovery never approves a changed mapping. Only dependencies of this plan are checked.
pub(crate) fn schema_drift(
    expected: &SchemaDiscovery,
    actual: &SchemaDiscovery,
    dependencies: &[SourceFieldId],
) -> Vec<MappingFailure> {
    if expected.source_id != actual.source_id
        || expected.incarnation != actual.incarnation
        || expected.namespace != actual.namespace
        || expected.reference.world != actual.reference.world
    {
        return vec![MappingFailure::RevisionMismatch];
    }
    let before: BTreeMap<_, _> = expected
        .fields
        .iter()
        .map(|field| (&field.id, field))
        .collect();
    let after: BTreeMap<_, _> = actual
        .fields
        .iter()
        .map(|field| (&field.id, field))
        .collect();
    if before.len() != expected.fields.len() || after.len() != actual.fields.len() {
        return vec![MappingFailure::RevisionMismatch];
    }
    let mut failures = Vec::new();
    for id in dependencies {
        let Some(previous) = before.get(id) else {
            failures.push(MappingFailure::SchemaMissing {
                reference: expected.reference.clone(),
            });
            continue;
        };
        let Some(current) = after.get(id) else {
            failures.push(if actual.complete {
                MappingFailure::FieldRemoved { field: id.clone() }
            } else {
                MappingFailure::SchemaMissing {
                    reference: actual.reference.clone(),
                }
            });
            continue;
        };
        if current.name != previous.name {
            failures.push(MappingFailure::FieldRenamed { field: id.clone() });
        }
        if precision_changed(&previous.value_type, &current.value_type) {
            failures.push(MappingFailure::PrecisionChanged { field: id.clone() });
        } else if previous.value_type != current.value_type
            || previous.nullable != current.nullable
            || previous.optional != current.optional
        {
            failures.push(MappingFailure::FieldTypeChanged { field: id.clone() });
        }
        if !current.readable {
            failures.push(MappingFailure::PermissionDenied {
                field: Some(id.clone()),
            });
        }
    }
    failures
}

fn precision_changed(before: &ValueType, after: &ValueType) -> bool {
    match (before, after) {
        (
            ValueType::Decimal {
                precision: p1,
                scale: s1,
            },
            ValueType::Decimal {
                precision: p2,
                scale: s2,
            },
        ) => p1 != p2 || s1 != s2,
        (
            ValueType::List {
                element: before, ..
            },
            ValueType::List { element: after, .. },
        ) => precision_changed(before, after),
        (ValueType::Record { fields: before }, ValueType::Record { fields: after }) => {
            before.iter().any(|field| {
                after
                    .iter()
                    .find(|current| current.name == field.name)
                    .is_some_and(|current| {
                        precision_changed(&field.value_type, &current.value_type)
                    })
            })
        }
        _ => false,
    }
}
