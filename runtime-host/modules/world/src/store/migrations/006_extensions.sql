CREATE TABLE world_package (
    tenant_id text NOT NULL, world_id text NOT NULL, publisher_id text NOT NULL, package_id text NOT NULL, version text NOT NULL,
    package_digest text NOT NULL, transport_digest text NOT NULL, manifest jsonb NOT NULL,
    manifest_bytes bytea NOT NULL, signature jsonb NOT NULL, trust_evidence jsonb NOT NULL,
    verified_files jsonb NOT NULL, target jsonb NOT NULL, trust_policy_revision bigint NOT NULL CHECK(trust_policy_revision > 0),
    verified_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,world_id,publisher_id,package_id,version),
    UNIQUE(tenant_id,world_id,package_digest)
);
CREATE TABLE world_package_install (
    tenant_id text NOT NULL, world_id text NOT NULL, install_id text NOT NULL, request_id text NOT NULL,
    input_digest text NOT NULL, operation_id text NOT NULL, package_digest text,
    revision bigint NOT NULL CHECK(revision > 0), phase text NOT NULL,
    desired_enabled boolean NOT NULL, pending_removal boolean NOT NULL DEFAULT false,
    install_lock jsonb, body jsonb NOT NULL, failure jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,install_id), UNIQUE(tenant_id,world_id,request_id),
    FOREIGN KEY(tenant_id,world_id,operation_id) REFERENCES world_operation,
    FOREIGN KEY(tenant_id,world_id,package_digest) REFERENCES world_package(tenant_id,world_id,package_digest)
);
CREATE INDEX world_package_install_recovery ON world_package_install(tenant_id,world_id,phase,pending_removal);
CREATE TABLE world_package_retention (
    tenant_id text NOT NULL, world_id text NOT NULL, package_digest text NOT NULL,
    owner_kind text NOT NULL, owner_id text NOT NULL, owner_revision bigint NOT NULL CHECK(owner_revision >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,package_digest,owner_kind,owner_id,owner_revision),
    FOREIGN KEY(tenant_id,world_id,package_digest) REFERENCES world_package(tenant_id,world_id,package_digest)
);
CREATE INDEX world_package_retention_live ON world_package_retention(tenant_id,world_id,package_digest) WHERE released_at IS NULL;
CREATE TABLE world_package_gc (
    tenant_id text NOT NULL, world_id text NOT NULL, package_digest text NOT NULL,
    generation bigint NOT NULL CHECK(generation > 0), state text NOT NULL CHECK(state IN ('live','claimed','pending_removal','removed')),
    claim_token text, failure_code text, failure_stage text,
    PRIMARY KEY(tenant_id,world_id,package_digest),
    FOREIGN KEY(tenant_id,world_id,package_digest) REFERENCES world_package(tenant_id,world_id,package_digest)
);
CREATE TABLE world_extension_config_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, install_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    config_digest text NOT NULL, body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,install_id,revision), FOREIGN KEY(tenant_id,world_id,install_id) REFERENCES world_package_install
);
CREATE TABLE world_extension_config_head (
    tenant_id text NOT NULL, world_id text NOT NULL, install_id text NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,install_id), FOREIGN KEY(tenant_id,world_id,install_id,revision) REFERENCES world_extension_config_revision
);
CREATE TABLE world_activation_lock (
    tenant_id text NOT NULL, world_id text NOT NULL, activation_lock_id text NOT NULL,
    content_digest text NOT NULL, graph jsonb NOT NULL, method_schemas jsonb NOT NULL,
    packages jsonb NOT NULL, basis jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,activation_lock_id), UNIQUE(tenant_id,world_id,content_digest)
);
CREATE TABLE world_binding_head (
    tenant_id text NOT NULL, world_id text NOT NULL, channel text NOT NULL,
    generation bigint NOT NULL CHECK(generation > 0), revision bigint NOT NULL CHECK(revision > 0), activation_lock_id text NOT NULL,
    body jsonb NOT NULL, published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,channel),
    FOREIGN KEY(tenant_id,world_id,activation_lock_id) REFERENCES world_activation_lock
);
CREATE TABLE world_binding_channel (
    tenant_id text NOT NULL, world_id text NOT NULL, binding_id text NOT NULL, channel text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,binding_id), FOREIGN KEY(tenant_id,world_id,channel) REFERENCES world_binding_head
);
CREATE TABLE world_state_root (
    tenant_id text NOT NULL, world_id text NOT NULL, state_root_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    namespace_id text NOT NULL, state_epoch bigint NOT NULL CHECK(state_epoch > 0),
    schema_digest text NOT NULL, content_digest text NOT NULL, body jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,world_id,state_root_id,revision)
);
CREATE TABLE world_state_namespace (
    tenant_id text NOT NULL, world_id text NOT NULL, namespace_id text NOT NULL, install_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), state_epoch bigint NOT NULL CHECK(state_epoch > 0),
    state_root_id text NOT NULL, state_root_revision bigint NOT NULL,
    schema_digest text NOT NULL, writer_domain text NOT NULL, writer_epoch bigint NOT NULL CHECK(writer_epoch > 0),
    PRIMARY KEY(tenant_id,world_id,namespace_id),
    FOREIGN KEY(tenant_id,world_id,install_id) REFERENCES world_package_install,
    FOREIGN KEY(tenant_id,world_id,state_root_id,state_root_revision) REFERENCES world_state_root
);
CREATE TABLE world_extension_update (
    tenant_id text NOT NULL, world_id text NOT NULL, update_id text NOT NULL, operation_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), from_lock_id text, to_lock_id text,
    phase text NOT NULL, affected_domains jsonb NOT NULL, checkpoints jsonb NOT NULL,
    effect_handoff jsonb NOT NULL, body jsonb NOT NULL, failure jsonb,
    PRIMARY KEY(tenant_id,world_id,update_id), FOREIGN KEY(tenant_id,world_id,operation_id) REFERENCES world_operation
);
CREATE TABLE world_state_migration (
    tenant_id text NOT NULL, world_id text NOT NULL, migration_id text NOT NULL,
    namespace_id text NOT NULL, source_epoch bigint NOT NULL, target_epoch bigint NOT NULL CHECK(target_epoch > source_epoch),
    source_root_id text NOT NULL, source_root_revision bigint NOT NULL, target_root_id text, target_root_revision bigint,
    phase text NOT NULL, checkpoint jsonb NOT NULL, receipt jsonb, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,migration_id),
    FOREIGN KEY(tenant_id,world_id,namespace_id) REFERENCES world_state_namespace
);
CREATE TABLE world_extension_trust (
    tenant_id text NOT NULL, world_id text NOT NULL, package_digest text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), trusted boolean NOT NULL, quarantined boolean NOT NULL,
    policy_id text NOT NULL, policy_revision bigint NOT NULL, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,package_digest),
    FOREIGN KEY(tenant_id,world_id,package_digest) REFERENCES world_package(tenant_id,world_id,package_digest)
);
