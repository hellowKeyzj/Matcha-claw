CREATE TABLE world_authority_head (
    tenant_id text NOT NULL, world_id text NOT NULL, policy_epoch bigint NOT NULL CHECK(policy_epoch > 0), grant_epoch bigint NOT NULL CHECK(grant_epoch > 0),
    PRIMARY KEY(tenant_id,world_id)
);
CREATE TABLE world_auth_principal (
    tenant_id text NOT NULL, world_id text NOT NULL, issuer text NOT NULL, subject text NOT NULL,
    actor_id text NOT NULL, actor_kind text NOT NULL CHECK(actor_kind IN ('human','service')),
    active boolean NOT NULL, expires_at timestamptz, PRIMARY KEY(tenant_id,world_id,issuer,subject)
);
CREATE TABLE world_auth_grant (
    tenant_id text NOT NULL, world_id text NOT NULL, grant_id text NOT NULL, actor_id text NOT NULL,
    "grant" jsonb NOT NULL, active boolean NOT NULL, expires_at timestamptz,
    PRIMARY KEY(tenant_id,world_id,grant_id)
);
CREATE INDEX world_auth_grant_actor ON world_auth_grant(tenant_id,world_id,actor_id) WHERE active;
CREATE TABLE world_auth_delegation (
    tenant_id text NOT NULL, world_id text NOT NULL, delegation_id text NOT NULL,
    actor_id text NOT NULL, delegate_id text NOT NULL, restriction jsonb NOT NULL, active boolean NOT NULL, expires_at timestamptz NOT NULL,
    PRIMARY KEY(tenant_id,world_id,delegation_id)
);
CREATE TABLE world_auth_execution (
    tenant_id text NOT NULL, world_id text NOT NULL, binding_id text NOT NULL,
    issuer text NOT NULL, subject text NOT NULL, actor_id text NOT NULL, agent_id text, task_id text,
    context jsonb NOT NULL, restriction jsonb NOT NULL, active boolean NOT NULL, expires_at timestamptz NOT NULL,
    PRIMARY KEY(tenant_id,world_id,binding_id)
);
CREATE INDEX world_auth_execution_principal ON world_auth_execution(tenant_id,world_id,issuer,subject,actor_id);
CREATE TABLE world_auth_policy (
    tenant_id text NOT NULL, world_id text NOT NULL, policy_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    policy jsonb NOT NULL, scope_id text NOT NULL, mandatory boolean NOT NULL, active boolean NOT NULL, available boolean NOT NULL,
    PRIMARY KEY(tenant_id,world_id,policy_id)
);
CREATE INDEX world_auth_policy_scope ON world_auth_policy(tenant_id,world_id,scope_id) WHERE active;
CREATE TABLE world_auth_approval (
    tenant_id text NOT NULL, world_id text NOT NULL, approval_id text NOT NULL,
    actor_id text NOT NULL, proposer_id text NOT NULL, approver_id text NOT NULL, binding jsonb NOT NULL,
    active boolean NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,world_id,approval_id),
    CHECK(NOT coalesce((binding->>'separateActor')::boolean,false) OR proposer_id <> approver_id)
);
CREATE TABLE world_auth_replay (
    tenant_id text NOT NULL, world_id text NOT NULL, issuer text NOT NULL, request_id text NOT NULL,
    input_digest text NOT NULL, expires_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,world_id,issuer,request_id)
);
CREATE TABLE world_auth_decision (
    tenant_id text NOT NULL, world_id text NOT NULL, decision_id text NOT NULL,
    invocation_id text NOT NULL, actor_id text NOT NULL, impact_digest text NOT NULL, decision jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,world_id,decision_id)
);
CREATE TABLE world_action_proposal (
    tenant_id text NOT NULL, world_id text NOT NULL, proposal_id text NOT NULL, revision bigint NOT NULL CHECK(revision > 0),
    proposal_digest text NOT NULL, impact_digest text NOT NULL, actor_id text NOT NULL, branch_id text,
    action_id text NOT NULL, action_revision bigint NOT NULL, activation_lock_id text NOT NULL,
    status text NOT NULL, body jsonb NOT NULL, execution jsonb NOT NULL CHECK(jsonb_typeof(execution)='object'), expires_at timestamptz NOT NULL,
    PRIMARY KEY(tenant_id,world_id,proposal_id),
    FOREIGN KEY(tenant_id,world_id,action_id,action_revision) REFERENCES world_definition_revision,
    FOREIGN KEY(tenant_id,world_id,activation_lock_id) REFERENCES world_activation_lock
);
CREATE TABLE world_effect_intent (
    tenant_id text NOT NULL, world_id text NOT NULL, intent_id text NOT NULL,
    operation_id text NOT NULL, run_id text NOT NULL, step_id text NOT NULL,
    revision bigint NOT NULL CHECK(revision > 0), status text NOT NULL,
    action_id text NOT NULL, action_revision bigint NOT NULL, proposal_id text NOT NULL,
    proposal_digest text NOT NULL, impact_digest text NOT NULL, payload_digest text NOT NULL, target_digest text NOT NULL,
    effect text NOT NULL, actor_id text NOT NULL, branch_id text, idempotency_key text NOT NULL,
    activation_lock_id text NOT NULL, decision_id text NOT NULL, record jsonb NOT NULL, execution jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,world_id,intent_id),
    CONSTRAINT world_effect_intent_idempotency UNIQUE(tenant_id,world_id,actor_id,action_id,idempotency_key),
    CONSTRAINT world_effect_intent_step UNIQUE(tenant_id,world_id,operation_id,step_id),
    FOREIGN KEY(tenant_id,world_id,operation_id) REFERENCES world_operation,
    FOREIGN KEY(tenant_id,world_id,run_id,step_id) REFERENCES world_step,
    FOREIGN KEY(tenant_id,world_id,decision_id) REFERENCES world_auth_decision,
    FOREIGN KEY(tenant_id,world_id,proposal_id) REFERENCES world_action_proposal
);
CREATE INDEX world_effect_intent_recovery ON world_effect_intent(tenant_id,world_id,status,updated_at);
CREATE TABLE world_auth_permit (
    tenant_id text NOT NULL, world_id text NOT NULL, permit_id text NOT NULL,
    intent_id text NOT NULL, operation_id text NOT NULL, step_id text NOT NULL, actor_id text NOT NULL, invocation_id text NOT NULL,
    binding jsonb NOT NULL, policy_epoch bigint NOT NULL, grant_epoch bigint NOT NULL,
    expires_at timestamptz NOT NULL, remaining_uses integer NOT NULL CHECK(remaining_uses >= 0),
    status text NOT NULL CHECK(status IN ('issued','consumed','revoked')),
    PRIMARY KEY(tenant_id,world_id,permit_id), FOREIGN KEY(tenant_id,world_id,intent_id) REFERENCES world_effect_intent
);
CREATE TABLE world_source_receipt (
    tenant_id text NOT NULL, world_id text NOT NULL, receipt_id text NOT NULL, intent_id text NOT NULL,
    source_id text NOT NULL, disposition text NOT NULL, observed_at timestamptz NOT NULL,
    body jsonb NOT NULL, PRIMARY KEY(tenant_id,world_id,receipt_id),
    FOREIGN KEY(tenant_id,world_id,intent_id) REFERENCES world_effect_intent
);
CREATE INDEX world_source_receipt_intent ON world_source_receipt(tenant_id,world_id,intent_id,observed_at);
CREATE TABLE world_verification_receipt (
    tenant_id text NOT NULL, world_id text NOT NULL, verification_id text NOT NULL, intent_id text NOT NULL,
    verdict text NOT NULL, verified_at timestamptz NOT NULL, body jsonb NOT NULL,
    PRIMARY KEY(tenant_id,world_id,verification_id), FOREIGN KEY(tenant_id,world_id,intent_id) REFERENCES world_effect_intent
);
