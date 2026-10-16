use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    fmt,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

pub type Result<T = Value> = std::result::Result<T, Error>;

#[derive(Clone, Serialize)]
pub struct Error {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(skip)]
    source: Option<Arc<dyn std::error::Error + Send + Sync>>,
}

impl Error {
    pub fn new(code: i64, kind: &str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            data: Some(json!({ "kind": kind })),
            source: None,
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(-32602, "invalid_params", message)
    }

    pub fn not_found(resource: &str) -> Self {
        Self::new(-32001, "not_found", format!("{resource} was not found"))
    }

    pub fn conflict(kind: &str, message: impl Into<String>) -> Self {
        Self::new(-32002, kind, message)
    }

    pub fn unavailable(kind: &str, message: impl Into<String>) -> Self {
        Self::new(-32003, kind, message)
    }

    pub fn internal(kind: &str) -> Self {
        Self::new(
            -32603,
            kind,
            "An internal operation failed; inspect diagnostics",
        )
    }

    pub fn method(_method: &str) -> Self {
        Self::new(-32601, "method_not_found", "Method not found")
    }

    pub fn with_source(mut self, source: impl std::error::Error + Send + Sync + 'static) -> Self {
        self.source = Some(Arc::new(source));
        self
    }

    pub fn with_data(mut self, data: Value) -> Self {
        match (&mut self.data, data) {
            (Some(Value::Object(current)), Value::Object(extra)) => {
                for (key, value) in extra {
                    if key != "kind" {
                        current.insert(key, value);
                    }
                }
            }
            (current, extra) => {
                let kind = current.as_ref().and_then(|v| v.get("kind")).cloned();
                *current = Some(json!({ "kind": kind, "detail": extra }));
            }
        }
        self
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.message, self.code)
    }
}

impl fmt::Debug for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Error")
            .field("code", &self.code)
            .field("message", &self.message)
            .field("data", &self.data)
            .field("has_source", &self.source.is_some())
            .finish()
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn std::error::Error + 'static))
    }
}

pub fn params<T: DeserializeOwned>(value: Value) -> Result<T> {
    serde_json::from_value(value).map_err(|error| {
        Error::invalid("Parameters do not match the method schema").with_source(error)
    })
}

pub fn value<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value)
        .map_err(|error| Error::internal("response_encode").with_source(error))
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock predates Unix epoch")
        .as_millis()
        .try_into()
        .expect("timestamp exceeds u64 milliseconds")
}
