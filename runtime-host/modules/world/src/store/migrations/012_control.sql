CREATE TABLE world_runtime_head (
    tenant_id text NOT NULL, world_id text NOT NULL,
    generation bigint NOT NULL DEFAULT 1 CHECK(generation > 0),
    revision bigint NOT NULL DEFAULT 1 CHECK(revision > 0),
    status text NOT NULL CHECK(status IN ('ready','restoring','deleting','retained')),
    management_scope_id text NOT NULL, management_scope_revision bigint NOT NULL DEFAULT 1 CHECK(management_scope_revision = 1),
    active_release_channel text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id),
    FOREIGN KEY(tenant_id,world_id) REFERENCES world_storage_head,
    FOREIGN KEY(tenant_id,world_id,management_scope_id,management_scope_revision) REFERENCES world_scope_revision,
    FOREIGN KEY(tenant_id,world_id,active_release_channel) REFERENCES world_release_head
);
CREATE TABLE world_source_connection_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, connection_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), source_id text NOT NULL, scope_id text NOT NULL,
    provider_id text NOT NULL, content_digest text NOT NULL, body jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,connection_id,revision)
);
CREATE TABLE world_source_connection_head (
    tenant_id text NOT NULL, world_id text NOT NULL, connection_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    PRIMARY KEY(tenant_id,world_id,connection_id),
    FOREIGN KEY(tenant_id,world_id,connection_id,revision) REFERENCES world_source_connection_revision
);
CREATE INDEX world_source_connection_lookup ON world_source_connection_revision(tenant_id,world_id,source_id,scope_id,provider_id);
CREATE TABLE world_source_schema_head (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    PRIMARY KEY(tenant_id,world_id,source_id),
    FOREIGN KEY(tenant_id,world_id,source_id,revision) REFERENCES world_source_schema_revision
);
CREATE TABLE world_assertion_subject (
    tenant_id text NOT NULL, world_id text NOT NULL, assertion_id text NOT NULL, revision bigint NOT NULL,
    subject_kind text NOT NULL CHECK(subject_kind IN ('object','relation')), subject_id text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,assertion_id,revision,subject_kind,subject_id),
    FOREIGN KEY(tenant_id,world_id,assertion_id,revision) REFERENCES world_assertion_revision
);
CREATE INDEX world_assertion_subject_reverse ON world_assertion_subject(tenant_id,world_id,subject_kind,subject_id,assertion_id,revision);
CREATE TRIGGER world_assertion_subject_immutable BEFORE UPDATE OR DELETE ON world_assertion_subject FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_explanation_view (
    tenant_id text NOT NULL, world_id text NOT NULL, conclusion_id text NOT NULL, conclusion_revision bigint NOT NULL,
    visibility_digest text NOT NULL, revision bigint NOT NULL CHECK(revision > 0), body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,conclusion_id,conclusion_revision,visibility_digest),
    FOREIGN KEY(tenant_id,world_id,conclusion_id,conclusion_revision) REFERENCES world_assertion_revision
);
CREATE TABLE world_state_activation_ref (
    tenant_id text NOT NULL, world_id text NOT NULL, activation_lock_id text NOT NULL,
    state_root_id text NOT NULL, root_revision bigint NOT NULL CHECK(root_revision > 0), migration_id text, released_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,activation_lock_id,state_root_id,root_revision),
    FOREIGN KEY(tenant_id,world_id,activation_lock_id) REFERENCES world_activation_lock,
    FOREIGN KEY(tenant_id,world_id,state_root_id,root_revision) REFERENCES world_state_root,
    FOREIGN KEY(tenant_id,world_id,migration_id) REFERENCES world_state_migration
);
CREATE INDEX world_state_activation_live ON world_state_activation_ref(tenant_id,world_id,state_root_id,root_revision) WHERE released_at IS NULL;
CREATE TRIGGER world_state_activation_ref_preserve BEFORE UPDATE ON world_state_activation_ref FOR EACH ROW EXECUTE FUNCTION world_preserve_blob_reference();
CREATE TRIGGER world_state_root_immutable BEFORE UPDATE OR DELETE ON world_state_root FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_content_upload (
    tenant_id text NOT NULL, world_id text NOT NULL, transfer_id text NOT NULL, actor_id text NOT NULL,
    state text NOT NULL CHECK(state IN ('receiving','sealed','aborted')), revision bigint NOT NULL CHECK(revision > 0),
    received bigint NOT NULL CHECK(received >= 0), expected_size bigint CHECK(expected_size >= 0), expected_digest text,
    name text, media_type text, expires_at timestamptz, body jsonb NOT NULL, sealed_pin jsonb,
    PRIMARY KEY(tenant_id,world_id,transfer_id),
    CHECK(expected_size IS NULL OR received <= expected_size), CHECK((state='sealed') = (sealed_pin IS NOT NULL))
);
CREATE TABLE world_content_upload_chunk (
    tenant_id text NOT NULL, world_id text NOT NULL, transfer_id text NOT NULL, "offset" bigint NOT NULL CHECK("offset" >= 0),
    byte_size bigint NOT NULL CHECK(byte_size > 0), blob_digest text NOT NULL, pin jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,transfer_id,"offset"),
    FOREIGN KEY(tenant_id,world_id,transfer_id) REFERENCES world_content_upload,
    FOREIGN KEY(tenant_id,world_id,blob_digest) REFERENCES world_blob(tenant_id,world_id,digest)
);
CREATE FUNCTION world_preserve_upload() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW)-'state'-'revision'-'received'-'sealed_pin') IS DISTINCT FROM (to_jsonb(OLD)-'state'-'revision'-'received'-'sealed_pin')
       OR OLD.state <> 'receiving' OR NEW.revision <> OLD.revision+1 OR NEW.received < OLD.received
       OR (NEW.state <> 'receiving' AND NEW.received <> OLD.received)
       OR (NEW.state <> 'sealed' AND NEW.sealed_pin IS DISTINCT FROM OLD.sealed_pin) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_upload_lifecycle', MESSAGE='invalid upload lifecycle transition';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER world_upload_lifecycle BEFORE UPDATE ON world_content_upload FOR EACH ROW EXECUTE FUNCTION world_preserve_upload();
