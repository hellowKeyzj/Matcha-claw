//! Deterministic source mapping. This module produces proposals, never commits facts.
mod authoring;
pub(crate) use authoring::{
    authoring_branch, branch_mapping_impact, branch_source_context, branch_source_context_impact,
    context_rows, context_step, set_branch_mapping,
};
mod branch;
mod branch_plan;
mod branch_records;
pub(crate) use branch_plan::{compile_branch_binding, compile_branch_binding_snapshot};
pub(in crate::sources) use branch_records::{map_branch_records, replay_branch_records};
mod capabilities;
mod compatibility;
mod compile;
mod drift;
mod error;
mod exact;
mod observations;
pub(in crate::sources) use observations::validate_observed_field;
mod persistence;
mod persistence_snapshot;
mod published;
mod queries;
pub(crate) use published::{published_definition, published_definition_snapshot};
pub(crate) use queries::{binding_impact, mappings, mappings_impact, set_mapping_impact};
mod receipts;
pub(in crate::sources) use receipts::validate_row_key;
mod recheck;
mod records;
mod relations;
pub(crate) use relations::map_query_roles;
mod transform;

pub(crate) use recheck::{recheck_dependencies, recheck_dependencies_snapshot};

pub(in crate::sources) use branch::promote_branch_binding;
pub(crate) use branch::{
    approve_branch_authority, branch_authority_impact, read_branch_authority,
    read_branch_authority_snapshot,
};
pub(crate) use error::{MappingError, safe_failure};
pub(crate) use persistence::{
    activate_binding, approve_authority, binding_retention_roots, compile_binding, read_authority,
    read_binding, read_mapping, read_schema, save_discovered_schema, save_mapping, save_schema,
    set_mapping,
};

pub(crate) use compile::compile_plan;
pub(crate) use observations::map_query_field;
pub(crate) use persistence_snapshot::{
    read_authority_snapshot, read_binding_snapshot, read_mapping_snapshot, read_schema_snapshot,
};
pub(in crate::sources) use records::map_branch_observations;
pub(crate) use records::{MappedObservation, MappedRecords, map_records};
pub(crate) use transform::{apply as transform_value, compatible as transform_compatible};

pub(crate) use drift::schema_drift;
