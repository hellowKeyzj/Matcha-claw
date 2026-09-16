use tokio::sync::oneshot;

use super::read_model::DesiredReadModel;

pub(crate) enum SettingsQuery {
    DesiredReadModel {
        reply: oneshot::Sender<DesiredReadModel>,
    },
    GatewayAutoStart {
        reply: oneshot::Sender<bool>,
    },
}
