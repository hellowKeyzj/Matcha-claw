use super::*;

impl TeamTerminalOps for MatchaRuntimeDriver {
    fn watch_terminal(
        &self,
        target: organization::MatchaTerminalReceiptTarget,
    ) -> OwnedRuntimeFuture<Option<::matcha_agent::session::receipt::TerminalRunStatus>> {
        let native = self.native.clone();
        watch_terminal_with_handle(native, target)
    }
}

impl TeamTerminalOps for MatchaAgentInstance {
    fn watch_terminal(
        &self,
        target: organization::MatchaTerminalReceiptTarget,
    ) -> OwnedRuntimeFuture<Option<::matcha_agent::session::receipt::TerminalRunStatus>> {
        self.team.watch_terminal(target)
    }
}

fn watch_terminal_with_handle(
    native: RoleSessionNativeHandle,
    target: organization::MatchaTerminalReceiptTarget,
) -> OwnedRuntimeFuture<Option<::matcha_agent::session::receipt::TerminalRunStatus>> {
    Box::pin(async move {
        let session_id = match ::matcha_agent::session::role::RoleSessionId::try_new(
            target.correlation().external_session().as_str().to_owned(),
        ) {
            Ok(session_id) => session_id,
            Err(_) => return None,
        };
        let run_id = match ::matcha_agent::session::role::RoleRunId::try_new(
            target
                .correlation()
                .native_run_receipt()
                .as_str()
                .to_owned(),
        ) {
            Ok(run_id) => run_id,
            Err(_) => return None,
        };
        native.watch_role_terminal(session_id, run_id).await
    })
}
