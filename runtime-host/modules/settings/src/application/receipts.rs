#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Outcome {
    Confirmed,
    Rejected,
    Unknown,
}

impl Outcome {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Unknown => "outcome_unknown",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Settlement {
    pub revision: u64,
    pub outcome: Outcome,
}

impl Settlement {
    pub const fn unknown(revision: u64) -> Self {
        Self {
            revision,
            outcome: Outcome::Unknown,
        }
    }
}
