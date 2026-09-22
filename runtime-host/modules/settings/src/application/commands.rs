use tokio::sync::oneshot;

use crate::{
    application::receipts::{Outcome, Settlement},
    domain::Desired,
};

pub enum SettingsCommand {
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
