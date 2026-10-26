CREATE TABLE world_source_schema_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    schema_id text NOT NULL, schema_digest text NOT NULL, body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,source_id,revision), UNIQUE(tenant_id,world_id,schema_id,revision)
);
CREATE TABLE world_schema_mapping_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, mapping_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    source_id text NOT NULL, source_schema_revision bigint NOT NULL, content_digest text NOT NULL,
    scope_id text NOT NULL, scope_revision bigint NOT NULL DEFAULT 1 CHECK(scope_revision=1),
    body jsonb NOT NULL, PRIMARY KEY(tenant_id,world_id,mapping_id,revision),
    FOREIGN KEY(tenant_id,world_id,scope_id,scope_revision) REFERENCES world_scope_revision,
    FOREIGN KEY(tenant_id,world_id,source_id,source_schema_revision) REFERENCES world_source_schema_revision
);
CREATE TABLE world_source_binding_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, binding_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    source_id text NOT NULL, source_incarnation text NOT NULL, connection_id text NOT NULL,
    connection_revision bigint NOT NULL CHECK(connection_revision > 0), mapping_id text NOT NULL, mapping_revision bigint NOT NULL,
    authority_policy_id text NOT NULL, authority_revision bigint NOT NULL, scope_id text NOT NULL,
    content_digest text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(tenant_id,world_id,binding_id,revision),
    FOREIGN KEY(tenant_id,world_id,mapping_id,mapping_revision) REFERENCES world_schema_mapping_revision
);
CREATE TABLE world_source_binding_head (
    tenant_id text NOT NULL, world_id text NOT NULL, binding_id text NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,binding_id), FOREIGN KEY(tenant_id,world_id,binding_id,revision) REFERENCES world_source_binding_revision
);
CREATE TABLE world_source_authority_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, policy_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    source_id text NOT NULL, binding_id text NOT NULL, binding_revision bigint NOT NULL, scope_id text NOT NULL,
    valid_from timestamptz NOT NULL, valid_to timestamptz,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    status text NOT NULL CHECK(status IN ('proposed','approved','revoked')),
    body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,policy_id,revision), CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns),
    CHECK((valid_to IS NULL) = (valid_to_ns IS NULL))
);
CREATE TABLE world_source_authority_head (
    tenant_id text NOT NULL, world_id text NOT NULL, policy_id text NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,policy_id), FOREIGN KEY(tenant_id,world_id,policy_id,revision) REFERENCES world_source_authority_revision
);
CREATE TABLE world_source_authority_field (
    tenant_id text NOT NULL, world_id text NOT NULL, policy_id text NOT NULL, revision bigint NOT NULL,
    property_id text NOT NULL, property_revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,policy_id,revision,property_id),
    FOREIGN KEY(tenant_id,world_id,policy_id,revision) REFERENCES world_source_authority_revision,
    FOREIGN KEY(tenant_id,world_id,property_id,property_revision) REFERENCES world_definition_revision
);
CREATE TABLE world_source_authority_role (
    tenant_id text NOT NULL, world_id text NOT NULL, policy_id text NOT NULL, revision bigint NOT NULL,
    relation_type_id text NOT NULL, relation_type_revision bigint NOT NULL, role_id text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,policy_id,revision,relation_type_id,role_id),
    FOREIGN KEY(tenant_id,world_id,policy_id,revision) REFERENCES world_source_authority_revision,
    FOREIGN KEY(tenant_id,world_id,relation_type_id,relation_type_revision) REFERENCES world_definition_revision
);
CREATE TABLE world_source_partition (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, partition_key text NOT NULL,
    source_incarnation text NOT NULL, binding_id text NOT NULL, binding_revision bigint NOT NULL,
    partition_epoch bigint NOT NULL CHECK(partition_epoch > 0), state text NOT NULL,
    checkpoint_format text NOT NULL, reader_stopped boolean NOT NULL, ack_stopped boolean NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,source_id,partition_key),
    FOREIGN KEY(tenant_id,world_id,binding_id,binding_revision) REFERENCES world_source_binding_revision
);
CREATE TABLE world_source_inbox (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, partition_key text NOT NULL,
    partition_epoch bigint NOT NULL CHECK(partition_epoch > 0), event_id text NOT NULL, input_digest text NOT NULL,
    sequence bigint NOT NULL CHECK(sequence >= 0), transaction_id text, transaction_complete boolean NOT NULL,
    checkpoint_format text NOT NULL, position jsonb NOT NULL, body jsonb NOT NULL,
    status text NOT NULL CHECK(status IN ('captured','applied','quarantined','skipped')),
    applied_commit_id text, captured_at timestamptz NOT NULL DEFAULT clock_timestamp(), applied_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,source_id,partition_key,event_id),
    UNIQUE(tenant_id,world_id,source_id,partition_key,partition_epoch,sequence),
    FOREIGN KEY(tenant_id,world_id,source_id,partition_key) REFERENCES world_source_partition
);
CREATE INDEX world_source_inbox_pending ON world_source_inbox(tenant_id,world_id,source_id,partition_key,sequence) WHERE status='captured';
CREATE TABLE world_source_checkpoint (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, partition_key text NOT NULL,
    partition_epoch bigint NOT NULL CHECK(partition_epoch > 0), revision bigint NOT NULL CHECK(revision > 0),
    checkpoint_format text NOT NULL, captured jsonb, applied jsonb, acknowledged jsonb, projected jsonb,
    captured_sequence bigint, applied_sequence bigint, acknowledged_sequence bigint, projected_sequence bigint,
    gap jsonb, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,source_id,partition_key),
    FOREIGN KEY(tenant_id,world_id,source_id,partition_key) REFERENCES world_source_partition
);
CREATE TABLE world_source_handoff (
    tenant_id text NOT NULL, world_id text NOT NULL, handoff_id text NOT NULL, source_id text NOT NULL, partition_key text NOT NULL,
    source_epoch bigint NOT NULL, target_epoch bigint NOT NULL CHECK(target_epoch > source_epoch), phase text NOT NULL,
    from_binding_id text NOT NULL, from_binding_revision bigint NOT NULL, to_binding_id text NOT NULL, to_binding_revision bigint NOT NULL,
    checkpoint jsonb NOT NULL, queued_ack jsonb NOT NULL, retained_contracts jsonb NOT NULL, receipt jsonb,
    PRIMARY KEY(tenant_id,world_id,handoff_id)
);
CREATE TABLE world_source_reconcile (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, partition_key text NOT NULL,
    run_id text NOT NULL, phase text NOT NULL, basis jsonb NOT NULL, coverage jsonb NOT NULL,
    last_key text, last_reconciled_at timestamptz, failure jsonb,
    PRIMARY KEY(tenant_id,world_id,source_id,partition_key,run_id)
);