CREATE TABLE world_activation_lifecycle (
    tenant_id text NOT NULL, world_id text NOT NULL, activation_lock_id text NOT NULL,
    state text NOT NULL CHECK(state IN ('active','retiring','released')), revision bigint NOT NULL CHECK(revision > 0),
    retiring_commit_id text, released_commit_id text,
    PRIMARY KEY(tenant_id,world_id,activation_lock_id),
    FOREIGN KEY(tenant_id,world_id,activation_lock_id) REFERENCES world_activation_lock,
    FOREIGN KEY(tenant_id,world_id,retiring_commit_id) REFERENCES world_commit_receipt,
    FOREIGN KEY(tenant_id,world_id,released_commit_id) REFERENCES world_commit_receipt,
    CHECK((state='active' AND retiring_commit_id IS NULL AND released_commit_id IS NULL) OR
          (state='retiring' AND retiring_commit_id IS NOT NULL AND released_commit_id IS NULL) OR
          (state='released' AND retiring_commit_id IS NOT NULL AND released_commit_id IS NOT NULL))
);
CREATE TABLE world_source_claim (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, partition_key text NOT NULL,
    namespace text NOT NULL, native_key text NOT NULL, record_incarnation text NOT NULL, binding_id text NOT NULL,
    assertion_id text NOT NULL, assertion_revision bigint NOT NULL CHECK(assertion_revision > 0),
    valid_from timestamptz NOT NULL, valid_to timestamptz,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    body jsonb NOT NULL, PRIMARY KEY(tenant_id,world_id,source_id,partition_key,assertion_id),
    FOREIGN KEY(tenant_id,world_id,source_id,partition_key) REFERENCES world_source_partition,
    FOREIGN KEY(tenant_id,world_id,assertion_id,assertion_revision) REFERENCES world_assertion_revision,
    CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns), CHECK((valid_to IS NULL) = (valid_to_ns IS NULL))
);
CREATE INDEX world_source_claim_record ON world_source_claim(tenant_id,world_id,source_id,partition_key,namespace,native_key,record_incarnation);
CREATE TABLE world_source_snapshot_member (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, partition_key text NOT NULL,
    run_id text NOT NULL, native_key text NOT NULL, record_incarnation text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,source_id,partition_key,run_id,native_key,record_incarnation),
    FOREIGN KEY(tenant_id,world_id,source_id,partition_key) REFERENCES world_source_partition
);
CREATE TABLE world_branch_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, branch_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    base_release_id text NOT NULL, activation_lock_id text NOT NULL, basis_digest text NOT NULL,
    content_digest text NOT NULL, status text NOT NULL, body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,branch_id,revision),
    FOREIGN KEY(tenant_id,world_id,branch_id) REFERENCES world_branch,
    FOREIGN KEY(tenant_id,world_id,base_release_id) REFERENCES world_release,
    FOREIGN KEY(tenant_id,world_id,activation_lock_id) REFERENCES world_activation_lock
);
CREATE TABLE world_release_definition (
    tenant_id text NOT NULL, world_id text NOT NULL, release_id text NOT NULL, definition_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), content_digest text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,release_id,definition_id), FOREIGN KEY(tenant_id,world_id,release_id) REFERENCES world_release
);
CREATE TABLE world_release_head_history (
    tenant_id text NOT NULL, world_id text NOT NULL, channel text NOT NULL,
    generation bigint NOT NULL CHECK(generation > 0), revision bigint NOT NULL CHECK(revision > 0),
    release_id text NOT NULL, previous_release_id text, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,channel,generation,revision),
    FOREIGN KEY(tenant_id,world_id,release_id) REFERENCES world_release,
    FOREIGN KEY(tenant_id,world_id,previous_release_id) REFERENCES world_release
);
ALTER TABLE world_release ADD COLUMN source_branch_id text, ADD COLUMN source_branch_revision bigint,
    ADD CHECK((source_branch_id IS NULL) = (source_branch_revision IS NULL)),
    ADD FOREIGN KEY(tenant_id,world_id,source_branch_id,source_branch_revision) REFERENCES world_branch_revision;
