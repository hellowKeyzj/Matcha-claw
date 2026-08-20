use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VERSION: u8 = 1;
pub const MAX_BODY_BYTES: usize = 1_000_000;

#[derive(Debug, Deserialize)]
pub(crate) struct DispatchRequest {
    pub version: u8,
    pub method: String,
    pub route: String,
    #[serde(default)]
    pub payload: Option<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HealthResponse {
    pub version: u8,
    pub ok: bool,
    pub lifecycle: &'static str,
    pub pid: u32,
    pub uptime_sec: u64,
}

#[derive(Debug, Serialize)]
pub(crate) struct DispatchSuccess {
    pub version: u8,
    pub success: bool,
    pub status: u16,
    pub data: Value,
}

#[derive(Debug, Serialize)]
pub(crate) struct DispatchFailure {
    pub version: u8,
    pub success: bool,
    pub status: u16,
    pub error: ErrorBody,
}

#[derive(Debug, Serialize)]
pub(crate) struct ErrorBody {
    pub code: &'static str,
    pub message: String,
}

pub(crate) enum DispatchResponse {
    Success(DispatchSuccess),
    Failure(DispatchFailure),
}

impl std::fmt::Debug for DispatchResponse {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut debug = formatter.debug_struct("DispatchResponse");
        match self {
            Self::Success(value) => debug
                .field("kind", &"Success")
                .field("version", &value.version)
                .field("success", &value.success)
                .field("status", &value.status)
                .field("data", &"<redacted>")
                .finish(),
            Self::Failure(value) => debug
                .field("kind", &"Failure")
                .field("version", &value.version)
                .field("success", &value.success)
                .field("status", &value.status)
                .field("error_code", &value.error.code)
                .field("message", &"<redacted>")
                .finish(),
        }
    }
}

impl DispatchResponse {
    pub(crate) fn bad_request(message: impl Into<String>) -> Self {
        Self::Failure(DispatchFailure {
            version: VERSION,
            success: false,
            status: 400,
            error: ErrorBody {
                code: "BAD_REQUEST",
                message: message.into(),
            },
        })
    }

    pub(crate) fn payload_too_large() -> Self {
        Self::Failure(DispatchFailure {
            version: VERSION,
            success: false,
            status: 413,
            error: ErrorBody {
                code: "PAYLOAD_TOO_LARGE",
                message: format!("Dispatch envelope exceeds {MAX_BODY_BYTES} bytes"),
            },
        })
    }

    pub(crate) fn not_found(method: &str, route: &str) -> Self {
        Self::Failure(DispatchFailure {
            version: VERSION,
            success: false,
            status: 404,
            error: ErrorBody {
                code: "NOT_FOUND",
                message: format!("Runtime Host route not implemented: {method} {route}"),
            },
        })
    }

    pub(crate) fn lifecycle_restart_unavailable() -> Self {
        Self::Failure(DispatchFailure {
            version: VERSION,
            success: false,
            status: 503,
            error: ErrorBody {
                code: "UPSTREAM_UNAVAILABLE",
                message: "Runtime Host lifecycle restart is unavailable".to_owned(),
            },
        })
    }

    pub(crate) fn target_rejected() -> Self {
        Self::Failure(DispatchFailure {
            version: VERSION,
            success: false,
            status: 400,
            error: ErrorBody {
                code: "TARGET_REJECTED",
                message: "Runtime job target is invalid".to_owned(),
            },
        })
    }

    pub(crate) fn internal_error() -> Self {
        Self::Failure(DispatchFailure {
            version: VERSION,
            success: false,
            status: 500,
            error: ErrorBody {
                code: "INTERNAL_ERROR",
                message: "Dispatch handler failed".to_owned(),
            },
        })
    }

    pub(crate) fn status(&self) -> u16 {
        match self {
            Self::Success(value) => value.status,
            Self::Failure(value) => value.status,
        }
    }

    pub(crate) fn into_json(self) -> Value {
        match self {
            Self::Success(value) => {
                serde_json::to_value(value).expect("dispatch response serializable")
            }
            Self::Failure(value) => {
                serde_json::to_value(value).expect("dispatch response serializable")
            }
        }
    }
}
