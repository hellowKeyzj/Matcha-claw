use std::collections::BTreeSet;

use crate::GraphRunId;

use super::RoleSessionReceipt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunRuntimeReceipt {
    team_run: GraphRunId,
    bindings: Vec<RoleSessionReceipt>,
}

impl RunRuntimeReceipt {
    pub fn try_new(
        team_run: GraphRunId,
        bindings: Vec<RoleSessionReceipt>,
    ) -> Result<Self, InvalidRunRuntimeReceipt> {
        if bindings.is_empty() {
            return Err(InvalidRunRuntimeReceipt::EmptyBindings);
        }

        let mut roles = BTreeSet::new();
        let mut local_sessions = BTreeSet::new();
        let mut external_sessions = BTreeSet::new();
        let mut agents = BTreeSet::new();
        let endpoint = bindings[0].endpoint();
        for binding in &bindings {
            if binding.team_run() != &team_run {
                return Err(InvalidRunRuntimeReceipt::BindingRunMismatch);
            }
            if binding.endpoint() != endpoint {
                return Err(InvalidRunRuntimeReceipt::BindingEndpointMismatch);
            }
            if !roles.insert(binding.role().as_str()) {
                return Err(InvalidRunRuntimeReceipt::DuplicateRoleBinding);
            }
            if !local_sessions.insert(binding.local_session().as_str()) {
                return Err(InvalidRunRuntimeReceipt::DuplicateLocalSessionBinding);
            }
            if !external_sessions.insert(binding.external_session().as_str()) {
                return Err(InvalidRunRuntimeReceipt::DuplicateExternalSessionBinding);
            }
            if !agents.insert(binding.agent().as_str()) {
                return Err(InvalidRunRuntimeReceipt::DuplicateAgentBinding);
            }
        }

        Ok(Self { team_run, bindings })
    }

    pub fn team_run(&self) -> &GraphRunId {
        &self.team_run
    }

    pub fn bindings(&self) -> &[RoleSessionReceipt] {
        &self.bindings
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InvalidRunRuntimeReceipt {
    EmptyBindings,
    BindingRunMismatch,
    BindingEndpointMismatch,
    DuplicateRoleBinding,
    DuplicateLocalSessionBinding,
    DuplicateExternalSessionBinding,
    DuplicateAgentBinding,
}
