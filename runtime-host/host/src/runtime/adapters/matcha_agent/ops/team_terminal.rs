use crate::runtime::driver::NativeRunSettled;

use super::*;

impl TeamTerminalOps for MatchaRuntimeDriver {
    fn watch_terminal(
        &self,
        target: organization::NativeTerminalReceiptTarget,
    ) -> OwnedRuntimeFuture<Option<NativeRunSettled>> {
        let native = self.native.clone();
        let endpoint_session_id = target
            .correlation()
            .endpoint_session_id()
            .as_str()
            .to_owned();
        let native_run_id = target
            .correlation()
            .native_run_receipt()
            .as_str()
            .to_owned();
        watch_session_native_run_with_handle(native, endpoint_session_id, native_run_id)
    }
}

impl TeamTerminalOps for MatchaAgentInstance {
    fn watch_terminal(
        &self,
        target: organization::NativeTerminalReceiptTarget,
    ) -> OwnedRuntimeFuture<Option<NativeRunSettled>> {
        self.team.watch_terminal(target)
    }
}

pub(super) fn watch_session_native_run_with_handle(
    native: RoleSessionNativeHandle,
    endpoint_session_id: String,
    native_run_id: String,
) -> OwnedRuntimeFuture<Option<NativeRunSettled>> {
    Box::pin(async move {
        let session_id =
            match ::matcha_agent::session::role::RoleSessionId::try_new(endpoint_session_id) {
                Ok(session_id) => session_id,
                Err(_) => return None,
            };
        let run_id = match ::matcha_agent::session::role::RoleRunId::try_new(native_run_id) {
            Ok(run_id) => run_id,
            Err(_) => return None,
        };
        native
            .watch_role_terminal_settled(session_id, run_id)
            .await
            .map(native_run_settled)
    })
}

fn native_run_settled(
    settled: ::matcha_agent::session::receipt::NativeRunSettled,
) -> NativeRunSettled {
    NativeRunSettled {
        status: match_matcha_terminal_status(settled.status()),
        final_assistant_text: settled.final_assistant_text().map(ToOwned::to_owned),
    }
}

fn match_matcha_terminal_status(
    status: ::matcha_agent::session::receipt::TerminalRunStatus,
) -> organization::NativeTerminalStatus {
    match status {
        ::matcha_agent::session::receipt::TerminalRunStatus::Completed => {
            organization::NativeTerminalStatus::Completed
        }
        ::matcha_agent::session::receipt::TerminalRunStatus::Cancelled => {
            organization::NativeTerminalStatus::Cancelled
        }
        ::matcha_agent::session::receipt::TerminalRunStatus::Failed => {
            organization::NativeTerminalStatus::Failed
        }
        ::matcha_agent::session::receipt::TerminalRunStatus::Interrupted => {
            organization::NativeTerminalStatus::Interrupted
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_run_settled_preserves_missing_final_text() {
        let settled = ::matcha_agent::session::receipt::NativeRunSettled::new(
            ::matcha_agent::session::model::RunId::try_new("run-1").unwrap(),
            ::matcha_agent::session::receipt::TerminalRunStatus::Completed,
            None,
        );

        assert_eq!(native_run_settled(settled).final_assistant_text, None);
    }
}
