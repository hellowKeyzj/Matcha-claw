use serde::{Deserialize, Serialize};
use world_protocol::{
    authorization::{AccessMode, AccessScope, Actor, PolicyObligation, PolicyRef, PolicyRule, PolicyVerdict},
    definitions::Scope,
    expression::{Effect, ExpressionIr},
    ids::*,
    materials::AccessPolicyRef,
    package::{TrustPolicy, UnsignedWasmPolicy},
    sources::{ContractRef, RetentionPolicy},
    time::Timestamp,
    value::Value,
};

#[path = "world_evaluation.rs"]
mod evaluation;
pub(crate) use evaluation::EvaluationConfigurationWire;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InitialWorldWire {
    world: WorldRef,
    commit_id: CommitId,
    storage_id: String,
    management_scope: Scope,
    principals: Vec<PrincipalWire>,
    grants: Vec<GrantWire>,
    genesis: GenesisWire,
    trust_policy: TrustPolicy,
    policies: Vec<PolicyWire>,
    retention_policies: Vec<RetentionWire>,
    evaluation: Option<EvaluationWire>,
    maintenance: Option<MaintenanceWire>,
}

pub(crate) struct InitialWorldError;

impl InitialWorldWire {
    /// Private first-world defaults. Existing stores never enter this constructor.
    pub(crate) fn desktop(storage_id: String) -> Self {
        let world = WorldRef {
            tenant_id: TenantId::try_new("local").expect("fixed tenant"),
            world_id: WorldId::try_new(format!("personal-{}", uuid::Uuid::new_v4())).expect("UUID world"),
        };
        let scope = ScopeId::try_new("desktop").expect("fixed scope");
        let actor = ActorId::try_new("electron-main-local").expect("fixed desktop service");
        let access = vec![AccessScope {
            resources: Vec::new(), fields: Vec::new(),
            modes: vec![AccessMode::Read, AccessMode::Write, AccessMode::Execute, AccessMode::Approve,
                AccessMode::Publish, AccessMode::Manage, AccessMode::Export, AccessMode::Delete],
            scope: scope.clone(), valid_time: None,
        }];
        let policy = PolicyId::try_new("desktop").expect("fixed policy");
        Self {
            world: world.clone(),
            commit_id: CommitId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID commit"),
            storage_id,
            management_scope: Scope { world, id: scope.clone(), predicate: ExpressionIr::Literal { value: Value::Boolean { value: true } } },
            principals: vec![PrincipalWire {
                issuer: "electron-main".into(), subject: "electron-main-local".into(),
                actor: ActorWire::Service { id: actor.clone() }, expires_at: None,
            }],
            grants: vec![GrantWire {
                id: GrantId::try_new("desktop").expect("fixed grant"), actor, access: access.clone(),
                labels: Vec::new(), effects: vec![Effect::SourceRead, Effect::ClockRead, Effect::Probabilistic, Effect::ExternalWrite], expires_at: None,
            }],
            genesis: GenesisWire {
                activation_lock_id: ActivationLockId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID activation"),
                artifact_id: ArtifactId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID artifact"),
                release_id: ReleaseId::try_new(uuid::Uuid::new_v4().to_string()).expect("UUID release"),
                channel: ChannelId::try_new("main").expect("fixed channel"),
            },
            trust_policy: TrustPolicy {
                revision: Revision(1), unsigned_wasm: UnsignedWasmPolicy::Deny,
                trusted_publishers: Vec::new(), trusted_process_digests: Vec::new(), trusted_native_digests: Vec::new(),
            },
            policies: vec![PolicyWire {
                rule: PolicyRuleWire {
                    reference: PolicyRefWire { policy_id: policy.clone(), revision: Revision(1), obligations: Vec::new() },
                    verdict: PolicyVerdict::Allow, access, labels: Vec::new(), effects: Vec::new(),
                },
                scope: scope.clone(), mandatory: false, available: true,
            }],
            retention_policies: vec![RetentionWire { scope, policy: RetentionPolicy { policy_id: policy, revision: Revision(1) } }],
            evaluation: None, maintenance: None,
        }
    }

    pub(crate) fn storage_id(&self) -> &str {
        &self.storage_id
    }

    pub(crate) fn safe_summary(&self) -> serde_json::Value {
        serde_json::json!({
            "world": self.world,
            "commitId": self.commit_id,
            "principalCount": self.principals.len(),
            "grantCount": self.grants.len(),
            "policyCount": self.policies.len(),
            "retentionPolicyCount": self.retention_policies.len(),
            "evaluation": self.evaluation.is_some(),
            "maintenance": self.maintenance.is_some(),
        })
    }

