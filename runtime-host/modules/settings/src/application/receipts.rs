#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
pub enum Outcome {
    #[serde(rename = "confirmed")]
    Confirmed,
    #[serde(rename = "rejected")]
    Rejected,
    #[serde(rename = "outcome_unknown")]
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize)]
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
