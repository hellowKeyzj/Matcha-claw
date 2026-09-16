use std::collections::BTreeMap;

use serde::Serialize;

use crate::public_string;

const MAX_IDENTITY_CHARACTERS: usize = 128;
const MAX_VALUES: usize = 64;
const MAX_VALUE_BYTES: usize = 131_072;
const MAX_TOTAL_VALUE_BYTES: usize = 262_144;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct Projection {
    values: BTreeMap<String, String>,
}

impl Projection {
    pub(crate) fn from_source(values: BTreeMap<String, String>) -> Result<Self, ()> {
        if values.len() > MAX_VALUES {
            return Err(());
        }
        let mut total_bytes = 0;
        for (key, value) in &values {
            if !valid_identity(key)
                || public_string::sensitive_key(key)
                || value.len() > MAX_VALUE_BYTES
                || public_string::contains_private_fragment(value)
            {
                return Err(());
            }
            total_bytes += value.len();
            if total_bytes > MAX_TOTAL_VALUE_BYTES {
                return Err(());
            }
        }
        Ok(Self { values })
    }

    pub(crate) fn values(&self) -> &BTreeMap<String, String> {
        &self.values
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Values(Projection),
    TargetRejected,
    Unavailable,
    Unknown,
}

pub(crate) fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.chars().count() <= MAX_IDENTITY_CHARACTERS
        && !value.contains('/')
        && !value.contains('\\')
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn projection_serializes_source_backed_safe_scalar_values() {
        let projection = Projection::from_source(BTreeMap::from([
            ("enabled".into(), "true".into()),
            ("serverUrl".into(), "https://chat.example.test".into()),
        ]))
        .unwrap();

        assert_eq!(
            serde_json::to_value(projection).unwrap(),
            json!({
                "values": {
                    "enabled": "true",
                    "serverUrl": "https://chat.example.test",
                },
            }),
        );
    }

    #[test]
    fn projection_rejects_secret_bearing_or_unbounded_source_values() {
        for key in [
            "apiKey",
            "access_key",
            "authorization",
            "botToken",
            "clientSecret",
            "credential",
            "password",
            "private-key",
            "errorMessage",
        ] {
            assert!(
                Projection::from_source(BTreeMap::from([
                    (key.to_owned(), "candidate".to_owned(),)
                ]))
                .is_err()
            );
        }
        assert!(
            Projection::from_source(BTreeMap::from([(
                "description".into(),
                "x".repeat(MAX_VALUE_BYTES + 1),
            )]))
            .is_err()
        );
        assert!(
            Projection::from_source(BTreeMap::from([(
                "home".into(),
                "C:\\Users\\me\\private.txt".into(),
            )]))
            .is_err()
        );
    }

    #[test]
    fn projection_enforces_source_collection_bounds() {
        let at_value_limit = (0..MAX_VALUES)
            .map(|index| (format!("field{index}"), "value".to_owned()))
            .collect();
        assert!(Projection::from_source(at_value_limit).is_ok());

        let over_value_limit = (0..=MAX_VALUES)
            .map(|index| (format!("field{index}"), "value".to_owned()))
            .collect();
        assert!(Projection::from_source(over_value_limit).is_err());

        assert!(
            Projection::from_source(BTreeMap::from([
                ("first".into(), "x".repeat(MAX_VALUE_BYTES)),
                ("second".into(), "x".repeat(MAX_VALUE_BYTES)),
            ]))
            .is_ok()
        );
        assert!(
            Projection::from_source(BTreeMap::from([
                ("first".into(), "x".repeat(MAX_VALUE_BYTES)),
                ("second".into(), "x".repeat(MAX_VALUE_BYTES - 1)),
                ("third".into(), "xx".into()),
            ]))
            .is_err()
        );
    }

    #[test]
    fn identity_rejects_route_separators_whitespace_and_controls() {
        for value in [
            "",
            " leading",
            "trailing ",
            "two words",
            "nested/channel",
            "nested\\channel",
            "line\nbreak",
        ] {
            assert!(!valid_identity(value), "{value:?}");
        }
        assert!(!valid_identity(&"a".repeat(MAX_IDENTITY_CHARACTERS + 1)));
        assert!(valid_identity("discord.primary-1"));
    }

    #[test]
    fn terminal_outcomes_remain_distinct() {
        let projection = Projection::from_source(BTreeMap::new()).unwrap();
        assert!(matches!(Outcome::Values(projection), Outcome::Values(_)));
        assert!(matches!(Outcome::TargetRejected, Outcome::TargetRejected));
        assert!(matches!(Outcome::Unavailable, Outcome::Unavailable));
        assert!(matches!(Outcome::Unknown, Outcome::Unknown));
    }
}
