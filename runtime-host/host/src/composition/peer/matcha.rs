use crate::composition::runtime_ports::LifecycleOps;

use super::actor::PeerShared;

pub(super) async fn autostart(shared: &PeerShared, lifecycle: &dyn LifecycleOps) {
    let result = lifecycle.start().await;
    if result.is_err() {
        shared.record_matcha_start(result);
    }
}
