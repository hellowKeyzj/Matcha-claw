CREATE TABLE world_branch_derivation_revision (
    tenant_id text NOT NULL, world_id text NOT NULL,
    branch_id text NOT NULL, branch_revision bigint NOT NULL CHECK(branch_revision > 0),
    assertion_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    release_id text NOT NULL,
    model_digest text NOT NULL CHECK(model_digest ~ '^sha256:[0-9a-f]{64}$'),
    derivation_digest text NOT NULL CHECK(derivation_digest ~ '^sha256:[0-9a-f]{64}$'),
    run_id text NOT NULL, step_id text NOT NULL, body jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,branch_id,branch_revision,assertion_id,revision),
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision) REFERENCES world_branch_revision,
    FOREIGN KEY(tenant_id,world_id,release_id) REFERENCES world_release,
    FOREIGN KEY(tenant_id,world_id,run_id,step_id) REFERENCES world_step
);
CREATE TRIGGER world_branch_derivation_revision_immutable BEFORE UPDATE OR DELETE ON world_branch_derivation_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_branch_derivation_head (
    tenant_id text NOT NULL, world_id text NOT NULL,
    branch_id text NOT NULL, branch_revision bigint NOT NULL CHECK(branch_revision > 0),
    assertion_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    PRIMARY KEY(tenant_id,world_id,branch_id,branch_revision,assertion_id),
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision,assertion_id,revision) REFERENCES world_branch_derivation_revision
);
CREATE OR REPLACE FUNCTION world_archive_included() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
    SELECT ARRAY[
        'world_source_version','world_parse_artifact',
        'world_scope_revision','world_definition_identity','world_definition_revision','world_definition_head',
        'world_definition_dependency','world_definition_lineage','world_kind_registration',
        'world_object_identity','world_relation_identity','world_identity_revision','world_identity_influence',
        'world_alias_range','world_source_alias_revision','world_source_alias_current','world_identity_resolution','world_identity_resolution_member',
        'world_evidence_revision','world_evidence_head','world_evidence_derived_from',
        'world_assertion_identity','world_assertion_revision','world_assertion_head','world_assertion_role','world_assertion_evidence','world_assertion_subject',
        'world_definition_evidence_revision','world_definition_evidence_head','world_definition_evidence',
        'world_watch_partition','world_watch','world_watch_field','world_watch_range',
        'world_support_revision','world_support_head','world_support_premise','world_support_graph_guard',
        'world_explanation_revision','world_explanation_view',
        'world_source_schema_revision','world_source_schema_head','world_schema_mapping_revision',
        'world_source_binding_revision','world_source_binding_head',
        'world_source_record_state','world_source_record_state_head',
        'world_artifact_manifest','world_compile_dependency','world_release','world_release_head','world_release_definition','world_release_head_history',
        'world_branch','world_branch_revision','world_branch_head','world_change_set',
        'world_candidate','world_candidate_revision','world_candidate_head',
        'world_definition_annotation_revision','world_definition_annotation_head','world_definition_link_revision','world_definition_link_head',
        'world_source_branch_capture','world_branch_identity_reservation','world_branch_identity_promotion',
        'world_branch_derivation_revision','world_branch_derivation_head'
    ]::text[]
$$;
