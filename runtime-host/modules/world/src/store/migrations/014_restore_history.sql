CREATE TABLE world_branch_head (
    tenant_id text NOT NULL, world_id text NOT NULL, branch_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0),
    PRIMARY KEY(tenant_id,world_id,branch_id),
    FOREIGN KEY(tenant_id,world_id,branch_id,revision) REFERENCES world_branch_revision
);
ALTER TABLE world_change_set ADD COLUMN branch_revision bigint;
CREATE TABLE world_candidate_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, candidate_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0),
    task_id text NOT NULL, task_revision bigint NOT NULL CHECK(task_revision > 0),
    change_set_id text NOT NULL, content_digest text NOT NULL, status text NOT NULL, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,candidate_id,revision),
    FOREIGN KEY(tenant_id,world_id,candidate_id) REFERENCES world_candidate,
    FOREIGN KEY(tenant_id,world_id,task_id,task_revision) REFERENCES world_task_revision,
    FOREIGN KEY(tenant_id,world_id,change_set_id,revision) REFERENCES world_change_set
);
CREATE TABLE world_candidate_head (
    tenant_id text NOT NULL, world_id text NOT NULL, candidate_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0),
    PRIMARY KEY(tenant_id,world_id,candidate_id),
    FOREIGN KEY(tenant_id,world_id,candidate_id,revision) REFERENCES world_candidate_revision
);
ALTER TABLE world_run ADD COLUMN branch_revision bigint;
-- world:restore-history-backfill
ALTER TABLE world_change_set ALTER COLUMN branch_revision SET NOT NULL,
    ADD CHECK(branch_revision > 0),
    ADD FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision) REFERENCES world_branch_revision;
ALTER TABLE world_run ADD CHECK(branch_revision IS NULL OR branch_revision > 0),
    ADD CHECK((branch_id IS NULL) = (branch_revision IS NULL)),
    ADD FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision) REFERENCES world_branch_revision;
ALTER TABLE world_branch DROP COLUMN revision, DROP COLUMN base_release_id, DROP COLUMN activation_lock_id,
    DROP COLUMN basis_digest, DROP COLUMN replayability, DROP COLUMN status, DROP COLUMN body;
ALTER TABLE world_candidate DROP COLUMN revision, DROP COLUMN task_id, DROP COLUMN task_revision,
    DROP COLUMN branch_id, DROP COLUMN content_digest, DROP COLUMN status, DROP COLUMN body;
CREATE TRIGGER world_branch_immutable BEFORE UPDATE OR DELETE ON world_branch FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_candidate_immutable BEFORE UPDATE OR DELETE ON world_candidate FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_candidate_revision_immutable BEFORE UPDATE OR DELETE ON world_candidate_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_change_set_immutable BEFORE UPDATE OR DELETE ON world_change_set FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
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
        'world_source_branch_capture','world_branch_identity_reservation','world_branch_identity_promotion'
    ]::text[]
$$;
