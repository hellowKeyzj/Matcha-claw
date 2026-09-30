use std::{fmt, future::Future, marker::PhantomData, pin::Pin, sync::Arc};

use serde::{Deserialize, Serialize};

pub const MAX_DETAIL_BYTES: usize = 8 * 1024;
pub const MAX_PAGE_SIZE: u32 = 200;

#[derive(Clone, Debug, Eq, Hash, PartialEq, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct CallId(String);

impl CallId {
    pub fn parse(value: &str) -> Result<Self, CallLogError> {
        if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(CallLogError::InvalidInput);
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl TryFrom<String> for CallId {
    type Error = CallLogError;

    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::parse(&value)
    }
}

impl From<CallId> for String {
    fn from(value: CallId) -> Self {
        value.0
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CallStatus {
    Received,
    Accepted,
    Running,
    Waiting,
    Succeeded,
    Failed,
    Rejected,
    Unknown,
}

impl CallStatus {
    pub const fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Succeeded | Self::Failed | Self::Rejected | Self::Unknown
        )
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Received => "received",
            Self::Accepted => "accepted",
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Rejected => "rejected",
            Self::Unknown => "unknown",
        }
    }
}

/// Implement on a module-owned, secret-safe summary, never its request or native result.
pub trait CallDetail: Serialize + Send + Sync + 'static {
    const MODULE: &'static str;
}

#[derive(Clone, Debug, Serialize)]
#[serde(transparent)]
pub struct ErasedCallDetail(serde_json::Value);

impl ErasedCallDetail {
    pub fn from_detail<D: CallDetail>(detail: &D) -> Result<Self, CallLogError> {
        let mut encoded = LimitedSummary(Vec::new());
        serde_json::to_writer(&mut encoded, detail).map_err(|_| CallLogError::InvalidInput)?;
        Self::decode(&encoded.0)
    }

    pub fn decode(encoded: &[u8]) -> Result<Self, CallLogError> {
        if encoded.len() > MAX_DETAIL_BYTES {
            return Err(CallLogError::InvalidInput);
        }
        let summary: serde_json::Value =
            serde_json::from_slice(encoded).map_err(|_| CallLogError::InvalidInput)?;
        if !summary.is_object() {
            return Err(CallLogError::InvalidInput);
        }
        Ok(Self(summary))
    }

    pub fn encode(&self) -> Result<String, CallLogError> {
        serde_json::to_string(&self.0).map_err(|_| CallLogError::InvalidInput)
    }
}

struct LimitedSummary(Vec<u8>);

impl std::io::Write for LimitedSummary {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_DETAIL_BYTES - self.0.len() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "Call summary is too large",
            ));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRecord<D = ErasedCallDetail> {
    pub call_id: CallId,
    pub module: String,
    pub command: String,
    pub status: CallStatus,
    pub start: u64,
    pub end: Option<u64>,
    pub revision: u64,
    pub detail: D,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallReceipt {
    pub call_id: CallId,
    pub accepted: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CallChanged {
    pub call_id: CallId,
    pub revision: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CallQuery {
    pub module: Option<String>,
    pub status: Option<CallStatus>,
    pub before: Option<CallId>,
    pub limit: u32,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallPage {
    pub items: Vec<CallRecord>,
    pub next: Option<CallId>,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallTransition {
    pub revision: u64,
    pub status: CallStatus,
    pub at: u64,
    pub detail: ErasedCallDetail,
}

#[derive(Clone, Debug, Serialize)]
pub struct CallHistory {
    pub items: Vec<CallTransition>,
    pub next: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CallLogError {
    InvalidInput,
    QueueFull,
    Unavailable,
    PersistFailed,
    NotFound,
    InvalidTransition,
}

impl fmt::Display for CallLogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Call log input is invalid",
            Self::QueueFull => "Call log queue is full",
            Self::Unavailable => "Call log is unavailable",
            Self::PersistFailed => "Call log could not be persisted",
            Self::NotFound => "Call record was not found",
            Self::InvalidTransition => "Call status transition is invalid",
        })
    }
}

impl std::error::Error for CallLogError {}

pub type CallFuture<T> = Pin<Box<dyn Future<Output = Result<T, CallLogError>> + Send>>;

pub struct CallBegin {
    pub module: &'static str,
    pub command: &'static str,
    pub detail: ErasedCallDetail,
}

pub struct CallAppend {
    pub call_id: CallId,
    pub status: Option<CallStatus>,
    pub detail: Option<ErasedCallDetail>,
}

/// Persistence boundary only: it cannot accept executable work or business results.
pub trait CallLog: Send + Sync {
    fn begin(&self, call: CallBegin) -> CallFuture<CallId>;
    fn append(&self, change: CallAppend) -> CallFuture<()>;
}

#[derive(Clone)]
pub struct CallRecorder {
    log: Arc<dyn CallLog>,
}

impl CallRecorder {
    pub fn new(log: Arc<dyn CallLog>) -> Self {
        Self { log }
    }

    pub async fn begin<D: CallDetail>(
        &self,
        command: &'static str,
        detail: &D,
    ) -> Result<CallContext<D>, CallLogError> {
        if !valid_label(D::MODULE) || !valid_label(command) {
            return Err(CallLogError::InvalidInput);
        }
        let call_id = self
            .log
            .begin(CallBegin {
                module: D::MODULE,
                command,
                detail: ErasedCallDetail::from_detail(detail)?,
            })
            .await?;
        Ok(CallContext {
            call_id,
            log: self.log.clone(),
            detail: PhantomData,
        })
    }
}

fn valid_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_' | b':'))
}

/// Pass explicitly into the owner command. Dropping an HTTP future changes no audit status.
pub struct CallContext<D: CallDetail> {
    call_id: CallId,
    log: Arc<dyn CallLog>,
    detail: PhantomData<fn() -> D>,
}

impl<D: CallDetail> Clone for CallContext<D> {
    fn clone(&self) -> Self {
        Self {
            call_id: self.call_id.clone(),
            log: self.log.clone(),
            detail: PhantomData,
        }
    }
}

impl<D: CallDetail> CallContext<D> {
    pub fn id(&self) -> &CallId {
        &self.call_id
    }

    /// Call only after the concrete owner's bounded queue accepted the command.
    pub async fn accepted(&self) -> Result<CallReceipt, CallLogError> {
        self.append(Some(CallStatus::Accepted), None).await?;
        Ok(CallReceipt {
            call_id: self.call_id.clone(),
            accepted: true,
        })
    }

    pub async fn running(&self) -> Result<(), CallLogError> {
        self.append(Some(CallStatus::Running), None).await
    }

    pub async fn waiting(&self) -> Result<(), CallLogError> {
        self.append(Some(CallStatus::Waiting), None).await
    }

    pub async fn update(&self, detail: &D) -> Result<(), CallLogError> {
        self.append(None, Some(ErasedCallDetail::from_detail(detail)?))
            .await
    }

    pub async fn finish(&self, status: CallStatus, detail: &D) -> Result<(), CallLogError> {
        if !status.is_terminal() {
            return Err(CallLogError::InvalidTransition);
        }
        self.append(Some(status), Some(ErasedCallDetail::from_detail(detail)?))
            .await
    }

    async fn append(
        &self,
        status: Option<CallStatus>,
        detail: Option<ErasedCallDetail>,
    ) -> Result<(), CallLogError> {
        self.log
            .append(CallAppend {
                call_id: self.call_id.clone(),
                status,
                detail,
            })
            .await
    }
}