    pub(crate) fn into_provision(self) -> Result<::world::Provision, InitialWorldError> {
        let config_digest =
            world_protocol::api::package_config_digest(&[]).map_err(|_| InitialWorldError)?;
        let policy_contract =
            world_protocol::slots::slot_contract(world_protocol::bindings::SlotKind::Policy)
                .map_err(|_| InitialWorldError)?;
        Ok(::world::Provision {
            world: self.world,
            commit_id: self.commit_id,
            storage_id: self.storage_id,
            management_scope: self.management_scope,
            principals: self.principals.into_iter().map(Into::into).collect(),
            grants: self.grants.into_iter().map(Into::into).collect(),
            genesis: ::world::Genesis {
                activation_lock_id: self.genesis.activation_lock_id,
                artifact_id: self.genesis.artifact_id,
                release_id: self.genesis.release_id,
                channel: self.genesis.channel,
                config_digest,
            },
            trust_policy: self.trust_policy,
            policies: self
                .policies
                .into_iter()
                .map(|policy| policy.into_policy(&policy_contract))
                .collect(),
            retention_policies: self.retention_policies.into_iter().map(Into::into).collect(),
            evaluation: self.evaluation.map(Into::into),
            maintenance: self
                .maintenance
                .map(|configuration| ::world::InitialMaintenance {
                    issuer: configuration.issuer,
                    subject: configuration.subject,
                }),
        })
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PrincipalWire {
    issuer: String,
    subject: String,
    actor: ActorWire,
    expires_at: Option<Timestamp>,
}

impl From<PrincipalWire> for ::world::PrincipalRecord {
    fn from(record: PrincipalWire) -> Self {
        Self {
            issuer: record.issuer,
            subject: record.subject,
            actor: record.actor.into(),
            expires_at: record.expires_at,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum ActorWire {
    Human { id: ActorId },
    Service { id: ActorId },
}

impl From<ActorWire> for Actor {
    fn from(actor: ActorWire) -> Self {
        match actor {
            ActorWire::Human { id } => Self::Human { id },
            ActorWire::Service { id } => Self::Service { id },
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantWire {
    id: GrantId,
    actor: ActorId,
    access: Vec<AccessScope>,
    labels: Vec<String>,
    effects: Vec<Effect>,
    expires_at: Option<Timestamp>,
}

impl From<GrantWire> for ::world::InitialGrant {
    fn from(grant: GrantWire) -> Self {
        Self {
            id: grant.id,
            actor: grant.actor,
            access: grant.access,
            labels: grant.labels,
            effects: grant.effects,
            expires_at: grant.expires_at,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenesisWire {
    activation_lock_id: ActivationLockId,
    artifact_id: ArtifactId,
    release_id: ReleaseId,
    channel: ChannelId,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyWire {
    rule: PolicyRuleWire,
    scope: ScopeId,
    mandatory: bool,
    available: bool,
}

impl PolicyWire {
    fn into_policy(self, contract: &ContractRef) -> ::world::InitialPolicy {
        ::world::InitialPolicy {
            rule: PolicyRule {
                reference: PolicyRef {
                    policy_id: self.rule.reference.policy_id,
                    revision: self.rule.reference.revision,
                    contract: contract.clone(),
                    obligations: self.rule.reference.obligations,
                },
                verdict: self.rule.verdict,
                access: self.rule.access,
                labels: self.rule.labels,
                effects: self.rule.effects,
            },
            scope: self.scope,
            mandatory: self.mandatory,
            available: self.available,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyRuleWire {
    reference: PolicyRefWire,
    verdict: PolicyVerdict,
    access: Vec<AccessScope>,
    labels: Vec<String>,
    effects: Vec<Effect>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PolicyRefWire {
    policy_id: PolicyId,
    revision: Revision,
    obligations: Vec<PolicyObligation>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetentionWire {
    scope: ScopeId,
    policy: RetentionPolicy,
}

impl From<RetentionWire> for ::world::InitialRetention {
    fn from(policy: RetentionWire) -> Self {
        Self {
            scope: policy.scope,
            policy: policy.policy,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationWire {
    execution: EvaluationPrincipalWire,
    oracle: EvaluationPrincipalWire,
    case_access: AccessPolicyRef,
    case_retention: RetentionPolicy,
}

impl From<EvaluationWire> for ::world::InitialEvaluation {
    fn from(configuration: EvaluationWire) -> Self {
        Self {
            execution: ::world::EvaluationPrincipal {
                issuer: configuration.execution.issuer,
                subject: configuration.execution.subject,
            },
            oracle: ::world::EvaluationPrincipal {
                issuer: configuration.oracle.issuer,
                subject: configuration.oracle.subject,
            },
            case_access: configuration.case_access,
            case_retention: configuration.case_retention,
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvaluationPrincipalWire {
    issuer: String,
    subject: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MaintenanceWire {
    issuer: String,
    subject: String,
}
