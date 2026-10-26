CREATE TABLE world_blob (
    tenant_id text NOT NULL, world_id text NOT NULL, digest text NOT NULL CHECK(digest ~ '^sha256:[0-9a-f]{64}$'),
    byte_size bigint NOT NULL CHECK(byte_size >= 0),
    state text NOT NULL DEFAULT 'live' CHECK(state IN ('live','deleting','deleted')),
    generation bigint NOT NULL DEFAULT 1 CHECK(generation > 0), claim_token text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), deleted_at timestamptz,
    CHECK((state='deleting') = (claim_token IS NOT NULL)),
    PRIMARY KEY(tenant_id,world_id,digest)
);
CREATE TABLE world_blob_pin (
    tenant_id text NOT NULL, world_id text NOT NULL, digest text NOT NULL, pin_id text NOT NULL,
    kind text NOT NULL CHECK(kind IN ('upload','read','recovery','backup','transfer')),
    owner_id text NOT NULL, generation bigint NOT NULL CHECK(generation > 0),
    expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,digest,pin_id),
    FOREIGN KEY(tenant_id,world_id,digest) REFERENCES world_blob
);
CREATE INDEX world_blob_pin_live ON world_blob_pin(tenant_id,world_id,digest) WHERE released_at IS NULL;
CREATE TABLE world_source_version (
    tenant_id text NOT NULL, world_id text NOT NULL, source_id text NOT NULL, version_id text NOT NULL,
    blob_digest text NOT NULL, media_type text NOT NULL, captured_at timestamptz NOT NULL,
    origin_family text NOT NULL, supersedes_source_id text, supersedes_version_id text,
    access_policy_id text NOT NULL, access_policy_revision bigint NOT NULL CHECK(access_policy_revision > 0),
    retention_policy_id text NOT NULL, retention_policy_revision bigint NOT NULL CHECK(retention_policy_revision > 0),
    body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,source_id,version_id),
    FOREIGN KEY(tenant_id,world_id,blob_digest) REFERENCES world_blob,
    FOREIGN KEY(tenant_id,world_id,supersedes_source_id,supersedes_version_id) REFERENCES world_source_version
);
CREATE INDEX world_source_version_history ON world_source_version(tenant_id,world_id,source_id,captured_at,version_id);
CREATE TABLE world_parse_artifact (
    tenant_id text NOT NULL, world_id text NOT NULL, artifact_id text NOT NULL,
    source_id text NOT NULL, source_version_id text NOT NULL, parse_run_id text NOT NULL,
    parser_fingerprint text NOT NULL, options_digest text NOT NULL, manifest_digest text NOT NULL,
    body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,artifact_id),
    FOREIGN KEY(tenant_id,world_id,source_id,source_version_id) REFERENCES world_source_version,
    FOREIGN KEY(tenant_id,world_id,manifest_digest) REFERENCES world_blob
);
CREATE INDEX world_parse_artifact_source ON world_parse_artifact(tenant_id,world_id,source_id,source_version_id,parser_fingerprint,options_digest);
CREATE TABLE world_content_reference (
    tenant_id text NOT NULL, world_id text NOT NULL, reference_id text NOT NULL,
    referrer_kind text NOT NULL, referrer_id text NOT NULL, referrer_revision bigint NOT NULL CHECK(referrer_revision >= 0),
    blob_digest text NOT NULL, purpose text NOT NULL, body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,reference_id),
    UNIQUE(tenant_id,world_id,referrer_kind,referrer_id,referrer_revision,blob_digest,purpose),
    FOREIGN KEY(tenant_id,world_id,blob_digest) REFERENCES world_blob
);
CREATE INDEX world_content_reference_live ON world_content_reference(tenant_id,world_id,blob_digest) WHERE released_at IS NULL;
CREATE TABLE world_content_hold (
    tenant_id text NOT NULL, world_id text NOT NULL, hold_id text NOT NULL, blob_digest text NOT NULL,
    kind text NOT NULL, owner_kind text NOT NULL, owner_id text NOT NULL, body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,hold_id),
    FOREIGN KEY(tenant_id,world_id,blob_digest) REFERENCES world_blob
);
CREATE INDEX world_content_hold_live ON world_content_hold(tenant_id,world_id,blob_digest) WHERE released_at IS NULL;
CREATE TABLE world_content_deletion (
    tenant_id text NOT NULL, world_id text NOT NULL, deletion_id text NOT NULL,
    blob_digest text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    state text NOT NULL CHECK(state IN ('barrier','claimed','deleted','failed')),
    actor_id text NOT NULL, reason_code text NOT NULL, claim_token text,
    failure_code text, failure_stage text, body jsonb NOT NULL,
    cleanup_targets jsonb NOT NULL DEFAULT '[]', cleanup_acks jsonb NOT NULL DEFAULT '[]',
    remaining integer NOT NULL CHECK(remaining >= 0), CHECK(state <> 'deleted' OR remaining=0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,deletion_id), UNIQUE(tenant_id,world_id,blob_digest),
    FOREIGN KEY(tenant_id,world_id,blob_digest) REFERENCES world_blob
);
CREATE INDEX world_content_deletion_pending ON world_content_deletion(tenant_id,world_id,state,created_at) WHERE completed_at IS NULL;
-- The database enforces the same blob-row admission lock for every reference/hold/pin producer.
CREATE FUNCTION world_admit_blob_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE blob_state text;
BEGIN
    IF world_is_prepared_import(NEW.tenant_id,NEW.world_id) THEN RETURN NEW; END IF;
    SELECT state INTO blob_state FROM world_blob WHERE tenant_id=NEW.tenant_id AND world_id=NEW.world_id
        AND digest=COALESCE(to_jsonb(NEW)->>'blob_digest',to_jsonb(NEW)->>'digest') FOR UPDATE;
    IF blob_state IS DISTINCT FROM 'live' OR EXISTS(
        SELECT 1 FROM world_content_deletion WHERE tenant_id=NEW.tenant_id AND world_id=NEW.world_id
        AND blob_digest=COALESCE(to_jsonb(NEW)->>'blob_digest',to_jsonb(NEW)->>'digest')
    ) THEN
        RAISE EXCEPTION USING ERRCODE='23514', CONSTRAINT='world_blob_admission', MESSAGE='blob is not available for reference';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER world_blob_pin_admission BEFORE INSERT ON world_blob_pin FOR EACH ROW EXECUTE FUNCTION world_admit_blob_reference();
CREATE TRIGGER world_content_reference_admission BEFORE INSERT ON world_content_reference FOR EACH ROW EXECUTE FUNCTION world_admit_blob_reference();
CREATE TRIGGER world_content_hold_admission BEFORE INSERT ON world_content_hold FOR EACH ROW EXECUTE FUNCTION world_admit_blob_reference();
CREATE TRIGGER world_source_version_immutable BEFORE UPDATE OR DELETE ON world_source_version FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_parse_artifact_immutable BEFORE UPDATE OR DELETE ON world_parse_artifact FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
