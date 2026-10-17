use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelControlAction {
    Connect,
    Disconnect,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChannelControlOutcome {
    Confirmed,
    Rejected,
    Unsupported,
    OutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelControlDeliveryOutcome {
    Confirmed,
    TargetRejected,
    Unsupported,
    Unknown,
}

impl From<ChannelControlOutcome> for ChannelControlDeliveryOutcome {
    fn from(value: ChannelControlOutcome) -> Self {
        match value {
            ChannelControlOutcome::Confirmed => Self::Confirmed,
            ChannelControlOutcome::Rejected => Self::TargetRejected,
            ChannelControlOutcome::Unsupported => Self::Unsupported,
            ChannelControlOutcome::OutcomeUnknown => Self::Unknown,
        }
    }
}
