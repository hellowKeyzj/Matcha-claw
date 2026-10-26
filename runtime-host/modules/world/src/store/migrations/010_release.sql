CREATE TABLE world_artifact_manifest (
    tenant_id text NOT NULL, world_id text NOT NULL, artifact_id text NOT NULL,
    release_id text NOT NULL, activation_lock_id text NOT NULL, config_digest text NOT NULL,
    ir_version text NOT NULL, content_digest text NOT NULL, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,artifact_id), UNIQUE(tenant_id,world_id,content_digest),
    FOREIGN KEY(tenant_id,world_id,activation_lock_id) REFERENCES world_activation_lock
);
CREATE TABLE world_compile_dependency (
    tenant_id text NOT NULL, world_id text NOT NULL, artifact_id text NOT NULL,
    dependent_id text NOT NULL, dependent_revision bigint NOT NULL, ordinal integer NOT NULL,
    target_kind text NOT NULL, target_id text NOT NULL, target_revision bigint, usage text NOT NULL, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,artifact_id,dependent_id,dependent_revision,ordinal),
    FOREIGN KEY(tenant_id,world_id,artifact_id) REFERENCES world_artifact_manifest
);
CREATE INDEX world_compile_dependency_reverse ON world_compile_dependency(tenant_id,world_id,target_kind,target_id,target_revision);
CREATE TABLE world_release (
    tenant_id text NOT NULL, world_id text NOT NULL, release_id text NOT NULL,
    parent_release_id text, artifact_id text NOT NULL, activation_lock_id text NOT NULL,
    content_digest text NOT NULL, model_digest text NOT NULL, body jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,world_id,release_id),
    FOREIGN KEY(tenant_id,world_id,parent_release_id) REFERENCES world_release,
    FOREIGN KEY(tenant_id,world_id,artifact_id) REFERENCES world_artifact_manifest
);
CREATE TABLE world_release_head (
    tenant_id text NOT NULL, world_id text NOT NULL, channel text NOT NULL,
    generation bigint NOT NULL CHECK(generation > 0), revision bigint NOT NULL CHECK(revision > 0), release_id text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,channel), FOREIGN KEY(tenant_id,world_id,release_id) REFERENCES world_release
);
CREATE TABLE world_release_backfill (
    tenant_id text NOT NULL, world_id text NOT NULL, release_id text NOT NULL, partition_key text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), phase text NOT NULL, checkpoint jsonb NOT NULL,
    writer_domain text NOT NULL, writer_epoch bigint NOT NULL CHECK(writer_epoch > 0), failure jsonb,
    PRIMARY KEY(tenant_id,world_id,release_id,partition_key), FOREIGN KEY(tenant_id,world_id,release_id) REFERENCES world_release
);
CREATE TABLE world_branch (
    tenant_id text NOT NULL, world_id text NOT NULL, branch_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), base_release_id text NOT NULL, activation_lock_id text NOT NULL,
    basis_digest text NOT NULL, replayability text NOT NULL, status text NOT NULL,
    actor_id text NOT NULL, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,branch_id), FOREIGN KEY(tenant_id,world_id,base_release_id) REFERENCES world_release,
    FOREIGN KEY(tenant_id,world_id,activation_lock_id) REFERENCES world_activation_lock
);
CREATE TABLE world_change_set (
    tenant_id text NOT NULL, world_id text NOT NULL, change_set_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    branch_id text NOT NULL, base_release_id text NOT NULL, content_digest text NOT NULL, status text NOT NULL,
    actor_id text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(tenant_id,world_id,change_set_id,revision),
    FOREIGN KEY(tenant_id,world_id,branch_id) REFERENCES world_branch
);
CREATE TABLE world_candidate (
    tenant_id text NOT NULL, world_id text NOT NULL, candidate_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    task_id text NOT NULL, task_revision bigint NOT NULL, branch_id text NOT NULL, content_digest text NOT NULL,
    status text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(tenant_id,world_id,candidate_id),
    FOREIGN KEY(tenant_id,world_id,task_id,task_revision) REFERENCES world_task_revision,
    FOREIGN KEY(tenant_id,world_id,branch_id) REFERENCES world_branch
);
