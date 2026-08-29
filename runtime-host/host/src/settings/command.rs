use tokio::sync::oneshot;

use super::desired::{Desired, Outcome, Settlement};

pub(crate) enum SettingsCommand {
    Replace {
        correlation: String,
        desired: Desired,
        reply: oneshot::Sender<Settlement>,
    },
    RecoverPending {
        reply: oneshot::Sender<Option<Settlement>>,
    },
    ApplySavedProjection {
        reply: oneshot::Sender<Outcome>,
    },
}
