CREATE TABLE world_scope_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, scope_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    content_digest text NOT NULL, body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,scope_id,revision)
);
CREATE TABLE world_definition_identity (
    tenant_id text NOT NULL, world_id text NOT NULL, definition_id text NOT NULL, kind text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,definition_id), UNIQUE(tenant_id,world_id,definition_id,kind)
);
CREATE TABLE world_definition_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, definition_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    kind text NOT NULL, scope_id text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    content_digest text NOT NULL, previous_revision bigint, lifecycle text NOT NULL, body jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,definition_id,revision), CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns),
    CHECK((valid_to IS NULL) = (valid_to_ns IS NULL)),
    FOREIGN KEY(tenant_id,world_id,definition_id,kind) REFERENCES world_definition_identity(tenant_id,world_id,definition_id,kind),
    FOREIGN KEY(tenant_id,world_id,definition_id,previous_revision) REFERENCES world_definition_revision
);
CREATE INDEX world_definition_kind_scope ON world_definition_revision(tenant_id,world_id,kind,scope_id,definition_id,revision);
CREATE TABLE world_definition_head (
    tenant_id text NOT NULL, world_id text NOT NULL, definition_id text NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,definition_id),
    FOREIGN KEY(tenant_id,world_id,definition_id,revision) REFERENCES world_definition_revision
);
CREATE TABLE world_definition_dependency (
    tenant_id text NOT NULL, world_id text NOT NULL, definition_id text NOT NULL, revision bigint NOT NULL,
    dependency_id text NOT NULL, dependency_revision bigint NOT NULL, usage text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,definition_id,revision,dependency_id,dependency_revision,usage),
    FOREIGN KEY(tenant_id,world_id,definition_id,revision) REFERENCES world_definition_revision,
    FOREIGN KEY(tenant_id,world_id,dependency_id,dependency_revision) REFERENCES world_definition_revision
);
CREATE INDEX world_definition_dependency_reverse ON world_definition_dependency(tenant_id,world_id,dependency_id,dependency_revision);
CREATE TABLE world_definition_lineage (
    tenant_id text NOT NULL, world_id text NOT NULL, definition_id text NOT NULL, revision bigint NOT NULL,
    target_id text NOT NULL, target_revision bigint NOT NULL, kind text NOT NULL CHECK(kind IN ('previous','replacement','split')),
    PRIMARY KEY(tenant_id,world_id,definition_id,revision,target_id,target_revision,kind),
    FOREIGN KEY(tenant_id,world_id,definition_id,revision) REFERENCES world_definition_revision,
    FOREIGN KEY(tenant_id,world_id,target_id,target_revision) REFERENCES world_definition_revision
);
CREATE TABLE world_kind_registration (
    tenant_id text NOT NULL, world_id text NOT NULL, contract_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    contract_version text NOT NULL, schema_digest text NOT NULL, provider_id text NOT NULL, package_digest text NOT NULL,
    status text NOT NULL, body jsonb NOT NULL, PRIMARY KEY(tenant_id,world_id,contract_id,revision)
);
CREATE TABLE world_object_identity (
    tenant_id text NOT NULL, world_id text NOT NULL, object_id text NOT NULL, type_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,object_id)
);
CREATE TABLE world_relation_identity (
    tenant_id text NOT NULL, world_id text NOT NULL, relation_id text NOT NULL, type_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,relation_id)
);
CREATE TABLE world_identity_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, subject_kind text NOT NULL CHECK(subject_kind IN ('object','relation')),
    subject_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0), type_id text NOT NULL,
    actor_id text NOT NULL, admission jsonb NOT NULL, body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,subject_kind,subject_id,revision)
);
CREATE TABLE world_identity_influence (
    tenant_id text NOT NULL, world_id text NOT NULL, subject_kind text NOT NULL, subject_id text NOT NULL,
    generation bigint NOT NULL DEFAULT 1 CHECK(generation > 0), PRIMARY KEY(tenant_id,world_id,subject_kind,subject_id)
);
CREATE TABLE world_alias_range (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, namespace text NOT NULL, native_key text NOT NULL,
    range_digest text NOT NULL, generation bigint NOT NULL DEFAULT 1 CHECK(generation > 0),
    PRIMARY KEY(tenant_id,world_id,source_id,namespace,native_key), UNIQUE(tenant_id,world_id,range_digest)
);
CREATE TABLE world_source_alias_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, namespace text NOT NULL, native_key text NOT NULL,
    incarnation text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    revision bigint NOT NULL CHECK(revision > 0), target_kind text NOT NULL CHECK(target_kind IN ('object','relation')), target_id text NOT NULL,
    supersedes_revision bigint, evidence jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from_ns,revision),
    CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns),
    CHECK((valid_to IS NULL) = (valid_to_ns IS NULL))
);
CREATE TABLE world_source_alias_current (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, namespace text NOT NULL, native_key text NOT NULL,
    incarnation text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    revision bigint NOT NULL, target_kind text NOT NULL CHECK(target_kind IN ('object','relation')), target_id text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from_ns),
    CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns),
    CHECK((valid_to IS NULL) = (valid_to_ns IS NULL)),
    FOREIGN KEY(tenant_id,world_id,source_id,namespace,native_key,incarnation,valid_from_ns,revision) REFERENCES world_source_alias_revision,
    CONSTRAINT world_source_alias_overlap EXCLUDE USING gist
        (tenant_id WITH =, world_id WITH =, source_id WITH =, namespace WITH =, native_key WITH =,
         numrange(valid_from_ns,valid_to_ns,'[)') WITH &&)
);
CREATE INDEX world_source_alias_target ON world_source_alias_current(tenant_id,world_id,target_kind,target_id);
CREATE TABLE world_identity_resolution (
    tenant_id text NOT NULL, world_id text NOT NULL, operation_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    kind text NOT NULL CHECK(kind IN ('merge','split')), scope_id text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    actor_id text NOT NULL, commit_id text NOT NULL, admission jsonb NOT NULL, evidence jsonb NOT NULL, expected_refs jsonb NOT NULL,
    body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,operation_id,revision), CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns),
    CHECK((valid_to IS NULL) = (valid_to_ns IS NULL))
);
CREATE TABLE world_identity_resolution_member (
    tenant_id text NOT NULL, world_id text NOT NULL, operation_id text NOT NULL, revision bigint NOT NULL,
    source_kind text NOT NULL, source_id text NOT NULL, target_kind text NOT NULL, target_id text NOT NULL,
    impact_kind text NOT NULL, impact_id text NOT NULL, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,operation_id,revision,source_kind,source_id,target_kind,target_id,impact_kind,impact_id),
    FOREIGN KEY(tenant_id,world_id,operation_id,revision) REFERENCES world_identity_resolution
);
CREATE INDEX world_identity_resolution_lookup ON world_identity_resolution_member(tenant_id,world_id,source_kind,source_id);
