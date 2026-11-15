use std::sync::Arc;

use organization::{GraphRunId, RoleSessionIdentityResolver, RunWorkspaceAccess, RuntimeEndpointReference, TeamId};
use platform::endpoint::runtime_address::RuntimeEndpoint;
use runtime_directory::RuntimeDriverIdentity;
use workspace::{TeamRunWorkspaceReader, WorkspaceBinding, WorkspaceDirectoryFailure, ports::{WorkspaceFileAccess, WorkspaceFuture}};

use crate::composition::runtime_ports::RuntimeDriverDirectory;

pub(crate) struct TeamRunFiles {
    organization: organization::OrganizationHandle,
    runtimes: Arc<RuntimeDriverDirectory>,
}

impl TeamRunFiles {
    pub(crate) fn new(
        organization: organization::OrganizationHandle,
        runtimes: Arc<RuntimeDriverDirectory>,
    ) -> Self {
        Self { organization, runtimes }
    }
}

impl TeamRunWorkspaceReader for TeamRunFiles {
    fn bind<'a>(
        &'a self,
        endpoint: &'a RuntimeEndpoint,
        team_id: &'a str,
        run_id: &'a str,
        access: WorkspaceFileAccess,
    ) -> WorkspaceFuture<'a, Arc<dyn WorkspaceBinding>, WorkspaceDirectoryFailure> {
        Box::pin(async move {
            let unavailable = || WorkspaceDirectoryFailure::Unavailable;
            let team = TeamId::try_new(team_id).map_err(|_| unavailable())?;
            let runtime = [RuntimeDriverIdentity::open_claw(), RuntimeDriverIdentity::matcha_agent()]
                .into_iter().find(|runtime| &runtime.endpoint() == endpoint).ok_or_else(unavailable)?;
            let endpoint_ref = RuntimeEndpointReference::try_new(runtime.runtime_endpoint_reference())
                .map_err(|_| unavailable())?;
            let access = match access {
                WorkspaceFileAccess::Read => RunWorkspaceAccess::Read,
                WorkspaceFileAccess::Write => RunWorkspaceAccess::Write,
            };
            let selection = self.organization
                .run_workspace_binding(team, GraphRunId::new(run_id), endpoint_ref, access)
                .await.map_err(|_| unavailable())?
                .map_err(|_| unavailable())?
                .ok_or_else(unavailable)?;
            let binding_endpoint = runtime_directory::endpoint_from_reference(selection.binding.endpoint().as_str())
                .ok_or_else(unavailable)?;
            if &binding_endpoint != endpoint {
                return Err(unavailable());
            }
            let session_key = self.runtimes.session_key(&selection.binding).ok_or_else(unavailable)?;
            let driver = self.runtimes.lookup(endpoint).ok_or_else(unavailable)?;
            let ops = driver.workspace_ops().ok_or_else(unavailable)?;
            if !ops.workspace_runtime_ready() {
                return Err(unavailable());
            }
            let binding = ops.bind_workspace(&session_key).await?;
            if !binding.directory_matches(selection.workspace.root()) {
                return Err(unavailable());
            }
            Ok(binding)
        })
    }
}