CREATE TABLE world_definition_annotation_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, branch_id text NOT NULL, branch_revision bigint NOT NULL,
    definition_id text NOT NULL, definition_revision bigint NOT NULL CHECK(definition_revision > 0),
    revision bigint NOT NULL CHECK(revision > 0), previous_revision bigint, content_digest text NOT NULL,
    actor_id text NOT NULL, body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,branch_id,branch_revision,definition_id,definition_revision,revision),
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision) REFERENCES world_branch_revision,
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision,definition_id,definition_revision,previous_revision) REFERENCES world_definition_annotation_revision
);
CREATE TABLE world_definition_annotation_head (
    tenant_id text NOT NULL, world_id text NOT NULL, branch_id text NOT NULL, branch_revision bigint NOT NULL,
    definition_id text NOT NULL, definition_revision bigint NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    PRIMARY KEY(tenant_id,world_id,branch_id,branch_revision,definition_id,definition_revision),
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision,definition_id,definition_revision,revision) REFERENCES world_definition_annotation_revision
);
CREATE TABLE world_definition_link_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, branch_id text NOT NULL, branch_revision bigint NOT NULL,
    source_id text NOT NULL, source_revision bigint NOT NULL CHECK(source_revision > 0),
    target_id text NOT NULL, target_revision bigint NOT NULL CHECK(target_revision > 0), relation text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), previous_revision bigint, content_digest text NOT NULL,
    actor_id text NOT NULL, body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,branch_id,branch_revision,source_id,source_revision,target_id,target_revision,relation,revision),
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision) REFERENCES world_branch_revision,
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision,source_id,source_revision,target_id,target_revision,relation,previous_revision) REFERENCES world_definition_link_revision
);
CREATE TABLE world_definition_link_head (
    tenant_id text NOT NULL, world_id text NOT NULL, branch_id text NOT NULL, branch_revision bigint NOT NULL,
    source_id text NOT NULL, source_revision bigint NOT NULL, target_id text NOT NULL, target_revision bigint NOT NULL, relation text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0),
    PRIMARY KEY(tenant_id,world_id,branch_id,branch_revision,source_id,source_revision,target_id,target_revision,relation),
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision,source_id,source_revision,target_id,target_revision,relation,revision) REFERENCES world_definition_link_revision
);
CREATE TABLE world_source_record_state (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, partition_key text NOT NULL,
    namespace text NOT NULL, native_key text NOT NULL, record_incarnation text NOT NULL, scope_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), status text NOT NULL CHECK(status IN ('available','unavailable','needs_reconcile')),
    binding_id text NOT NULL, binding_revision bigint NOT NULL CHECK(binding_revision > 0),
    valid_from timestamptz NOT NULL, valid_to timestamptz,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,source_id,partition_key,namespace,native_key,record_incarnation,scope_id,revision),
    FOREIGN KEY(tenant_id,world_id,source_id,partition_key) REFERENCES world_source_partition,
    CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns), CHECK((valid_to IS NULL) = (valid_to_ns IS NULL))
);
CREATE TABLE world_source_record_state_head (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, partition_key text NOT NULL,
    namespace text NOT NULL, native_key text NOT NULL, record_incarnation text NOT NULL, scope_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0),
    PRIMARY KEY(tenant_id,world_id,source_id,partition_key,namespace,native_key,record_incarnation,scope_id),
    FOREIGN KEY(tenant_id,world_id,source_id,partition_key,namespace,native_key,record_incarnation,scope_id,revision) REFERENCES world_source_record_state
);
CREATE TABLE world_abstraction_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, abstraction_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    base_release_id text NOT NULL, candidate_id text NOT NULL, branch_id text, branch_revision bigint,
    task_id text NOT NULL, task_revision bigint NOT NULL CHECK(task_revision > 0), scope_id text NOT NULL,
    content_digest text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(tenant_id,world_id,abstraction_id,revision),
    CHECK((branch_id IS NULL) = (branch_revision IS NULL)),
    FOREIGN KEY(tenant_id,world_id,base_release_id) REFERENCES world_release,
    FOREIGN KEY(tenant_id,world_id,candidate_id) REFERENCES world_candidate,
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision) REFERENCES world_branch_revision,
    FOREIGN KEY(tenant_id,world_id,task_id,task_revision) REFERENCES world_task_revision
);
CREATE TRIGGER world_abstraction_immutable BEFORE UPDATE OR DELETE ON world_abstraction_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_model_call (
    tenant_id text NOT NULL, world_id text NOT NULL, model_call_id text NOT NULL,
    run_id text NOT NULL, step_id text NOT NULL, invocation_id text NOT NULL, call_key text NOT NULL,
    binding_digest text NOT NULL, input_digest text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    status text NOT NULL CHECK(status IN ('prepared','dispatched','completed','failed','indeterminate')),
    request jsonb NOT NULL, receipt jsonb, failure jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,model_call_id), UNIQUE(tenant_id,world_id,run_id,step_id,call_key),
    FOREIGN KEY(tenant_id,world_id,run_id,step_id) REFERENCES world_step,
    CHECK(status <> 'completed' OR receipt IS NOT NULL)
);
CREATE INDEX world_model_call_recovery ON world_model_call(tenant_id,world_id,status,updated_at) WHERE status IN ('prepared','dispatched','indeterminate');
CREATE FUNCTION world_preserve_model_call() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW)-'revision'-'status'-'receipt'-'failure'-'updated_at') IS DISTINCT FROM (to_jsonb(OLD)-'revision'-'status'-'receipt'-'failure'-'updated_at')
       OR NEW.revision <> OLD.revision+1
       OR NOT ((OLD.status='prepared' AND NEW.status IN ('dispatched','failed'))
           OR (OLD.status='dispatched' AND NEW.status IN ('completed','failed','indeterminate'))
           OR (OLD.status='indeterminate' AND NEW.status IN ('completed','failed')))
       OR (OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_model_call_lifecycle', MESSAGE='invalid model call lifecycle transition';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER world_model_call_lifecycle BEFORE UPDATE ON world_model_call FOR EACH ROW EXECUTE FUNCTION world_preserve_model_call();
CREATE TABLE world_package_trust_policy (
    tenant_id text NOT NULL, world_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    body jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id), FOREIGN KEY(tenant_id,world_id) REFERENCES world_storage_head
);
CREATE TRIGGER world_definition_annotation_immutable BEFORE UPDATE OR DELETE ON world_definition_annotation_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_definition_link_immutable BEFORE UPDATE OR DELETE ON world_definition_link_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_source_record_state_immutable BEFORE UPDATE OR DELETE ON world_source_record_state FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_read_receipt (
    tenant_id text NOT NULL, world_id text NOT NULL, receipt_id text NOT NULL,
    invocation_id text NOT NULL, decision_id text NOT NULL, query_digest text NOT NULL, scope_digest text NOT NULL,
    policy_epoch bigint NOT NULL CHECK(policy_epoch > 0), grant_epoch bigint NOT NULL CHECK(grant_epoch > 0),
    release_id text NOT NULL, activation_lock_id text NOT NULL, body jsonb NOT NULL, impact jsonb NOT NULL,
    rows jsonb NOT NULL CHECK(jsonb_typeof(rows)='array'), objects jsonb NOT NULL CHECK(jsonb_typeof(objects)='array'),
    relations jsonb NOT NULL CHECK(jsonb_typeof(relations)='array'), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,receipt_id),
    FOREIGN KEY(tenant_id,world_id,decision_id) REFERENCES world_auth_decision,
    FOREIGN KEY(tenant_id,world_id,release_id) REFERENCES world_release,
    FOREIGN KEY(tenant_id,world_id,activation_lock_id) REFERENCES world_activation_lock
);
CREATE TRIGGER world_release_immutable BEFORE UPDATE OR DELETE ON world_release FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_artifact_manifest_immutable BEFORE UPDATE OR DELETE ON world_artifact_manifest FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_compile_dependency_immutable BEFORE UPDATE OR DELETE ON world_compile_dependency FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_content_upload_chunk_immutable BEFORE UPDATE OR DELETE ON world_content_upload_chunk FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_branch_revision_immutable BEFORE UPDATE OR DELETE ON world_branch_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_release_definition_immutable BEFORE UPDATE OR DELETE ON world_release_definition FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_release_head_history_immutable BEFORE UPDATE OR DELETE ON world_release_head_history FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_read_receipt_immutable BEFORE UPDATE OR DELETE ON world_read_receipt FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE FUNCTION world_preserve_activation_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.world_id <> OLD.world_id OR NEW.activation_lock_id <> OLD.activation_lock_id
       OR NEW.revision <> OLD.revision+1
       OR NOT ((OLD.state='active' AND NEW.state='retiring') OR (OLD.state='retiring' AND NEW.state='released'))
       OR (OLD.retiring_commit_id IS NOT NULL AND NEW.retiring_commit_id IS DISTINCT FROM OLD.retiring_commit_id) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_activation_lifecycle', MESSAGE='invalid activation lifecycle transition';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER world_activation_lifecycle BEFORE UPDATE ON world_activation_lifecycle FOR EACH ROW EXECUTE FUNCTION world_preserve_activation_lifecycle();
