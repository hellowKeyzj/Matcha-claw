CREATE TABLE world_archive_manifest (
    tenant_id text NOT NULL, world_id text NOT NULL, archive_digest text NOT NULL CHECK(archive_digest ~ '^sha256:[0-9a-f]{64}$'),
    backup_commit_id text NOT NULL, manifest jsonb NOT NULL,
    manifest_blob_digest text NOT NULL, manifest_blob_size bigint NOT NULL CHECK(manifest_blob_size >= 0),
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,archive_digest),
    UNIQUE(tenant_id,world_id,manifest_blob_digest,manifest_blob_size),
    FOREIGN KEY(tenant_id,world_id,manifest_blob_digest) REFERENCES world_blob(tenant_id,world_id,digest),
    FOREIGN KEY(tenant_id,world_id,backup_commit_id) REFERENCES world_commit_receipt
);
CREATE TRIGGER world_archive_manifest_immutable BEFORE UPDATE OR DELETE ON world_archive_manifest FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
ALTER TABLE world_runtime_head ADD COLUMN mutation_xid xid8, ADD COLUMN mutation_commit_id text, ADD COLUMN mutation_operation_id text,
    ADD COLUMN mutation_final_commit_id text, ADD COLUMN mutation_archive_digest text, ADD COLUMN mutation_kind text CHECK(mutation_kind IN ('restoring','deleting')),
    ADD CHECK((mutation_commit_id IS NULL) = (mutation_operation_id IS NULL)),
    ADD CHECK((mutation_commit_id IS NULL) = (mutation_final_commit_id IS NULL)),
    ADD CHECK((mutation_kind='restoring') = (mutation_archive_digest IS NOT NULL)),
    ADD CHECK((mutation_commit_id IS NULL) = (mutation_kind IS NULL)),
    ADD CHECK(status NOT IN ('restoring','deleting') OR coalesce(status=mutation_kind,false)),
    ADD FOREIGN KEY(tenant_id,world_id,mutation_commit_id) REFERENCES world_commit_receipt,
    ADD FOREIGN KEY(tenant_id,world_id,mutation_operation_id) REFERENCES world_operation,
    ADD FOREIGN KEY(tenant_id,world_id,mutation_archive_digest) REFERENCES world_archive_manifest;
ALTER TABLE world_run
    ADD FOREIGN KEY(tenant_id,world_id,release_id) REFERENCES world_release,
    ADD FOREIGN KEY(tenant_id,world_id,branch_id) REFERENCES world_branch,
    ADD FOREIGN KEY(tenant_id,world_id,activation_lock_id) REFERENCES world_activation_lock;
-- The sole archive catalog. Runtime/security/physical custody tables are never replaced.
CREATE FUNCTION world_archive_included() RETURNS text[] LANGUAGE sql IMMUTABLE AS $$
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
        'world_branch','world_branch_revision','world_change_set',
        'world_definition_annotation_revision','world_definition_annotation_head','world_definition_link_revision','world_definition_link_head',
        'world_source_branch_capture','world_branch_identity_reservation','world_branch_identity_promotion'
    ]::text[]
$$;
CREATE FUNCTION world_is_archive_mutation(t text,w text,tab text) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT tab=ANY(world_archive_included()) AND EXISTS(
        SELECT 1 FROM world_runtime_head WHERE tenant_id=t AND world_id=w
        AND status IN ('restoring','deleting') AND mutation_xid=pg_current_xact_id())
$$;
CREATE OR REPLACE FUNCTION world_immutable_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' AND world_is_archive_mutation(to_jsonb(OLD)->>'tenant_id',to_jsonb(OLD)->>'world_id',TG_TABLE_NAME) THEN RETURN OLD; END IF;
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_immutable_revision', MESSAGE='immutable world revision';
END $$;
CREATE FUNCTION world_check_archive_closed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM world_runtime_head WHERE tenant_id=NEW.tenant_id AND world_id=NEW.world_id AND mutation_xid IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_archive_closed', MESSAGE='incomplete world archive mutation';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER world_archive_closed AFTER INSERT OR UPDATE ON world_runtime_head
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION world_check_archive_closed();
