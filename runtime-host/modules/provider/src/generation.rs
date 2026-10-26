//! Private Rust composition surface. Not a product route or wire contract.

use serde::{Deserialize, Serialize};

use crate::{
    ProviderAccountId, ProviderApiProtocol, ProviderRoutingCapability,
    ProviderTextGenerationModelLimits,
    llm_client::{LlmGenerationOptions, LlmMessage, LlmResponse},
};

#[derive(Clone, Debug)]
pub struct BindingRequest {
    pub model_ref: Option<String>,
    pub capability: ProviderRoutingCapability,
    pub options: LlmGenerationOptions,
    pub strict_reproducibility: bool,
}

/// A single non-secret selection. Only Provider can construct or change it.
#[derive(Clone, Debug)]
pub struct Binding {
    pub(crate) account_id: ProviderAccountId,
    pub(crate) model_id: String,
    pub(crate) selection_id: String,
    pub(crate) account_revision: u64,
    pub(crate) configuration_fingerprint: String,
    pub(crate) capability: ProviderRoutingCapability,
    pub(crate) protocol: ProviderApiProtocol,
    pub(crate) limits: ProviderTextGenerationModelLimits,
    pub(crate) options: LlmGenerationOptions,
    pub(crate) descriptor: BindingDescriptor,
}

/// Non-secret identity of an immutable record issued by this Provider installation.
/// Deserializing this value never constructs a Binding; restore checks the durable record.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct BindingDescriptor(pub(crate) String);

impl Binding {
    pub fn descriptor(&self) -> &BindingDescriptor {
        &self.descriptor
    }
    pub fn account_id(&self) -> &ProviderAccountId {
        &self.account_id
    }
    pub fn model_id(&self) -> &str {
        &self.model_id
    }
    pub fn selection_id(&self) -> &str {
        &self.selection_id
    }
    pub fn account_revision(&self) -> u64 {
        self.account_revision
    }
    pub fn configuration_fingerprint(&self) -> &str {
        &self.configuration_fingerprint
    }
    pub fn capability(&self) -> ProviderRoutingCapability {
        self.capability
    }
    pub fn protocol(&self) -> ProviderApiProtocol {
        self.protocol
    }
    pub fn limits(&self) -> ProviderTextGenerationModelLimits {
        self.limits
    }
    pub fn options(&self) -> &LlmGenerationOptions {
        &self.options
    }
    pub fn remote_version_lock(&self) -> RemoteVersionLock {
        RemoteVersionLock::Unlocked
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteVersionLock {
    /// Current configuration/protocols provide no immutable remote weight lock.
    Unlocked,
}

#[derive(Clone, Debug)]
pub struct BoundRequest {
    pub binding: Binding,
    pub messages: Vec<LlmMessage>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Receipt {
    pub binding_fingerprint: String,
    /// Local audit call identity, never a credential or remote request handle.
    pub call_reference: Option<String>,
    pub response: LlmResponse,
    pub actual_model: Option<String>,
    /// An observed provider revision (e.g. system_fingerprint), not a weight pin.
    pub remote_revision: Option<String>,
    pub remote_call_reference: Option<String>,
    pub state: ReceiptState,
    /// Text bytes acknowledged by the sink, not merely received from upstream.
    pub delivered_text_bytes: u64,
    /// A sink failure/cancellation can leave the last send's delivery uncertain.
    pub delivery_uncertain: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReceiptState {
    Completed,
    Refused,
    Truncated,
    Partial,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Failure {
    pub stage: Stage,
    pub kind: FailureKind,
    pub receipt: Option<Receipt>,
}

impl Failure {
    pub(crate) fn new(stage: Stage, kind: FailureKind) -> Self {
        Self {
            stage,
            kind,
            receipt: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stage {
    Admission,
    Binding,
    Credential,
    Connect,
    Read,
    Output,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FailureKind {
    OwnerUnavailable,
    AuditUnavailable,
    BindingInvalid,
    BindingStale,
    BindingStoreUnavailable { cause: BindingStoreCause },
    NoSelection,
    SelectionUnavailable,
    RemoteVersionUnlocked,
    UnsupportedProtocol,
    UnsupportedParameter { parameter: String },
    UnsupportedAuthentication,
    CredentialMissing,
    CredentialUnavailable,
    Authentication,
    PermissionDenied,
    RateLimited { retry_after: Option<RetryAfter> },
    ConnectDeadline,
    ReadDeadline,
    GenerationDeadline,
    ConnectFailed,
    ReadFailed,
    ProviderRejected { status: Option<u16> },
    ProviderUnavailable { status: Option<u16> },
    Refused,
    Truncated,
    InvalidOutput,
    RemoteUnrecognized { status: Option<u16> },
    Cancelled,
    Sink,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BindingStoreCause {
    Directory,
    Lock,
    Read,
    Write {
        commit_unknown: bool,
        cleanup_failed: bool,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RetryAfter {
    Seconds(u64),
    HttpDate(String),
}
