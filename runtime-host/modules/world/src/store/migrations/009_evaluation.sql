CREATE TABLE world_task_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, task_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    content_digest text NOT NULL, scope_id text NOT NULL, body jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,world_id,task_id,revision)
);
CREATE TABLE world_case_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, case_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    task_id text NOT NULL, task_revision bigint NOT NULL, content_digest text NOT NULL,
    protected boolean NOT NULL, counterexample boolean NOT NULL, body jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,world_id,case_id,revision),
    FOREIGN KEY(tenant_id,world_id,task_id,task_revision) REFERENCES world_task_revision
);
CREATE INDEX world_case_task ON world_case_revision(tenant_id,world_id,task_id,task_revision);
CREATE TABLE world_test_case_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, test_case_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    case_id text, case_revision bigint, content_digest text NOT NULL,
    CHECK((case_id IS NULL) = (case_revision IS NULL)),
    oracle_digest text NOT NULL, protected boolean NOT NULL, body jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,world_id,test_case_id,revision),
    FOREIGN KEY(tenant_id,world_id,case_id,case_revision) REFERENCES world_case_revision
);
CREATE TABLE world_suite_revision (
    tenant_id text NOT NULL, world_id text NOT NULL, suite_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    task_id text NOT NULL, task_revision bigint NOT NULL, content_digest text NOT NULL,
    authority_actor_id text NOT NULL, frozen_at timestamptz NOT NULL, holdout boolean NOT NULL, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,suite_id,revision), FOREIGN KEY(tenant_id,world_id,task_id,task_revision) REFERENCES world_task_revision
);
CREATE TABLE world_suite_member (
    tenant_id text NOT NULL, world_id text NOT NULL, suite_id text NOT NULL, suite_revision bigint NOT NULL,
    test_case_id text NOT NULL, test_case_revision bigint NOT NULL, ordinal integer NOT NULL CHECK(ordinal >= 0),
    PRIMARY KEY(tenant_id,world_id,suite_id,suite_revision,test_case_id,test_case_revision),
    UNIQUE(tenant_id,world_id,suite_id,suite_revision,ordinal),
    FOREIGN KEY(tenant_id,world_id,suite_id,suite_revision) REFERENCES world_suite_revision,
    FOREIGN KEY(tenant_id,world_id,test_case_id,test_case_revision) REFERENCES world_test_case_revision
);
CREATE TABLE world_evaluation_run (
    tenant_id text NOT NULL, world_id text NOT NULL, evaluation_id text NOT NULL, operation_id text NOT NULL, run_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), suite_id text NOT NULL, suite_revision bigint NOT NULL,
    branch_id text NOT NULL, phase text NOT NULL, basis jsonb NOT NULL, body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), terminal_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,evaluation_id), FOREIGN KEY(tenant_id,world_id,suite_id,suite_revision) REFERENCES world_suite_revision,
    FOREIGN KEY(tenant_id,world_id,operation_id) REFERENCES world_operation,
    FOREIGN KEY(tenant_id,world_id,run_id) REFERENCES world_run
);
CREATE TABLE world_evaluation_result (
    tenant_id text NOT NULL, world_id text NOT NULL, evaluation_id text NOT NULL,
    test_case_id text NOT NULL, test_case_revision bigint NOT NULL, arm text NOT NULL,
    status text NOT NULL, result_digest text NOT NULL, body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,evaluation_id,test_case_id,test_case_revision,arm),
    FOREIGN KEY(tenant_id,world_id,evaluation_id) REFERENCES world_evaluation_run,
    FOREIGN KEY(tenant_id,world_id,test_case_id,test_case_revision) REFERENCES world_test_case_revision
);
CREATE TABLE world_evaluation_report (
    tenant_id text NOT NULL, world_id text NOT NULL, evaluation_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), content_digest text NOT NULL, verdict text NOT NULL,
    body jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,evaluation_id,revision), FOREIGN KEY(tenant_id,world_id,evaluation_id) REFERENCES world_evaluation_run
);
