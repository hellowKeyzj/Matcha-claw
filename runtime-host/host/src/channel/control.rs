use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChannelControlAction {
    Connect,
    Disconnect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ChannelControlOutcome {
    Confirmed,
    Rejected,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChannelControlDeliveryOutcome {
    Confirmed,
    TargetRejected,
    Unknown,
}

impl From<ChannelControlOutcome> for ChannelControlDeliveryOutcome {
    fn from(value: ChannelControlOutcome) -> Self {
        match value {
            ChannelControlOutcome::Confirmed => Self::Confirmed,
            ChannelControlOutcome::Rejected => Self::TargetRejected,
            ChannelControlOutcome::OutcomeUnknown => Self::Unknown,
        }
    }
}
