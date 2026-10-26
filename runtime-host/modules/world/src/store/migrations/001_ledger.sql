CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE world_storage_identity (
    singleton boolean PRIMARY KEY CHECK(singleton), storage_id text NOT NULL UNIQUE CHECK(length(storage_id) BETWEEN 1 AND 256)
);
CREATE TABLE world_storage_head (
    tenant_id text NOT NULL, world_id text NOT NULL,
    storage_id text NOT NULL, writer_epoch bigint NOT NULL CHECK(writer_epoch > 0),
    mode text NOT NULL CHECK(mode IN ('active','fenced','prepared','retired')),
    transfer_id text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id), FOREIGN KEY(storage_id) REFERENCES world_storage_identity(storage_id)
);
CREATE TABLE world_writer_gate (
    tenant_id text NOT NULL, world_id text NOT NULL, domain text NOT NULL,
    writer_epoch bigint NOT NULL CHECK(writer_epoch > 0),
    mode text NOT NULL CHECK(mode IN ('active','fenced','retired')),
    reason_code text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,domain),
    FOREIGN KEY(tenant_id,world_id) REFERENCES world_storage_head
);
CREATE TABLE world_commit_receipt (
    tenant_id text NOT NULL, world_id text NOT NULL, commit_id text NOT NULL,
    input_digest text NOT NULL CHECK(input_digest ~ '^sha256:[0-9a-f]{64}$'),
    receipt jsonb, result jsonb, committed_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,commit_id),
    CHECK((receipt IS NULL AND result IS NULL AND committed_at IS NULL) OR
          (receipt IS NOT NULL AND result IS NOT NULL AND committed_at IS NOT NULL))
);
-- A receipt reservation may be incomplete inside a transaction, never after COMMIT.
CREATE FUNCTION world_check_commit_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS(SELECT 1 FROM world_commit_receipt WHERE tenant_id=NEW.tenant_id AND world_id=NEW.world_id AND commit_id=NEW.commit_id AND receipt IS NULL) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_commit_complete', MESSAGE='incomplete commit receipt';
    END IF;
    RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER world_commit_complete AFTER INSERT OR UPDATE ON world_commit_receipt
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION world_check_commit_receipt();
CREATE TABLE world_outbox_counter (
    tenant_id text NOT NULL, world_id text NOT NULL, last_sequence bigint NOT NULL CHECK(last_sequence >= 0),
    PRIMARY KEY(tenant_id,world_id), FOREIGN KEY(tenant_id,world_id) REFERENCES world_storage_head
);
CREATE TABLE world_outbox (
    tenant_id text NOT NULL, world_id text NOT NULL, event_id text NOT NULL,
    sequence bigint NOT NULL,
    aggregate_kind text NOT NULL, aggregate_id text NOT NULL, aggregate_revision bigint NOT NULL CHECK(aggregate_revision >= 0),
    event_kind text NOT NULL, payload jsonb NOT NULL, causation_id text, origin text NOT NULL,
    state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','claimed','delivered','dead_letter')),
    claim_token text, claim_epoch bigint NOT NULL DEFAULT 0 CHECK(claim_epoch >= 0),
    claimed_by text, lease_until timestamptz, attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    due_at timestamptz NOT NULL DEFAULT clock_timestamp(), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivered_at timestamptz, failure_code text, failure_stage text,
    PRIMARY KEY(tenant_id,world_id,event_id), UNIQUE(tenant_id,world_id,sequence)
);
CREATE INDEX world_outbox_due ON world_outbox(tenant_id,world_id,due_at,sequence) WHERE state IN ('pending','claimed');
CREATE INDEX world_outbox_aggregate ON world_outbox(tenant_id,world_id,aggregate_kind,aggregate_id,sequence);
CREATE TABLE world_operation (
    tenant_id text NOT NULL, world_id text NOT NULL, operation_id text NOT NULL,
    kind text NOT NULL, request_id text NOT NULL, input_digest text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), phase text NOT NULL,
    actor_id text NOT NULL, branch_id text, writer_domain text NOT NULL, writer_epoch bigint NOT NULL CHECK(writer_epoch > 0),
    body jsonb NOT NULL, failure jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), terminal_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,operation_id), UNIQUE(tenant_id,world_id,kind,request_id)
);
CREATE INDEX world_operation_recovery ON world_operation(tenant_id,world_id,kind,phase,updated_at) WHERE terminal_at IS NULL;
CREATE TABLE world_run (
    tenant_id text NOT NULL, world_id text NOT NULL, run_id text NOT NULL, operation_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), kind text NOT NULL, phase text NOT NULL,
    activation_lock_id text, release_id text, branch_id text, basis jsonb NOT NULL,
    budget jsonb NOT NULL, usage jsonb NOT NULL, body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), terminal_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,run_id),
    FOREIGN KEY(tenant_id,world_id,operation_id) REFERENCES world_operation
);
CREATE TABLE world_step (
    tenant_id text NOT NULL, world_id text NOT NULL, run_id text NOT NULL, step_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), ordinal integer NOT NULL CHECK(ordinal >= 0),
    kind text NOT NULL, phase text NOT NULL, input_digest text NOT NULL,
    writer_epoch bigint NOT NULL CHECK(writer_epoch > 0), attempt integer NOT NULL CHECK(attempt >= 0),
    body jsonb NOT NULL, result jsonb, failure jsonb, due_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,run_id,step_id), UNIQUE(tenant_id,world_id,run_id,ordinal),
    FOREIGN KEY(tenant_id,world_id,run_id) REFERENCES world_run
);
CREATE INDEX world_step_material_binding ON world_step(tenant_id,world_id,(result #>> '{binding,reference,id}'),(result #>> '{binding,reference,revision}'),(result #>> '{binding,reference,digest}'),run_id,step_id) WHERE kind='materials.binding' AND phase='completed';
CREATE TABLE world_storage_transfer (
    tenant_id text NOT NULL, world_id text NOT NULL, transfer_id text NOT NULL,
    source_storage_id text NOT NULL, target_storage_id text NOT NULL,
    source_epoch bigint NOT NULL CHECK(source_epoch > 0), target_epoch bigint NOT NULL CHECK(target_epoch > source_epoch),
    phase text NOT NULL CHECK(phase IN ('draining','cut','exported','importing','validated','activated','retired','aborted')),
    manifest_digest text, manifest jsonb, receipt jsonb, import_xid xid8,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,transfer_id)
);
-- Only this exact prepared import transaction can restore historical admission/index rows.
CREATE FUNCTION world_is_prepared_import(t text,w text) RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT EXISTS(SELECT 1 FROM world_storage_head h JOIN world_storage_transfer x
        ON x.tenant_id=h.tenant_id AND x.world_id=h.world_id AND x.transfer_id=h.transfer_id
        WHERE h.tenant_id=t AND h.world_id=w AND h.mode='prepared' AND x.phase='importing'
        AND x.import_xid=pg_current_xact_id())
$$;
CREATE FUNCTION world_allocate_outbox_sequence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF world_is_prepared_import(NEW.tenant_id,NEW.world_id) THEN
        IF NEW.sequence IS NULL OR NEW.sequence <= 0 THEN
            RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_outbox_sequence', MESSAGE='invalid imported event sequence';
        END IF;
        INSERT INTO world_outbox_counter(tenant_id,world_id,last_sequence) VALUES(NEW.tenant_id,NEW.world_id,NEW.sequence)
            ON CONFLICT(tenant_id,world_id) DO UPDATE SET last_sequence=GREATEST(world_outbox_counter.last_sequence,excluded.last_sequence);
    ELSE
        IF NEW.sequence IS NOT NULL THEN
            RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_outbox_sequence', MESSAGE='event sequence is allocated by storage';
        END IF;
        INSERT INTO world_outbox_counter(tenant_id,world_id,last_sequence) VALUES(NEW.tenant_id,NEW.world_id,1)
            ON CONFLICT(tenant_id,world_id) DO UPDATE SET last_sequence=world_outbox_counter.last_sequence+1
            RETURNING last_sequence INTO NEW.sequence;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER world_outbox_sequence BEFORE INSERT ON world_outbox FOR EACH ROW EXECUTE FUNCTION world_allocate_outbox_sequence();
CREATE TABLE world_restore_barrier (
    tenant_id text NOT NULL, world_id text NOT NULL, barrier_id text NOT NULL,
    kind text NOT NULL CHECK(kind IN ('revocation','deletion','effect_reconciliation')),
    resource_kind text NOT NULL, resource_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,barrier_id)
);

CREATE FUNCTION world_immutable_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_immutable_revision', MESSAGE='immutable world revision';
END $$;
CREATE TRIGGER world_storage_identity_immutable BEFORE UPDATE OR DELETE ON world_storage_identity FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
