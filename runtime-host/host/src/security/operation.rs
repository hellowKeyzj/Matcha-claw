use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Outcome {
    Confirmed(Value),
    Rejected,
    Unavailable,
    Unknown,
}

impl Outcome {
    pub(crate) fn from_native(effect: openclaw::operations::SecurityActionEffect) -> Self {
        match effect {
            openclaw::operations::SecurityActionEffect::Applied(value) => Self::Confirmed(value),
            openclaw::operations::SecurityActionEffect::RuntimeRejected => Self::Rejected,
            openclaw::operations::SecurityActionEffect::Unavailable => Self::Unavailable,
            openclaw::operations::SecurityActionEffect::OutcomeUnknown => Self::Unknown,
        }
    }
}

impl From<environment::SecurityOperationOutcome> for Outcome {
    fn from(value: environment::SecurityOperationOutcome) -> Self {
        match value {
            environment::SecurityOperationOutcome::Confirmed(body) => Self::Confirmed(body),
            environment::SecurityOperationOutcome::Rejected => Self::Rejected,
            environment::SecurityOperationOutcome::Unavailable => Self::Unavailable,
            environment::SecurityOperationOutcome::Unknown => Self::Unknown,
        }
    }
}

impl From<Outcome> for environment::SecurityOperationOutcome {
    fn from(value: Outcome) -> Self {
        match value {
            Outcome::Confirmed(body) => Self::Confirmed(body),
            Outcome::Rejected => Self::Rejected,
            Outcome::Unavailable => Self::Unavailable,
            Outcome::Unknown => Self::Unknown,
        }
    }
}
