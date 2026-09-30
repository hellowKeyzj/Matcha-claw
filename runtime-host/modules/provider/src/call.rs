use std::sync::Arc;

use platform::call::{
    CallContext, CallDetail, CallLogError, CallReceipt, CallRecorder, CallStatus,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{OnceCell, oneshot};

use crate::{
    ProviderTextGenerationModelLimitsOutcome, ProviderTextGenerationOutcome,
    application::receipts::*,
};

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderCallKind {
    ListAccounts,
    GetAccount,
    ReplaceAccount,
    DeleteAccount,
    ListModels,
    SelectableModels,
    DiscoverModels,
    ReplaceModels,
    ListRouting,
    ReplaceRouting,
    TextGenerationModelLimits,
    GenerateText,
    SelectSessionModel,
    SelectMatchaSessionModelRuntime,
    AcceptSessionRuntimeModels,
    SelectSessionModelRebound,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderCallDetail {
    kind: ProviderCallKind,
    phase: ProviderCallPhase,
    outcome: Option<ProviderCallResult>,
    count: Option<usize>,
    accepted_count: Option<usize>,
    persisted: Option<ProviderCallPersisted>,
    commit: Option<ProviderCallCommit>,
    account_id: Option<String>,
    account_revision: Option<u64>,
    diagnostic: Option<ProviderCallDiagnostic>,
    native: Option<ProviderNativeCallDetail>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProviderCallPhase {
    Received,
    Running,
    Native,
    Terminal,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProviderCallResult {
    Available,
    Stored,
    Deleted,
    Unknown,
    Rejected,
    Missing,
    Unavailable,
    Discovered,
    Selected,
    Unsupported,
    Accepted,
    Generated,
    Cancelled,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProviderCallPersisted {
    Confirmed,
    Unknown,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
enum ProviderCallCommit {
    Committed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProviderCallDiagnosticReason {
    InvalidProviderKey,
    ConfigSnapshotUnavailable,
    InvalidConfigDocument,
    ProjectionSerializeFailed,
    ConfigDocumentInvalid,
    RequestBuildFailed,
    ConfigReadbackUnavailable,
    ConfigReadbackMismatch,
    GatewayWriteRejected,
    GatewayWriteUnknown,
    ProviderAccountConfigurationInvalid,
    ProviderCredentialUnavailable,
    ProviderKeyDuplicate,
    ProviderModelCapabilityInvalid,
    ProviderModelIdentifierInvalid,
    ProviderModelTokenLimitInvalid,
    ProviderModelPersistenceFailed,
    ProviderRoutingAccountUnavailable,
    ProviderRoutingCredentialUnavailable,
    ProviderRoutingInvalid,
    ProviderRoutingModelCapabilityUnavailable,
    ProviderRoutingModelUnavailable,
    ProviderRoutingPersistenceFailed,
    PrivateProfileDeadline,
    PrivateProfileCredentialMissing,
    PrivateProfileInvalidProviderKey,
    PrivateResolverUnavailable,
    PrivateTransactionSettleFailed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProviderCallPrivateResolverCode {
    InvalidRequest,
    CredentialMissing,
    CredentialDecryptFailed,
    CredentialProviderMismatch,
    CredentialInvalid,
    AuthProfileReadInvalid,
    AuthProfileWriteFailed,
    CredentialStoreUnavailable,
    Unknown,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderCallDiagnostic {
    reason: Option<ProviderCallDiagnosticReason>,
    private_resolver_code: Option<ProviderCallPrivateResolverCode>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderNativeCallDetail {
    changed: bool,
    applied: &'static str,
    observed: &'static str,
}

impl CallDetail for ProviderCallDetail {
    const MODULE: &'static str = "provider";
}

#[derive(Clone)]
pub(crate) struct ProviderCall {
    context: CallContext<ProviderCallDetail>,
    detail: ProviderCallDetail,
    admission: Arc<OnceCell<Result<CallReceipt, CallLogError>>>,
}

impl ProviderCall {
    pub(crate) async fn begin(
        recorder: Option<&CallRecorder>,
        kind: ProviderCallKind,
        command: &'static str,
    ) -> Result<Option<Self>, ()> {
        let Some(recorder) = recorder else {
            return Ok(None);
        };
        let detail = ProviderCallDetail {
            kind,
            phase: ProviderCallPhase::Received,
            outcome: None,
            count: None,
            accepted_count: None,
            persisted: None,
            commit: None,
            account_id: None,
            account_revision: None,
            diagnostic: None,
            native: None,
        };
        let context = recorder.begin(command, &detail).await.map_err(|error| {
            eprintln!("[provider-call] phase=begin command={command} error={error}");
        })?;
        Ok(Some(Self {
            context,
            detail,
            admission: Arc::new(OnceCell::new()),
        }))
    }

    pub(crate) fn id(&self) -> &platform::call::CallId {
        self.context.id()
    }

    pub(crate) fn account(
        &mut self,
        account_id: Option<&crate::ProviderAccountId>,
        revision: Option<u64>,
    ) {
        self.detail.account_id = account_id.map(|id| id.as_str().to_owned());
        self.detail.account_revision = revision;
    }

    pub(crate) fn diagnostic(
        &mut self,
        reason: ProviderCallDiagnosticReason,
        code: Option<ProviderCallPrivateResolverCode>,
    ) {
        self.detail.diagnostic = Some(ProviderCallDiagnostic {
            reason: Some(reason),
            private_resolver_code: code,
        });
    }

    pub(crate) async fn accepted(&self) -> Result<CallReceipt, ()> {
        self.admission
            .get_or_init(|| self.context.accepted())
            .await
            .clone()
            .map_err(|error| {
                self.log_error("accepted", error);
            })
    }

    pub(crate) async fn start(call: &mut Option<Self>) -> Result<(), ()> {
        let Some(call) = call else {
            return Ok(());
        };
        // Admission is shared with the caller, but never depends on the HTTP future.
        call.accepted().await?;
        if let Err(error) = call.context.running().await {
            call.log_error("running", error);
            return Err(());
        }
        call.detail.phase = ProviderCallPhase::Running;
        if let Err(error) = call.context.update(&call.detail).await {
            call.log_error("running-detail", error);
            return Err(());
        }
        Ok(())
    }

    pub(crate) async fn persisted(
        call: &mut Option<Self>,
        persisted: ProviderPersistedOutcome,
        commit: ProviderCommitOutcome,
    ) {
        let Some(call) = call else {
            return;
        };
        call.detail.phase = ProviderCallPhase::Native;
        call.detail.persistence(persisted, commit);
        if let Err(error) = call.context.update(&call.detail).await {
            call.log_error("persisted", error);
        }
    }

    pub(crate) async fn not_admitted(mut call: Option<Self>) {
        let Some(call) = call.as_mut() else {
            return;
        };
        call.detail.phase = ProviderCallPhase::Terminal;
        call.detail.outcome = Some(ProviderCallResult::Unavailable);
        if let Err(error) = call
            .context
            .finish(CallStatus::Rejected, &call.detail)
            .await
        {
            call.log_error("not-admitted", error);
        }
    }

    fn log_error(&self, phase: &str, error: platform::call::CallLogError) {
        eprintln!(
            "[provider-call] call_id={} phase={phase} error={error}",
            self.context.id().as_str()
        );
    }
}

impl ProviderCallDetail {
    fn persistence(&mut self, persisted: ProviderPersistedOutcome, commit: ProviderCommitOutcome) {
        self.persisted = Some(match persisted {
            ProviderPersistedOutcome::Confirmed => ProviderCallPersisted::Confirmed,
            ProviderPersistedOutcome::Unknown => ProviderCallPersisted::Unknown,
        });
        self.commit = Some(match commit {
            ProviderCommitOutcome::Committed => ProviderCallCommit::Committed,
            ProviderCommitOutcome::CommitOutcomeUnknown => ProviderCallCommit::Unknown,
        });
    }

    fn mutation(
        &mut self,
        persisted: ProviderPersistedOutcome,
        commit: ProviderCommitOutcome,
        native: &ProviderNativeConfigurationView,
    ) -> CallStatus {
        self.persistence(persisted, commit);
        if let Some(diagnostic) = &native.diagnostic
            && self.diagnostic.is_none()
        {
            self.diagnostic = Some(ProviderCallDiagnostic {
                reason: Some(
                    serde_json::from_value(serde_json::Value::String(diagnostic.reason.clone()))
                        .unwrap_or(ProviderCallDiagnosticReason::Unknown),
                ),
                private_resolver_code: None,
            });
        }
        self.native = Some(ProviderNativeCallDetail {
            changed: native.changed,
            applied: native.applied,
            observed: native.observed,
        });
        if persisted == ProviderPersistedOutcome::Unknown
            || commit == ProviderCommitOutcome::CommitOutcomeUnknown
            || native.applied == "unknown"
            || native.observed == "unavailable"
        {
            CallStatus::Unknown
        } else if native.observed == "mismatch" {
            CallStatus::Failed
        } else {
            CallStatus::Succeeded
        }
    }
}

pub(crate) trait ProviderCallOutcome {
    fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus;
}

pub(crate) async fn send_reply<T: ProviderCallOutcome>(
    mut call: Option<ProviderCall>,
    reply: oneshot::Sender<T>,
    outcome: T,
) {
    if let Some(call) = call.as_mut() {
        call.detail.phase = ProviderCallPhase::Terminal;
        let mut status = outcome.summarize(&mut call.detail);
        if call.detail.diagnostic.as_ref().is_some_and(|diagnostic| {
            matches!(
                diagnostic.reason,
                Some(ProviderCallDiagnosticReason::PrivateTransactionSettleFailed)
            )
        }) {
            status = CallStatus::Unknown;
        }
        if let Err(error) = call.context.finish(status, &call.detail).await {
            // The business outcome is already authoritative; audit I/O cannot undo a commit.
            call.log_error("terminal", error);
        }
    }
    let _ = reply.send(outcome);
}

impl ProviderCallOutcome for ProviderAccountsDelivery {
    fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus {
        match self {
            Self::List(accounts) => {
                detail.outcome = Some(ProviderCallResult::Available);
                detail.count = Some(accounts.len());
                CallStatus::Succeeded
            }
            Self::Account(_) => {
                detail.outcome = Some(ProviderCallResult::Available);
                CallStatus::Succeeded
            }
            Self::Stored {
                persisted,
                commit,
                native,
                ..
            } => {
                detail.outcome = Some(ProviderCallResult::Stored);
                detail.mutation(*persisted, *commit, native)
            }
            Self::Deleted {
                persisted,
                commit,
                native,
            } => {
                detail.outcome = Some(ProviderCallResult::Deleted);
                detail.mutation(*persisted, *commit, native)
            }
            Self::Unknown {
                persisted,
                commit,
                native,
                ..
            } => {
                detail.outcome = Some(ProviderCallResult::Unknown);
                detail.mutation(*persisted, *commit, native);
                CallStatus::Unknown
            }
            Self::Rejected => {
                detail.outcome = Some(ProviderCallResult::Rejected);
                CallStatus::Rejected
            }
            Self::Missing => {
                detail.outcome = Some(ProviderCallResult::Missing);
                CallStatus::Rejected
            }
            Self::Unavailable => {
                detail.outcome = Some(ProviderCallResult::Unavailable);
                CallStatus::Failed
            }
        }
    }
}

macro_rules! list_outcome {
    ($outcome:ty, $available:ident) => {
        impl ProviderCallOutcome for $outcome {
            fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus {
                match self {
                    Self::$available(items) => {
                        detail.outcome = Some(ProviderCallResult::Available);
                        detail.count = Some(items.len());
                        CallStatus::Succeeded
                    }
                    Self::Unavailable => {
                        detail.outcome = Some(ProviderCallResult::Unavailable);
                        CallStatus::Failed
                    }
                }
            }
        }
    };
}
list_outcome!(ProviderModelListOutcome, Available);
list_outcome!(ProviderModelSelectableOutcome, Available);

impl ProviderCallOutcome for ProviderModelDiscoverOutcome {
    fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus {
        match self {
            Self::Discovered(items) => {
                detail.outcome = Some(ProviderCallResult::Discovered);
                detail.count = Some(items.len());
                CallStatus::Succeeded
            }
            Self::Rejected => {
                detail.outcome = Some(ProviderCallResult::Rejected);
                CallStatus::Rejected
            }
            Self::Unavailable => {
                detail.outcome = Some(ProviderCallResult::Unavailable);
                CallStatus::Failed
            }
        }
    }
}

macro_rules! mutation_outcome {
    ($outcome:ty) => {
        impl ProviderCallOutcome for $outcome {
            fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus {
                match self {
                    Self::DesiredStored {
                        persisted,
                        commit,
                        native,
                    } => {
                        detail.outcome = Some(ProviderCallResult::Stored);
                        detail.mutation(*persisted, *commit, native)
                    }
                    Self::Rejected => {
                        detail.outcome = Some(ProviderCallResult::Rejected);
                        CallStatus::Rejected
                    }
                    Self::Unavailable => {
                        detail.outcome = Some(ProviderCallResult::Unavailable);
                        CallStatus::Failed
                    }
                }
            }
        }
    };
}
mutation_outcome!(ProviderModelReplaceOutcome);
mutation_outcome!(ProviderRoutingReplaceOutcome);

impl ProviderCallOutcome for ProviderRoutingListOutcome {
    fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus {
        match self {
            Self::Desired(routing) => {
                detail.outcome = Some(ProviderCallResult::Available);
                detail.count = Some(routing.as_ref().map_or(0, |routing| routing.routes.len()));
                CallStatus::Succeeded
            }
            Self::Unavailable => {
                detail.outcome = Some(ProviderCallResult::Unavailable);
                CallStatus::Failed
            }
        }
    }
}

impl ProviderCallOutcome for ProviderSessionModelSelectionOutcome {
    fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus {
        match self {
            Self::Selected(_) => {
                detail.outcome = Some(ProviderCallResult::Selected);
                CallStatus::Succeeded
            }
            Self::Unsupported => {
                detail.outcome = Some(ProviderCallResult::Unsupported);
                CallStatus::Rejected
            }
            Self::Rejected => {
                detail.outcome = Some(ProviderCallResult::Rejected);
                CallStatus::Rejected
            }
            Self::Unavailable => {
                detail.outcome = Some(ProviderCallResult::Unavailable);
                CallStatus::Failed
            }
        }
    }
}

impl ProviderCallOutcome for ProviderSessionRuntimeModelsOutcome {
    fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus {
        match self {
            Self::Accepted(items) => {
                detail.outcome = Some(ProviderCallResult::Accepted);
                detail.count = Some(items.len());
                detail.accepted_count = Some(items.iter().filter(|accepted| **accepted).count());
                CallStatus::Succeeded
            }
            Self::Unsupported => {
                detail.outcome = Some(ProviderCallResult::Unsupported);
                CallStatus::Rejected
            }
            Self::Unavailable => {
                detail.outcome = Some(ProviderCallResult::Unavailable);
                CallStatus::Failed
            }
        }
    }
}

impl ProviderCallOutcome for ProviderTextGenerationModelLimitsOutcome {
    fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus {
        match self {
            Self::Available(_) => {
                detail.outcome = Some(ProviderCallResult::Available);
                CallStatus::Succeeded
            }
            Self::Rejected => {
                detail.outcome = Some(ProviderCallResult::Rejected);
                CallStatus::Rejected
            }
        }
    }
}

impl ProviderCallOutcome for ProviderTextGenerationOutcome {
    fn summarize(&self, detail: &mut ProviderCallDetail) -> CallStatus {
        match self {
            Self::Generated { .. } => {
                detail.outcome = Some(ProviderCallResult::Generated);
                CallStatus::Succeeded
            }
            Self::Rejected => {
                detail.outcome = Some(ProviderCallResult::Rejected);
                CallStatus::Rejected
            }
            Self::Unavailable => {
                detail.outcome = Some(ProviderCallResult::Unavailable);
                CallStatus::Failed
            }
            Self::Cancelled => {
                detail.outcome = Some(ProviderCallResult::Cancelled);
                CallStatus::Failed
            }
        }
    }
}
