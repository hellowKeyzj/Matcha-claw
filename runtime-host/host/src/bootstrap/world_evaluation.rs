use serde::Deserialize;
use world_protocol::ids::{CommitId, WorldRef};

use super::{EvaluationWire, InitialWorldError, PolicyWire, PrincipalWire, RetentionWire};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EvaluationConfigurationWire {
    world: WorldRef,
    commit_id: CommitId,
    evaluation: EvaluationWire,
    principals: Vec<PrincipalWire>,
    grants: Vec<::world::EvaluationGrant>,
    policies: Vec<PolicyWire>,
    retention_policies: Vec<RetentionWire>,
}

impl EvaluationConfigurationWire {
    pub(crate) fn world(&self) -> &WorldRef {
        &self.world
    }

    pub(crate) fn safe_summary(&self) -> serde_json::Value {
        serde_json::json!({
            "world": self.world,
            "commitId": self.commit_id,
            "principalCount": self.principals.len(),
            "grantCount": self.grants.len(),
            "policyCount": self.policies.len(),
            "retentionPolicyCount": self.retention_policies.len(),
            "caseAccess": self.evaluation.case_access,
            "caseRetention": self.evaluation.case_retention,
        })
    }

    pub(crate) fn into_install(self) -> Result<::world::InstallEvaluation, InitialWorldError> {
        let policy_contract =
            world_protocol::slots::slot_contract(world_protocol::bindings::SlotKind::Policy)
                .map_err(|_| InitialWorldError)?;
        Ok(::world::InstallEvaluation {
            world: self.world,
            commit_id: self.commit_id,
            evaluation: self.evaluation.into(),
            principals: self.principals.into_iter().map(Into::into).collect(),
            grants: self.grants,
            policies: self
                .policies
                .into_iter()
                .map(|policy| policy.into_policy(&policy_contract))
                .collect(),
            retention_policies: self.retention_policies.into_iter().map(Into::into).collect(),
        })
    }
}
