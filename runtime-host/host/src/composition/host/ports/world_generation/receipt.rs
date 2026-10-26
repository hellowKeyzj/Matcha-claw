use provider_module::{generation as provider, llm_client::LlmFinishReason};
use world::generation::GenerationError;
use world_protocol::{
    generation::{
        GenerationFailure, GenerationFailureKind, GenerationReceipt, GenerationRequest,
        GenerationStage, GenerationState, ModelUsage, RetryAfter,
    },
    ids::ModelCallId,
    time::Timestamp,
};

pub(super) fn convert(
    receipt: provider::Receipt,
    request: &GenerationRequest,
    call_id: ModelCallId,
    started: Timestamp,
    completed: Timestamp,
) -> GenerationReceipt {
    GenerationReceipt {
        id: call_id,
        binding: request.binding.clone(),
        prompt_digest: request.prompt.digest.clone(),
        context_digests: request
            .context
            .iter()
            .map(|blob| blob.digest.clone())
            .collect(),
        output: None,
        value: None,
        text: receipt.response.text,
        finish_reason: receipt.response.finish_reason.map(|reason| match reason {
            LlmFinishReason::Stop => "stop".into(),
            LlmFinishReason::Length => "length".into(),
            LlmFinishReason::ContentFilter => "content_filter".into(),
            LlmFinishReason::ToolUse => "tool_use".into(),
            LlmFinishReason::Other(reason) => reason,
        }),
        usage: receipt.response.usage.map(|usage| ModelUsage {
            input_tokens: usage.input_tokens.map(u64::from),
            output_tokens: usage.output_tokens.map(u64::from),
            total_tokens: usage.total_tokens.map(u64::from),
        }),
        started_at: started,
        completed_at: Some(completed),
        actual_model: receipt.actual_model,
        remote_revision: receipt.remote_revision,
        remote_call_reference: receipt.remote_call_reference,
        provider_call_reference: receipt.call_reference,
        state: match receipt.state {
            provider::ReceiptState::Completed => GenerationState::Completed,
            provider::ReceiptState::Refused => GenerationState::Refused,
            provider::ReceiptState::Truncated => GenerationState::Truncated,
            provider::ReceiptState::Partial => GenerationState::Partial,
        },
        delivered_text_bytes: receipt.delivered_text_bytes,
        delivery_uncertain: receipt.delivery_uncertain,
    }
}

pub(super) fn binding_failure(cause: provider::Failure) -> GenerationError {
    failure(cause, None)
}

pub(super) fn generation_failure(
    cause: provider::Failure,
    request: &GenerationRequest,
    call_id: ModelCallId,
    started: Timestamp,
    completed: Timestamp,
) -> GenerationError {
    let receipt = cause
        .receipt
        .clone()
        .map(|receipt| Box::new(convert(receipt, request, call_id, started, completed)));
    failure(cause, receipt)
}

fn failure(cause: provider::Failure, receipt: Option<Box<GenerationReceipt>>) -> GenerationError {
    use GenerationFailureKind as Target;
    use provider::FailureKind as Source;
    let stage = match cause.stage {
        provider::Stage::Admission => GenerationStage::Admission,
        provider::Stage::Binding => GenerationStage::Binding,
        provider::Stage::Credential => GenerationStage::Credential,
        provider::Stage::Connect => GenerationStage::Connect,
        provider::Stage::Read => GenerationStage::Read,
        provider::Stage::Output => GenerationStage::Output,
    };
    let kind = match &cause.kind {
        Source::OwnerUnavailable => Target::OwnerUnavailable,
        Source::AuditUnavailable => Target::AuditUnavailable,
        Source::BindingInvalid => Target::BindingInvalid,
        Source::BindingStale => Target::BindingStale,
        Source::BindingStoreUnavailable { .. } => Target::BindingStoreUnavailable,
        Source::NoSelection => Target::NoSelection,
        Source::SelectionUnavailable => Target::SelectionUnavailable,
        Source::RemoteVersionUnlocked => Target::RemoteVersionUnlocked,
        Source::UnsupportedProtocol => Target::UnsupportedProtocol,
        Source::UnsupportedParameter { parameter } => Target::UnsupportedParameter {
            parameter: parameter.clone(),
        },
        Source::UnsupportedAuthentication => Target::UnsupportedAuthentication,
        Source::CredentialMissing => Target::CredentialMissing,
        Source::CredentialUnavailable => Target::CredentialUnavailable,
        Source::Authentication => Target::Authentication,
        Source::PermissionDenied => Target::PermissionDenied,
        Source::RateLimited { retry_after } => Target::RateLimited {
            retry_after: retry_after.as_ref().map(|retry| match retry {
                provider::RetryAfter::Seconds(value) => RetryAfter::Seconds { value: *value },
                provider::RetryAfter::HttpDate(value) => RetryAfter::HttpDate {
                    value: value.clone(),
                },
            }),
        },
        Source::ConnectDeadline => Target::ConnectDeadline,
        Source::ReadDeadline => Target::ReadDeadline,
        Source::GenerationDeadline => Target::GenerationDeadline,
        Source::ConnectFailed => Target::ConnectFailed,
        Source::ReadFailed => Target::ReadFailed,
        Source::ProviderRejected { status } => Target::ProviderRejected { status: *status },
        Source::ProviderUnavailable { status } => Target::ProviderUnavailable { status: *status },
        Source::Refused => Target::Refused,
        Source::Truncated => Target::Truncated,
        Source::InvalidOutput => Target::InvalidOutput,
        Source::RemoteUnrecognized { status } => Target::RemoteUnrecognized { status: *status },
        Source::Cancelled => Target::Cancelled,
        Source::Sink => Target::Sink,
    };
    GenerationError::caused_by(
        GenerationFailure {
            stage,
            kind,
            receipt,
        },
        ProviderCause(cause),
    )
}

struct ProviderCause(provider::Failure);

impl std::fmt::Debug for ProviderCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderCause")
            .field("stage", &self.0.stage)
            .finish_non_exhaustive()
    }
}
impl std::fmt::Display for ProviderCause {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Provider generation failed")
    }
}
impl std::error::Error for ProviderCause {}
