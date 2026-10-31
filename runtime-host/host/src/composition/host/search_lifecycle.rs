use foundation::{lifecycle::ModuleScope, process::supervision::SupervisorSnapshot};
use search::ports::{SearchLifecycleFuture, SearchLifecycleSource};
use tokio::sync::watch;

use crate::composition::admission::{HostAdmission, HostPhase, HostState};

pub(super) fn observe_runtime_changes(
    scope: &mut ModuleScope,
    search: &search::SearchModule,
    admission: &HostAdmission,
    openclaw: watch::Receiver<SupervisorSnapshot>,
    openclaw_readiness: watch::Receiver<u64>,
    matcha: watch::Receiver<SupervisorSnapshot>,
) {
    search.observe_runtime_changes(
        scope,
        Box::new(HostLifecycleSource {
            host: admission.subscribe(),
            openclaw,
            openclaw_readiness,
            matcha,
        }),
    );
}

struct HostLifecycleSource {
    host: watch::Receiver<HostState>,
    openclaw: watch::Receiver<SupervisorSnapshot>,
    openclaw_readiness: watch::Receiver<u64>,
    matcha: watch::Receiver<SupervisorSnapshot>,
}

impl SearchLifecycleSource for HostLifecycleSource {
    fn wait_ready(&mut self) -> SearchLifecycleFuture<'_> {
        Box::pin(async move {
            loop {
                match self.host.borrow_and_update().phase() {
                    HostPhase::Ready => return true,
                    HostPhase::ShuttingDown | HostPhase::ShutDown => return false,
                    _ => {}
                }
                if self.host.changed().await.is_err() {
                    return false;
                }
            }
        })
    }

    fn changed(&mut self) -> SearchLifecycleFuture<'_> {
        Box::pin(async move {
            loop {
                if matches!(
                    self.host.borrow().phase(),
                    HostPhase::ShuttingDown | HostPhase::ShutDown
                ) {
                    return false;
                }
                let changed = tokio::select! {
                    changed = self.host.changed() => {
                        if changed.is_err() || matches!(self.host.borrow_and_update().phase(), HostPhase::ShuttingDown | HostPhase::ShutDown) {
                            return false;
                        }
                        continue;
                    }
                    changed = self.openclaw.changed() => changed,
                    changed = self.openclaw_readiness.changed() => changed,
                    changed = self.matcha.changed() => changed,
                };
                return changed.is_ok();
            }
        })
    }
}
