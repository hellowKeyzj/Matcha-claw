#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Confirmed,
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct Settlement {
    pub(crate) revision: u64,
    pub(crate) outcome: Outcome,
}

impl Outcome {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Unknown => "outcome_unknown",
        }
    }
}

impl From<environment::SecurityPolicyDeliveryOutcome> for Outcome {
    fn from(value: environment::SecurityPolicyDeliveryOutcome) -> Self {
        match value {
            environment::SecurityPolicyDeliveryOutcome::Confirmed => Self::Confirmed,
            environment::SecurityPolicyDeliveryOutcome::Rejected => Self::Rejected,
            environment::SecurityPolicyDeliveryOutcome::Unknown => Self::Unknown,
        }
    }
}

impl From<Outcome> for environment::SecurityPolicyDeliveryOutcome {
    fn from(value: Outcome) -> Self {
        match value {
            Outcome::Confirmed => Self::Confirmed,
            Outcome::Rejected => Self::Rejected,
            Outcome::Unknown => Self::Unknown,
        }
    }
}
