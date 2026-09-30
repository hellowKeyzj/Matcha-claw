use platform::call::CallContext;
use tokio::sync::oneshot;

use crate::{
    application::{call::SettingsCallDetail, receipts::Outcome},
    domain::Desired,
};

pub enum SettingsCommand {
    ReplaceDesired {
        correlation: String,
        desired: Desired,
        call: CallContext<SettingsCallDetail>,
    },
    RecoverPendingProjection {
        reply: oneshot::Sender<()>,
    },
    ApplySavedProjection {
        reply: oneshot::Sender<Outcome>,
    },
}
