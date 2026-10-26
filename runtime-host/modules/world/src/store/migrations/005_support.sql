CREATE TABLE world_watch_partition (
    tenant_id text NOT NULL, world_id text NOT NULL, dataset_id text NOT NULL, partition_key text NOT NULL,
    generation bigint NOT NULL DEFAULT 1 CHECK(generation > 0),
    PRIMARY KEY(tenant_id,world_id,dataset_id,partition_key)
);
CREATE TABLE world_watch (
    tenant_id text NOT NULL, world_id text NOT NULL, watch_id text NOT NULL,
    dataset_id text NOT NULL, partition_key text NOT NULL, scope_id text NOT NULL,
    predicate_digest text NOT NULL, purpose text NOT NULL, coverage text NOT NULL,
    generation bigint NOT NULL CHECK(generation > 0), boundary_at timestamptz,
    valid_from timestamptz, valid_to timestamptz,
    valid_from_ns numeric CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,watch_id),
    FOREIGN KEY(tenant_id,world_id,dataset_id,partition_key) REFERENCES world_watch_partition,
    CHECK(valid_to_ns IS NULL OR valid_from_ns IS NULL OR valid_from_ns < valid_to_ns),
    CHECK((valid_from IS NULL) = (valid_from_ns IS NULL)), CHECK((valid_to IS NULL) = (valid_to_ns IS NULL))
);
CREATE INDEX world_watch_candidates ON world_watch(tenant_id,world_id,dataset_id,partition_key,scope_id);
CREATE INDEX world_watch_time_due ON world_watch(tenant_id,world_id,boundary_at,watch_id) WHERE boundary_at IS NOT NULL;
CREATE TABLE world_watch_field (
    tenant_id text NOT NULL, world_id text NOT NULL, watch_id text NOT NULL, field_id text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,watch_id,field_id), FOREIGN KEY(tenant_id,world_id,watch_id) REFERENCES world_watch
);
CREATE INDEX world_watch_field_candidates ON world_watch_field(tenant_id,world_id,field_id,watch_id);
CREATE TABLE world_watch_range (
    tenant_id text NOT NULL, world_id text NOT NULL, watch_id text NOT NULL, dataset_id text NOT NULL, partition_key text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,watch_id,dataset_id,partition_key),
    FOREIGN KEY(tenant_id,world_id,watch_id) REFERENCES world_watch,
    FOREIGN KEY(tenant_id,world_id,dataset_id,partition_key) REFERENCES world_watch_partition
);
CREATE INDEX world_watch_range_candidates ON world_watch_range(tenant_id,world_id,dataset_id,partition_key,watch_id);
CREATE TABLE world_support_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, support_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    conclusion_id text NOT NULL, conclusion_revision bigint NOT NULL,
    rule_id text NOT NULL, rule_revision bigint NOT NULL, scope_id text NOT NULL,
    release_id text NOT NULL, branch_id text,
    valid_from timestamptz NOT NULL, valid_to timestamptz,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    status text NOT NULL CHECK(status IN ('valid','invalid','pending')), dirty boolean NOT NULL,
    body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,support_id,revision), CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns),
    CHECK((valid_to IS NULL) = (valid_to_ns IS NULL)),
    FOREIGN KEY(tenant_id,world_id,conclusion_id,conclusion_revision) REFERENCES world_assertion_revision,
    FOREIGN KEY(tenant_id,world_id,rule_id,rule_revision) REFERENCES world_definition_revision
);
CREATE INDEX world_support_alternatives ON world_support_revision(tenant_id,world_id,conclusion_id,conclusion_revision,scope_id,release_id,branch_id,status);
CREATE INDEX world_support_rule_reverse ON world_support_revision(tenant_id,world_id,rule_id,rule_revision);
CREATE INDEX world_support_page ON world_support_revision(tenant_id,world_id,conclusion_id,conclusion_revision,scope_id,release_id,support_id);
CREATE TABLE world_support_head (
    tenant_id text NOT NULL, world_id text NOT NULL, support_id text NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,support_id), FOREIGN KEY(tenant_id,world_id,support_id,revision) REFERENCES world_support_revision
);
CREATE TABLE world_support_premise (
    tenant_id text NOT NULL, world_id text NOT NULL, support_id text NOT NULL, support_revision bigint NOT NULL,
    ordinal integer NOT NULL CHECK(ordinal >= 0),
    premise_kind text NOT NULL CHECK(premise_kind IN ('assertion','evidence','definition','watch','source','time_boundary','identity','alias_range','source_mapping','source_field')),
    premise_id text NOT NULL, premise_revision bigint, watch_generation bigint, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,support_id,support_revision,ordinal),
    FOREIGN KEY(tenant_id,world_id,support_id,support_revision) REFERENCES world_support_revision
);
CREATE INDEX world_support_premise_reverse ON world_support_premise(tenant_id,world_id,premise_kind,premise_id,premise_revision);
CREATE TABLE world_support_graph_guard (
    tenant_id text NOT NULL, world_id text NOT NULL, scope_id text NOT NULL, component_id text NOT NULL,
    generation bigint NOT NULL DEFAULT 1 CHECK(generation > 0), PRIMARY KEY(tenant_id,world_id,scope_id,component_id)
);
CREATE TABLE world_dirty_recompute (
    tenant_id text NOT NULL, world_id text NOT NULL, target_kind text NOT NULL, target_id text NOT NULL,
    dirty_generation bigint NOT NULL CHECK(dirty_generation > 0), actual_basis jsonb NOT NULL,
    writer_domain text NOT NULL, writer_epoch bigint NOT NULL CHECK(writer_epoch > 0),
    status text NOT NULL CHECK(status IN ('pending','claimed','completed','failed','cancelled')),
    attempt integer NOT NULL DEFAULT 0 CHECK(attempt >= 0), claim_token text, claimed_by text,
    lease_until timestamptz, due_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    reason_code text NOT NULL, failure jsonb, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,target_kind,target_id)
);
CREATE INDEX world_dirty_due ON world_dirty_recompute(tenant_id,world_id,due_at,target_kind,target_id) WHERE status IN ('pending','claimed');
CREATE TABLE world_recompute_attempt (
    tenant_id text NOT NULL, world_id text NOT NULL, target_kind text NOT NULL, target_id text NOT NULL,
    dirty_generation bigint NOT NULL, attempt integer NOT NULL, claim_token text NOT NULL,
    run_id text NOT NULL, writer_epoch bigint NOT NULL, actual_basis jsonb NOT NULL,
    state text NOT NULL, result jsonb, started_at timestamptz NOT NULL DEFAULT clock_timestamp(), terminal_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,target_kind,target_id,dirty_generation,attempt)
);
CREATE TABLE world_explanation_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, conclusion_id text NOT NULL, conclusion_revision bigint NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), dirty_generation bigint NOT NULL, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,conclusion_id,conclusion_revision,revision),
    FOREIGN KEY(tenant_id,world_id,conclusion_id,conclusion_revision) REFERENCES world_assertion_revision
);
