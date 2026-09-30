use platform::call::{CallContext, CallLogError};
use tokio::sync::oneshot;

use crate::{application::call::SettingsCallDetail, projection::public::DesiredReadModel};

pub enum SettingsQuery {
    DesiredReadModel {
        call: CallContext<SettingsCallDetail>,
        reply: oneshot::Sender<Result<DesiredReadModel, CallLogError>>,
    },
    GatewayAutoStart {
        reply: oneshot::Sender<bool>,
    },
}
