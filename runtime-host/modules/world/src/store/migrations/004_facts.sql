CREATE TABLE world_evidence_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, evidence_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    source_id text NOT NULL, source_version_id text NOT NULL, parse_artifact_id text,
    locator_kind text NOT NULL, origin_family text NOT NULL, observed_at timestamptz NOT NULL,
    digest text, status text NOT NULL CHECK(status IN ('active','withdrawn','content_deleted')),
    availability text NOT NULL CHECK(availability IN ('available','unavailable')),
    access_policy_id text NOT NULL, access_policy_revision bigint NOT NULL CHECK(access_policy_revision > 0),
    retention_policy_id text NOT NULL, retention_policy_revision bigint NOT NULL CHECK(retention_policy_revision > 0),
    body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,evidence_id,revision),
    FOREIGN KEY(tenant_id,world_id,source_id,source_version_id) REFERENCES world_source_version,
    FOREIGN KEY(tenant_id,world_id,parse_artifact_id) REFERENCES world_parse_artifact
);
CREATE TABLE world_evidence_head (
    tenant_id text NOT NULL, world_id text NOT NULL, evidence_id text NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,evidence_id), FOREIGN KEY(tenant_id,world_id,evidence_id,revision) REFERENCES world_evidence_revision
);
CREATE INDEX world_evidence_source ON world_evidence_revision(tenant_id,world_id,source_id,source_version_id,status);
CREATE INDEX world_evidence_origin ON world_evidence_revision(tenant_id,world_id,origin_family,evidence_id,revision);
CREATE TABLE world_evidence_derived_from (
    tenant_id text NOT NULL, world_id text NOT NULL, evidence_id text NOT NULL, revision bigint NOT NULL,
    parent_id text NOT NULL, parent_revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,evidence_id,revision,parent_id,parent_revision),
    FOREIGN KEY(tenant_id,world_id,evidence_id,revision) REFERENCES world_evidence_revision,
    FOREIGN KEY(tenant_id,world_id,parent_id,parent_revision) REFERENCES world_evidence_revision,
    CHECK(evidence_id <> parent_id OR revision <> parent_revision)
);
CREATE INDEX world_evidence_derived_reverse ON world_evidence_derived_from(tenant_id,world_id,parent_id,parent_revision);
CREATE TABLE world_assertion_identity (
    tenant_id text NOT NULL, world_id text NOT NULL, assertion_id text NOT NULL,
    claim_kind text NOT NULL CHECK(claim_kind IN ('attribute','relation')),
    subject_kind text NOT NULL CHECK(subject_kind IN ('object','relation')), subject_id text NOT NULL,
    predicate_id text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,assertion_id),
    UNIQUE(tenant_id,world_id,assertion_id,claim_kind,subject_kind,subject_id,predicate_id)
);
CREATE TABLE world_assertion_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, assertion_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    claim_kind text NOT NULL, subject_kind text NOT NULL, subject_id text NOT NULL,
    predicate_id text NOT NULL, predicate_revision bigint NOT NULL CHECK(predicate_revision > 0),
    scope_id text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
    valid_from_ns numeric NOT NULL CHECK(valid_from_ns=trunc(valid_from_ns)), valid_to_ns numeric CHECK(valid_to_ns=trunc(valid_to_ns)),
    polarity text NOT NULL CHECK(polarity IN ('positive','negative')),
    status text NOT NULL CHECK(status IN ('candidate','accepted','rejected','withdrawn')),
    origin_kind text NOT NULL, source_binding_id text, source_binding_revision bigint,
    authority_policy_id text, authority_revision bigint, supersedes_id text, supersedes_revision bigint,
    body jsonb NOT NULL, admission jsonb NOT NULL, recorded_at timestamptz NOT NULL,
    PRIMARY KEY(tenant_id,world_id,assertion_id,revision), CHECK(valid_to_ns IS NULL OR valid_from_ns < valid_to_ns),
    CHECK((valid_to IS NULL) = (valid_to_ns IS NULL)),
    FOREIGN KEY(tenant_id,world_id,assertion_id,claim_kind,subject_kind,subject_id,predicate_id)
        REFERENCES world_assertion_identity(tenant_id,world_id,assertion_id,claim_kind,subject_kind,subject_id,predicate_id),
    FOREIGN KEY(tenant_id,world_id,supersedes_id,supersedes_revision) REFERENCES world_assertion_revision
);
CREATE TABLE world_assertion_head (
    tenant_id text NOT NULL, world_id text NOT NULL, assertion_id text NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,assertion_id), FOREIGN KEY(tenant_id,world_id,assertion_id,revision) REFERENCES world_assertion_revision
);
CREATE INDEX world_assertion_subject_history ON world_assertion_revision(tenant_id,world_id,subject_kind,subject_id,predicate_id,scope_id,valid_from);
CREATE INDEX world_assertion_predicate ON world_assertion_revision(tenant_id,world_id,predicate_id,predicate_revision,scope_id,status);
CREATE TABLE world_assertion_role (
    tenant_id text NOT NULL, world_id text NOT NULL, assertion_id text NOT NULL, revision bigint NOT NULL,
    role_id text NOT NULL, object_id text NOT NULL,
    PRIMARY KEY(tenant_id,world_id,assertion_id,revision,role_id,object_id),
    FOREIGN KEY(tenant_id,world_id,assertion_id,revision) REFERENCES world_assertion_revision,
    FOREIGN KEY(tenant_id,world_id,object_id) REFERENCES world_object_identity
);
CREATE INDEX world_assertion_role_object ON world_assertion_role(tenant_id,world_id,object_id,role_id);
CREATE TABLE world_assertion_evidence (
    tenant_id text NOT NULL, world_id text NOT NULL, assertion_id text NOT NULL, revision bigint NOT NULL,
    evidence_id text NOT NULL, evidence_revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,assertion_id,revision,evidence_id,evidence_revision),
    FOREIGN KEY(tenant_id,world_id,assertion_id,revision) REFERENCES world_assertion_revision,
    FOREIGN KEY(tenant_id,world_id,evidence_id,evidence_revision) REFERENCES world_evidence_revision
);
CREATE INDEX world_assertion_evidence_reverse ON world_assertion_evidence(tenant_id,world_id,evidence_id,evidence_revision);
CREATE TABLE world_observation (
    tenant_id text NOT NULL, world_id text NOT NULL, observation_id text NOT NULL, run_id text,
    claim_kind text NOT NULL, subject_kind text NOT NULL, subject_id text NOT NULL, scope_id text NOT NULL,
    status text NOT NULL, body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,observation_id)
);
CREATE TABLE world_definition_evidence_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, definition_id text NOT NULL, definition_revision bigint NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), previous_revision bigint, body jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,definition_id,definition_revision,revision),
    FOREIGN KEY(tenant_id,world_id,definition_id,definition_revision) REFERENCES world_definition_revision
);
CREATE TABLE world_definition_evidence_head (
    tenant_id text NOT NULL, world_id text NOT NULL, definition_id text NOT NULL, definition_revision bigint NOT NULL, revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,definition_id,definition_revision),
    FOREIGN KEY(tenant_id,world_id,definition_id,definition_revision,revision) REFERENCES world_definition_evidence_revision
);
CREATE TABLE world_definition_evidence (
    tenant_id text NOT NULL, world_id text NOT NULL, definition_id text NOT NULL, definition_revision bigint NOT NULL,
    binding_revision bigint NOT NULL, evidence_id text NOT NULL, evidence_revision bigint NOT NULL,
    PRIMARY KEY(tenant_id,world_id,definition_id,definition_revision,binding_revision,evidence_id,evidence_revision),
    FOREIGN KEY(tenant_id,world_id,definition_id,definition_revision,binding_revision) REFERENCES world_definition_evidence_revision,
    FOREIGN KEY(tenant_id,world_id,evidence_id,evidence_revision) REFERENCES world_evidence_revision
);
CREATE TRIGGER world_evidence_revision_immutable BEFORE UPDATE OR DELETE ON world_evidence_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
CREATE TRIGGER world_assertion_revision_immutable BEFORE UPDATE OR DELETE ON world_assertion_revision FOR EACH ROW EXECUTE FUNCTION world_immutable_revision();
