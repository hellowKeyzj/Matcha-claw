use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroizing;

const MAX_LOGIN_CONFIG_BYTES: usize = 16 * 1024;
const MAX_LOGIN_CONFIG_DEPTH: usize = 8;
const MAX_LOGIN_CONFIG_ENTRIES: usize = 128;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ChannelLoginAction {
    Start {
        force: bool,
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        agent_id: Option<String>,
        config: Zeroizing<Vec<u8>>,
    },
    Wait {
        timeout_ms: Option<u64>,
        account_id: Option<String>,
        session_key: Option<String>,
        current_qr_data_url: Option<String>,
    },
    Cancel {
        account_id: Option<String>,
    },
    Logout {
        account_id: Option<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum LoginProgressStatus {
    Connected,
    Qr,
    Pending,
    Rejected,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct LoginProgress {
    pub(crate) channel: String,
    pub(crate) account_id: Option<String>,
    pub(crate) session_key: Option<String>,
    pub(crate) status: LoginProgressStatus,
    pub(crate) qr_data_url: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Progress(LoginProgress),
    Confirmed,
    Rejected,
    Unsupported,
    Cancelled,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeliveryOutcome {
    Progress,
    Connected,
    TargetRejected,
    Unknown,
}

impl Outcome {
    pub(crate) fn trace_outcome(&self) -> &'static str {
        match self {
            Self::Progress(progress) => match progress.status {
                LoginProgressStatus::Connected => "connected",
                LoginProgressStatus::Qr => "qr",
                LoginProgressStatus::Pending => "pending",
                LoginProgressStatus::Rejected => "rejected",
                LoginProgressStatus::Unknown => "unknown",
            },
            Self::Confirmed => "confirmed",
            Self::Rejected => "rejected",
            Self::Unsupported => "unsupported",
            Self::Cancelled => "cancelled",
            Self::Unknown => "unknown",
        }
    }
}

impl LoginProgress {
    pub(crate) fn new(
        channel: String,
        account_id: Option<String>,
        session_key: Option<String>,
        status: LoginProgressStatus,
        qr_data_url: Option<String>,
    ) -> Self {
        Self {
            channel,
            account_id,
            session_key,
            status,
            qr_data_url,
        }
    }

    pub(crate) fn delivery_outcome(&self) -> DeliveryOutcome {
        match self.status {
            LoginProgressStatus::Connected => DeliveryOutcome::Connected,
            LoginProgressStatus::Qr | LoginProgressStatus::Pending => DeliveryOutcome::Progress,
            LoginProgressStatus::Rejected => DeliveryOutcome::TargetRejected,
            LoginProgressStatus::Unknown => DeliveryOutcome::Unknown,
        }
    }
}

pub(crate) fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| !character.is_control() && !character.is_whitespace())
}

pub(crate) fn valid_timeout(timeout_ms: Option<u64>) -> bool {
    timeout_ms.is_none_or(|value| value > 0 && value <= 300_000)
}

pub(crate) fn valid_qr_data_url(value: &str) -> bool {
    value.starts_with("data:image/png;base64,") && value.len() <= 16_384
}

pub(crate) fn parse_login_config(value: &Value) -> Option<Zeroizing<Vec<u8>>> {
    let Value::Object(object) = value else {
        return None;
    };
    if object.len() > MAX_LOGIN_CONFIG_ENTRIES || !valid_login_config_value(value, 0) {
        return None;
    }
    let bytes = serde_json::to_vec(object).ok()?;
    (bytes.len() <= MAX_LOGIN_CONFIG_BYTES).then(|| Zeroizing::new(bytes))
}

fn valid_login_config_value(value: &Value, depth: usize) -> bool {
    if depth > MAX_LOGIN_CONFIG_DEPTH {
        return false;
    }
    match value {
        Value::Object(object) => {
            object.len() <= MAX_LOGIN_CONFIG_ENTRIES
                && object.iter().all(|(key, value)| {
                    !key.is_empty()
                        && key.len() <= 128
                        && valid_login_config_value(value, depth + 1)
                })
        }
        Value::Array(values) => {
            values.len() <= MAX_LOGIN_CONFIG_ENTRIES
                && values
                    .iter()
                    .all(|value| valid_login_config_value(value, depth + 1))
        }
        Value::String(value) => value.len() <= MAX_LOGIN_CONFIG_BYTES,
        Value::Null | Value::Bool(_) | Value::Number(_) => true,
    }
}

pub(crate) fn project_progress(progress: LoginProgress) -> serde_json::Value {
    let mut body = serde_json::json!({
        "outcome": progress.delivery_outcome(),
        "channel": progress.channel,
    });
    if let Some(account_id) = progress.account_id {
        body["accountId"] = serde_json::Value::String(account_id);
    }
    if let Some(session_key) = progress.session_key {
        body["sessionKey"] = serde_json::Value::String(session_key);
    }
    if let Some(qr_data_url) = progress.qr_data_url {
        if valid_qr_data_url(&qr_data_url) {
            body["qrDataUrl"] = serde_json::Value::String(qr_data_url);
        }
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn qr_is_exactly_png_data_url_and_bounded() {
        assert!(valid_qr_data_url("data:image/png;base64,abc"));
        assert!(!valid_qr_data_url("data:image/svg+xml;base64,abc"));
        assert!(!valid_qr_data_url(&format!(
            "data:image/png;base64,{}",
            "a".repeat(16_384)
        )));
    }

    #[test]
    fn progress_projection_redacts_invalid_qr() {
        let progress = LoginProgress {
            channel: "whatsapp".into(),
            account_id: Some("primary".into()),
            session_key: None,
            status: LoginProgressStatus::Qr,
            qr_data_url: Some("secret-native-error".into()),
        };
        let body = project_progress(progress);
        assert!(!body.to_string().contains("secret-native-error"));
        assert_eq!(body["outcome"], "progress");
    }
}
