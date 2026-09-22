use std::collections::BTreeMap;

pub const REDACTED_VALUE: &str = "[redacted]";

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FleetAuditValue {
    Text(String),
    Integer(i64),
    Boolean(bool),
    List(Vec<Self>),
    Fields(BTreeMap<String, Self>),
}

impl FleetAuditValue {
    pub(super) fn redacted(&self) -> Self {
        match self {
            Self::Text(value) => Self::Text(redact_text(value)),
            Self::Integer(value) => Self::Integer(*value),
            Self::Boolean(value) => Self::Boolean(*value),
            Self::List(values) => Self::List(values.iter().map(Self::redacted).collect()),
            Self::Fields(fields) => Self::Fields(redact_fields(fields)),
        }
    }
}

pub(super) fn redact_fields(
    fields: &BTreeMap<String, FleetAuditValue>,
) -> BTreeMap<String, FleetAuditValue> {
    fields
        .iter()
        .map(|(key, value)| {
            let value = if is_sensitive_key(key) {
                FleetAuditValue::Text(REDACTED_VALUE.to_owned())
            } else {
                value.redacted()
            };
            (key.clone(), value)
        })
        .collect()
}

pub(super) fn redact_text(value: &str) -> String {
    if contains_secret_reference(value)
        || contains_sensitive_assignment(value)
        || contains_authorization_scheme(value)
        || contains_known_secret_token(value)
    {
        REDACTED_VALUE.to_owned()
    } else {
        value.to_owned()
    }
}

fn is_sensitive_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    [
        "token",
        "secret",
        "authorization",
        "apikey",
        "api_key",
        "api-key",
        "privatekey",
        "private_key",
        "private-key",
        "password",
    ]
    .iter()
    .any(|fragment| key.contains(fragment))
}

fn contains_secret_reference(value: &str) -> bool {
    value.to_ascii_lowercase().contains("remote-fleet://")
}

fn contains_sensitive_assignment(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    let terms = [
        "authorization",
        "privatekey",
        "private_key",
        "private-key",
        "apikey",
        "api_key",
        "api-key",
        "password",
        "secret",
        "token",
    ];

    terms.iter().any(|term| {
        let mut offset = 0;
        while let Some(relative) = value[offset..].find(term) {
            let start = offset + relative;
            let end = start + term.len();
            let suffix = &value[end..];
            if suffix.trim_start().starts_with([':', '=']) {
                return true;
            }
            if value[..start].ends_with("--")
                && suffix.starts_with(char::is_whitespace)
                && !suffix.trim().is_empty()
            {
                return true;
            }
            offset = end;
        }
        false
    })
}

fn contains_authorization_scheme(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    ["bearer", "basic", "token"].iter().any(|scheme| {
        value
            .find(scheme)
            .map(|offset| {
                let suffix = &value[offset + scheme.len()..];
                suffix.starts_with(char::is_whitespace) && !suffix.trim().is_empty()
            })
            .unwrap_or(false)
    })
}

fn contains_known_secret_token(value: &str) -> bool {
    let value = value.to_ascii_lowercase();
    ["sk-", "mrf_"].iter().any(|prefix| {
        let mut offset = 0;
        while let Some(relative) = value[offset..].find(prefix) {
            let start = offset + relative + prefix.len();
            let length = value[start..]
                .bytes()
                .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                .count();
            if length >= 9 {
                return true;
            }
            offset = start;
        }
        false
    })
}