CREATE FUNCTION world_preserve_runtime_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.tenant_id <> OLD.tenant_id OR NEW.world_id <> OLD.world_id OR NEW.created_at <> OLD.created_at
       OR NEW.revision <> OLD.revision+1 OR NEW.generation < OLD.generation OR NEW.generation > OLD.generation+1
       OR (NEW.generation <> OLD.generation AND NOT ((OLD.status='restoring' AND NEW.status='ready') OR (OLD.status='deleting' AND NEW.status='retained'))) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_runtime_generation', MESSAGE='invalid world lifecycle transition';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER world_runtime_generation BEFORE UPDATE ON world_runtime_head FOR EACH ROW EXECUTE FUNCTION world_preserve_runtime_generation();
CREATE TRIGGER world_scope_revision_immutable BEFORE UPDATE OR DELETE ON world_scope_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_definition_identity_immutable BEFORE UPDATE OR DELETE ON world_definition_identity FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_definition_revision_immutable BEFORE UPDATE OR DELETE ON world_definition_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_definition_dependency_immutable BEFORE UPDATE OR DELETE ON world_definition_dependency FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_definition_lineage_immutable BEFORE UPDATE OR DELETE ON world_definition_lineage FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_kind_registration_immutable BEFORE UPDATE OR DELETE ON world_kind_registration FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_identity_revision_immutable BEFORE UPDATE OR DELETE ON world_identity_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_identity_resolution_immutable BEFORE UPDATE OR DELETE ON world_identity_resolution FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_identity_resolution_member_immutable BEFORE UPDATE OR DELETE ON world_identity_resolution_member FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_source_alias_revision_immutable BEFORE UPDATE OR DELETE ON world_source_alias_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_assertion_identity_immutable BEFORE UPDATE OR DELETE ON world_assertion_identity FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_assertion_role_immutable BEFORE UPDATE OR DELETE ON world_assertion_role FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_assertion_evidence_immutable BEFORE UPDATE OR DELETE ON world_assertion_evidence FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_evidence_derived_immutable BEFORE UPDATE OR DELETE ON world_evidence_derived_from FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_definition_evidence_revision_immutable BEFORE UPDATE OR DELETE ON world_definition_evidence_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_definition_evidence_immutable BEFORE UPDATE OR DELETE ON world_definition_evidence FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_source_connection_revision_immutable BEFORE UPDATE OR DELETE ON world_source_connection_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_candidate_model_call (
    tenant_id text NOT NULL, world_id text NOT NULL, candidate_id text NOT NULL, model_call_id text NOT NULL,
    request_digest text NOT NULL, receipt_digest text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,candidate_id,model_call_id),
    FOREIGN KEY(tenant_id,world_id,candidate_id) REFERENCES world_candidate,
    FOREIGN KEY(tenant_id,world_id,model_call_id) REFERENCES world_model_call
);
CREATE TRIGGER world_candidate_model_call_immutable BEFORE UPDATE OR DELETE ON world_candidate_model_call FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_package_grant_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, install_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    body jsonb NOT NULL CHECK(jsonb_typeof(body)='array'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,install_id,revision),
    FOREIGN KEY(tenant_id,world_id,install_id) REFERENCES world_package_install
);
CREATE TABLE world_package_grant_head (
    tenant_id text NOT NULL, world_id text NOT NULL, install_id text NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,install_id),
    FOREIGN KEY(tenant_id,world_id,install_id,revision) REFERENCES world_package_grant_revision
);
CREATE TRIGGER world_package_grant_revision_immutable BEFORE UPDATE OR DELETE ON world_package_grant_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_auth_retention_policy (
    tenant_id text NOT NULL, world_id text NOT NULL, policy_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    scope_id text NOT NULL, record jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,policy_id,revision)
);
CREATE INDEX world_auth_retention_policy_scope ON world_auth_retention_policy(tenant_id,world_id,scope_id,policy_id,revision);
CREATE TRIGGER world_auth_retention_policy_immutable BEFORE UPDATE OR DELETE ON world_auth_retention_policy FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_source_branch_capture (
    tenant_id text NOT NULL, world_id text NOT NULL, branch_id text NOT NULL, branch_revision bigint NOT NULL CHECK(branch_revision > 0),
    binding_id text NOT NULL, binding_revision bigint NOT NULL CHECK(binding_revision > 0), capture_digest text NOT NULL,
    compile_digest text NOT NULL, model_digest text NOT NULL, plan_digest text NOT NULL,
    source_id text NOT NULL, source_version_id text NOT NULL, body jsonb NOT NULL, raw jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,branch_id,branch_revision,binding_id,binding_revision,capture_digest),
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision) REFERENCES world_branch_revision,
    FOREIGN KEY(tenant_id,world_id,source_id,source_version_id) REFERENCES world_source_version(tenant_id,world_id,source_id,version_id)
);
CREATE TRIGGER world_source_branch_capture_immutable BEFORE UPDATE OR DELETE ON world_source_branch_capture FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_branch_identity_reservation (
    tenant_id text NOT NULL, world_id text NOT NULL, reservation_digest text NOT NULL CHECK(reservation_digest ~ '^sha256:[0-9a-f]{64}$'),
    branch_id text NOT NULL, branch_revision bigint NOT NULL CHECK(branch_revision > 0),
    source_id text NOT NULL, namespace text NOT NULL, native_key text NOT NULL, incarnation text NOT NULL,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    type_id text NOT NULL, type_revision bigint NOT NULL CHECK(type_revision > 0),
    subject_kind text NOT NULL CHECK(subject_kind IN ('object','relation')), subject_id text NOT NULL,
    body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,reservation_digest),
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision) REFERENCES world_branch_revision,
    CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns)
);
CREATE INDEX world_branch_identity_lookup ON world_branch_identity_reservation(tenant_id,world_id,branch_id,branch_revision,subject_kind,subject_id);
CREATE TRIGGER world_branch_identity_reservation_immutable BEFORE UPDATE OR DELETE ON world_branch_identity_reservation FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_branch_identity_promotion (
    tenant_id text NOT NULL, world_id text NOT NULL, reservation_digest text NOT NULL,
    target_kind text NOT NULL CHECK(target_kind IN ('object','relation')), target_id text NOT NULL, body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,reservation_digest),
    FOREIGN KEY(tenant_id,world_id,reservation_digest) REFERENCES world_branch_identity_reservation
);
CREATE TRIGGER world_branch_identity_promotion_immutable BEFORE UPDATE OR DELETE ON world_branch_identity_promotion FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TABLE world_source_branch_authority (
    tenant_id text NOT NULL, world_id text NOT NULL, branch_id text NOT NULL, branch_revision bigint NOT NULL CHECK(branch_revision > 0),
    policy_id text NOT NULL, authority_revision bigint NOT NULL CHECK(authority_revision > 0),
    binding_id text NOT NULL, binding_revision bigint NOT NULL CHECK(binding_revision > 0), body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,branch_id,branch_revision,policy_id,authority_revision),
    FOREIGN KEY(tenant_id,world_id,branch_id,branch_revision) REFERENCES world_branch_revision
);
CREATE TRIGGER world_source_branch_authority_immutable BEFORE UPDATE OR DELETE ON world_source_branch_authority FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
