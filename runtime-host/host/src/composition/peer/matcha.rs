use crate::{RuntimeState, runtime::driver::LifecycleOps};

use super::{RestartMatchaError, StartMatchaError, StopMatchaError, actor::PeerShared};

pub(super) async fn autostart(shared: &PeerShared, lifecycle: &dyn LifecycleOps) {
    let result = lifecycle.start().await;
    if result.is_err() {
        shared.record_matcha_start(result);
    }
}

pub(super) async fn start(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, StartMatchaError> {
    if shared.admission().admit_request().is_err() {
        return Err(StartMatchaError::AdmissionClosed);
    }
    let result = lifecycle.start().await;
    shared.record_matcha_start(result.clone());
    super::status::runtime_start_result(result)
        .map(|()| super::status::matcha_state(shared))
        .map_err(|_| StartMatchaError::RuntimeStart)
}

pub(super) async fn stop(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, StopMatchaError> {
    if shared.admission().admit_request().is_err() {
        return Err(StopMatchaError::AdmissionClosed);
    }
    shared.team_run().cancel_matcha_terminal_watches().await;
    let result = lifecycle.stop().await;
    super::status::runtime_stop_result(result)
        .map(|()| super::status::matcha_state(shared))
        .map_err(|_| StopMatchaError::RuntimeStop)
}

pub(super) async fn restart(
    shared: &PeerShared,
    lifecycle: &dyn LifecycleOps,
) -> Result<RuntimeState, RestartMatchaError> {
    if shared.admission().admit_request().is_err() {
        return Err(RestartMatchaError::AdmissionClosed);
    }
    shared.team_run().cancel_matcha_terminal_watches().await;
    let result = lifecycle.restart().await;
    super::status::runtime_restart_result(result)
        .map(|()| super::status::matcha_state(shared))
        .map_err(|_| RestartMatchaError::RuntimeRestart)
}
