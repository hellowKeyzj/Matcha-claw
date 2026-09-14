use std::sync::Arc;

use crate::{composition::HostAdmission, runtime_directory::RuntimeDriverDirectory};

#[derive(Clone)]
pub(crate) struct AgentsHandle {
    admission: Arc<HostAdmission>,
    runtime_directory: Arc<RuntimeDriverDirectory>,
    sealed_store: Arc<crate::sealed_resource::SealedAgentStore>,
    sealed_runtime_token: Option<Arc<str>>,
}

impl AgentsHandle {
    pub(crate) fn new(
        admission: Arc<HostAdmission>,
        runtime_directory: Arc<RuntimeDriverDirectory>,
        sealed_store: Arc<crate::sealed_resource::SealedAgentStore>,
        sealed_runtime_token: Option<Arc<str>>,
    ) -> Self {
        Self {
            admission,
            runtime_directory,
            sealed_store,
            sealed_runtime_token,
        }
    }

    pub(crate) async fn agents(
        &self,
        command: crate::agents::Command,
    ) -> Result<crate::agents::Outcome, ()> {
        if self.admission.admit_request().is_err() {
            return Ok(crate::agents::Outcome::Unavailable);
        }
        match command {
            crate::agents::Command::ExportPackage { endpoint, agent_id } => {
                if endpoint != crate::agents::NativeEndpoint::OpenClawLocal {
                    return Ok(crate::agents::Outcome::Unsupported);
                }
                let Ok(agent_key) = crate::sealed_resource::AgentKey::parse(agent_id) else {
                    return Ok(crate::agents::Outcome::Rejected);
                };
                return Ok(self
                    .sealed_store
                    .export_plain_workspace_package(agent_key)
                    .map(crate::agents::Outcome::PackageExported)
                    .unwrap_or_else(sealed_error_outcome));
            }
            crate::agents::Command::InstallPackage {
                endpoint,
                package_path,
            } => {
                if endpoint != crate::agents::NativeEndpoint::OpenClawLocal {
                    return Ok(crate::agents::Outcome::Unsupported);
                }
                return Ok(self
                    .sealed_store
                    .install_package_path(package_path.into())
                    .map(crate::agents::Outcome::PackageInstalled)
                    .unwrap_or_else(sealed_error_outcome));
            }
            command => {
                let endpoint = command.endpoint().runtime_endpoint();
                let Some(driver) = self.runtime_directory.lookup(&endpoint) else {
                    return Ok(crate::agents::Outcome::Unsupported);
                };
                if !driver.lifecycle_ops().is_some_and(|ops| ops.readiness()) {
                    return Ok(crate::agents::Outcome::Unavailable);
                }
                let outcome = match driver.subagent_ops() {
                    Some(ops) => ops.agents(command).await,
                    None => crate::agents::Outcome::Unsupported,
                };
                Ok(self.project_sealed_state(outcome))
            }
        }
    }

    pub(crate) fn read_sealed_agent_file(
        &self,
        token: &str,
        agent_key: crate::sealed_resource::AgentKey,
        path: crate::sealed_resource::PackageRelativePath,
    ) -> Result<
        crate::sealed_resource::SealedResourceRead,
        crate::sealed_resource::SealedResourceError,
    > {
        if !self
            .sealed_runtime_token
            .as_deref()
            .is_some_and(|expected| expected == token)
        {
            return Err(crate::sealed_resource::SealedResourceError::Rejected);
        }
        self.sealed_store.read_file(agent_key, path)
    }

    fn project_sealed_state(&self, outcome: crate::agents::Outcome) -> crate::agents::Outcome {
        let crate::agents::Outcome::Agents {
            default_id,
            selection_required,
            mut agents,
        } = outcome
        else {
            return outcome;
        };
        for agent in &mut agents {
            let Ok(agent_key) = crate::sealed_resource::AgentKey::parse(agent.id.clone()) else {
                continue;
            };
            agent.sealed = self
                .sealed_store
                .contains_agent(&agent_key)
                .unwrap_or(false);
        }
        crate::agents::Outcome::Agents {
            default_id,
            selection_required,
            agents,
        }
    }
}

fn sealed_error_outcome(
    error: crate::sealed_resource::SealedResourceError,
) -> crate::agents::Outcome {
    match error {
        crate::sealed_resource::SealedResourceError::NotFound => crate::agents::Outcome::Rejected,
        crate::sealed_resource::SealedResourceError::Rejected => crate::agents::Outcome::Rejected,
        crate::sealed_resource::SealedResourceError::AlreadyExists => {
            crate::agents::Outcome::Unknown
        }
        crate::sealed_resource::SealedResourceError::Unknown => crate::agents::Outcome::Unavailable,
    }
}
