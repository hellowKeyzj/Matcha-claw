use serde::{Serialize, Serializer, ser::SerializeMap};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SecurityEmergencyOutcome {
    Applied,
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

impl SecurityEmergencyOutcome {
    const fn outcome_code(self) -> &'static str {
        match self {
            Self::Applied => "applied",
            Self::Rejected => "target_rejected",
            Self::OutcomeUnknown => "outcome_unknown",
            Self::Unavailable => "unavailable",
        }
    }
}

impl Serialize for SecurityEmergencyOutcome {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut outcome = serializer.serialize_map(Some(1))?;
        outcome.serialize_entry("outcome", self.outcome_code())?;
        outcome.end()
    }
}
