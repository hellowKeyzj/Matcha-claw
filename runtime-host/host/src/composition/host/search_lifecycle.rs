use foundation::{execution::OwnedTask, lifecycle::ModuleScope};
use tokio::sync::watch;

use crate::composition::admission::{HostAdmission, HostPhase};

pub(super) fn observe_runtime_changes(
    scope: &mut ModuleScope,
    search: search::SearchModule,
    admission: &HostAdmission,
    mut openclaw: watch::Receiver<foundation::process::supervision::SupervisorSnapshot>,
    mut openclaw_readiness: watch::Receiver<u64>,
    mut matcha: watch::Receiver<foundation::process::supervision::SupervisorSnapshot>,
) {
    let mut host = admission.subscribe();
    let (mut task, _) = OwnedTask::spawn(|cancellation| async move {
        loop {
            match host.borrow_and_update().phase() {
                HostPhase::Ready => break,
                HostPhase::ShuttingDown | HostPhase::ShutDown => return,
                _ => {}
            }
            tokio::select! {
                _ = cancellation.cancelled() => return,
                changed = host.changed() => if changed.is_err() { return; },
            }
        }
        tokio::select! {
            _ = cancellation.cancelled() => return,
            result = search.start_saved() => {
                if result.is_err() { eprintln!("[search] automatic startup failed"); }
            }
        }
        loop {
            let changed = tokio::select! {
                _ = cancellation.cancelled() => return,
                changed = host.changed() => {
                    if changed.is_err() || matches!(host.borrow_and_update().phase(), HostPhase::ShuttingDown | HostPhase::ShutDown) { return; }
                    continue;
                }
                changed = openclaw.changed() => changed,
                changed = openclaw_readiness.changed() => changed,
                changed = matcha.changed() => changed,
            };
            if changed.is_err() {
                return;
            }
            tokio::select! {
                _ = cancellation.cancelled() => return,
                result = search.reconcile() => {
                    if result.is_err() { eprintln!("[search] native integration reconciliation failed"); }
                }
            }
        }
    });
    scope.register_event_subscription("search-runtime-lifecycle", move || async move {
        let _ = task.cancel_and_join().await;
    });
}
