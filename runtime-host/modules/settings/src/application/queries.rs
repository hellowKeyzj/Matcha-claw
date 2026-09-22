use tokio::sync::oneshot;

use crate::projection::public::DesiredReadModel;

pub enum SettingsQuery {
    DesiredReadModel {
        reply: oneshot::Sender<DesiredReadModel>,
    },
    GatewayAutoStart {
        reply: oneshot::Sender<bool>,
    },
}
