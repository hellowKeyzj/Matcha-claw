use tokio::sync::oneshot;

use super::desired::{PendingDesired, PublicDesiredSnapshot};

pub(crate) enum SettingsQuery {
    Pending {
        reply: oneshot::Sender<Option<PendingDesired>>,
    },
    DesiredSnapshot {
        reply: oneshot::Sender<PublicDesiredSnapshot>,
    },
    GatewayAutoStart {
        reply: oneshot::Sender<bool>,
    },
}
