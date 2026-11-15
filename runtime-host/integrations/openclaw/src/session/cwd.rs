use std::path::Path;

use tokio_util::sync::CancellationToken;

use crate::{
    port::{OpenClawGateway, OpenClawSessionError},
    surfaces::workspace::{OpenClawWorkspaceAccess, OpenClawWorkspaceBinding},
};

use super::protocol::{
    AgentScopedSessionKey, SessionDescribeParams, SessionIdentityReadback, SessionKey,
};

#[derive(Clone, Copy)]
pub(crate) enum SessionCwdError {
    Mismatch,
    Unavailable,
}

pub(crate) async fn read_identity(
    gateway: &OpenClawGateway,
    key: &AgentScopedSessionKey,
    cancellation: &CancellationToken,
) -> Result<Option<SessionIdentityReadback>, OpenClawSessionError> {
    let session_key = SessionKey::try_new(key.as_str())
        .map_err(|_| OpenClawSessionError::UnknownResponse)?;
    gateway.session_gateway().describe_session_cancellable(
        SessionDescribeParams::new(session_key, Some(key.agent_id())), cancellation,
    ).await?.map(|row| row.identity(key).map_err(|_| OpenClawSessionError::UnknownResponse)).transpose()
}

pub(crate) async fn bind_expected_workspace(
    access: &OpenClawWorkspaceAccess,
    identity: &SessionIdentityReadback,
    expected: &Path,
) -> Result<OpenClawWorkspaceBinding, SessionCwdError> {
    let access = access.clone();
    let identity = identity.clone();
    let expected = expected.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let workspace = access.bind_run_workspace(&expected).map_err(|_| SessionCwdError::Unavailable)?;
        let cwd = identity.spawned_cwd().ok_or(SessionCwdError::Mismatch)?;
        for root in [Some(cwd), identity.workspace_root(), identity.session_root()].into_iter().flatten() {
            match workspace.matches_directory(root) {
                Ok(true) => {}
                Ok(false) => return Err(SessionCwdError::Mismatch),
                Err(_) => return Err(SessionCwdError::Unavailable),
            }
        }
        Ok(workspace)
    }).await.map_err(|_| SessionCwdError::Unavailable)?
}
