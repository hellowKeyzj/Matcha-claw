use foundation::process::supervision::StartOutcome;

use crate::composition::runtime_ports::{LifecycleOps, RuntimeStartFailure};

pub(super) async fn autostart(
    lifecycle: &dyn LifecycleOps,
) -> Result<StartOutcome, RuntimeStartFailure> {
    lifecycle.start().await
}
