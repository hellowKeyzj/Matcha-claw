CREATE TABLE world_auth_evaluation (
    tenant_id text NOT NULL, world_id text NOT NULL,
    installation_digest text NOT NULL,
    configuration jsonb NOT NULL,
    installed_commit_id text NOT NULL,
    PRIMARY KEY(tenant_id,world_id),
    FOREIGN KEY(tenant_id,world_id,installed_commit_id) REFERENCES world_commit_receipt(tenant_id,world_id,commit_id)
);
