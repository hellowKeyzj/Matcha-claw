mod digest;
mod error;
mod reducer;
mod registry;

pub(crate) use registry::{CheckedKind, DefinitionVerb, KindPlan, KindRegistry};

pub(crate) use error::DefinitionError;
pub(crate) use reducer::{
    apply_definition_evidence, apply_definitions, apply_definitions_checked, apply_scope, bootstrap_scope,
};
mod lifecycle;
mod read;
mod references;

pub(crate) use read::{
    next_definition_revision, read_definition, read_definition_head, read_definition_snapshot, read_scopes,
    read_scopes_snapshot, validate_current_reference, validate_current_reference_snapshot,
};
mod scope;
mod shape;
mod validate;
mod values;

pub(crate) use digest::{canonical_digest, content_digest};
pub(crate) use lifecycle::validate_revision;
pub(crate) use references::{
    definition_references, definition_resources, expression_references, expression_resources,
    query_references, query_resources, value_type_resources,
};
pub(crate) use scope::{scope_contains, valid_time_contains};
pub(crate) use shape::validate_expression;
pub(crate) use validate::{
    DefinitionValidator, validate_applicability, validate_attribute, validate_definition,
    validate_relation, validate_structure,
};
pub(crate) use values::{validate_value, validate_value_type, value_resources};

use world_protocol::{
    definitions::{DefinitionFailure, DefinitionFieldReason},
    failure::FieldPath,
};

fn invalid(path: &[String], reason: DefinitionFieldReason) -> DefinitionFailure {
    DefinitionFailure::InvalidField {
        field: FieldPath(path.to_vec()),
        reason,
    }
}

fn field(parent: &[String], name: impl ToString) -> Vec<String> {
    let mut path = parent.to_vec();
    path.push(name.to_string());
    path
}
