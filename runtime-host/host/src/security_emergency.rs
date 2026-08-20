use serde::Serialize;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub(crate) enum SecurityEmergencyOutcome {
    Applied,
    #[serde(rename = "target_rejected")]
    Rejected,
    OutcomeUnknown,
    Unavailable,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::SecurityEmergencyOutcome;

    #[test]
    fn serializes_only_the_sealed_public_outcome() {
        assert_eq!(
            serde_json::to_value(SecurityEmergencyOutcome::OutcomeUnknown).unwrap(),
            json!({ "outcome": "outcome_unknown" })
        );
    }
}
