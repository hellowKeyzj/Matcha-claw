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

        let mut slots = BTreeSet::new();
        let mut endpoint_sessions = BTreeSet::new();
        for binding in &bindings {
            if binding.team_run() != &team_run {
                return Err(InvalidRunRuntimeReceipt::BindingRunMismatch);
            }
            if !slots.insert((binding.role().as_str(), binding.session_ref().as_str())) {
                return Err(InvalidRunRuntimeReceipt::DuplicateRoleSessionBinding);
            }
            if !endpoint_sessions.insert(binding.endpoint_session_id().as_str()) {
                return Err(InvalidRunRuntimeReceipt::DuplicateEndpointSessionBinding);
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
    DuplicateRoleSessionBinding,
    DuplicateEndpointSessionBinding,
}
