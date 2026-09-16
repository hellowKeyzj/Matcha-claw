use tokio::sync::oneshot;

use environment::settings::{Desired, Outcome, Settlement};

pub(crate) enum SettingsCommand {
    ReplaceDesired {
        correlation: String,
        desired: Desired,
        reply: oneshot::Sender<Settlement>,
    },
    RecoverPendingProjection {
        reply: oneshot::Sender<()>,
    },
    ApplySavedProjection {
        reply: oneshot::Sender<Outcome>,
    },
}
