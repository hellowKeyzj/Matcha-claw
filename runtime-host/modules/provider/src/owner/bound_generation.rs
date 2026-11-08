use std::{fmt::Write as _, time::Duration};

use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

use crate::{
    ProviderAccount, ProviderAccountAuthMode, ProviderApiProtocol, ProviderModel,
    ProviderModelCatalog, ProviderRouting, ProviderRoutingCapability,
    generation::{
        Binding, BindingRequest, BoundRequest, Failure, FailureKind, Receipt, ReceiptState,
        RetryAfter, Stage,
    },
    llm_client::{
        LlmClientError, LlmEndpoint, LlmFinishReason, LlmMessageContent, LlmMessagePart,
        LlmRequest, LlmResponse, LlmStreamEvent, LlmStreamSink,
        observation::{Observation, RemoteFailure},
    },
    ports::ProviderRuntimeDirectory,
};

use super::models::{
    ProviderModelOwner, provider_execution_endpoint, provider_execution_protocol,
    provider_generation_credential, text_generation_model_limits, text_generation_timeout_ms,
};

const INPUT_TOKEN_COUNT_TIMEOUT: Duration = Duration::from_secs(30);

impl ProviderModelOwner {
    pub(super) fn prepare_generation_binding(
        &self,
        runtime: &dyn ProviderRuntimeDirectory,
        accounts: &[ProviderAccount],
        catalog: &ProviderModelCatalog,
        routing: Option<&ProviderRouting>,
        issued: &crate::adapters::generation_bindings::GenerationBindings,
        request: BindingRequest,
    ) -> Result<Binding, Failure> {
        let invalid = || Failure::new(Stage::Binding, FailureKind::BindingInvalid);
        if !matches!(
            request.capability,
            ProviderRoutingCapability::Chat | ProviderRoutingCapability::ImageUnderstand
        ) || request.options.max_output_tokens == Some(0)
            || request
                .options
                .temperature
                .is_some_and(|value| !value.is_finite() || value < 0.0)
            || request
                .options
                .top_p
                .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
            || request.options.top_k == Some(0)
        {
            return Err(invalid());
        }
        if request.model_ref.is_none() {
            let primary = routing
                .and_then(|routing| routing.route(request.capability))
                .map(|route| route.primary())
                .ok_or_else(|| Failure::new(Stage::Binding, FailureKind::NoSelection))?;
            if !accounts.iter().any(|account| {
                account.id() == primary.account_id() && account.configuration().enabled()
            }) || !catalog.models().iter().any(|model| {
                model.account_id() == primary.account_id()
                    && model.model_id() == primary.model_id()
                    && model.supports(crate::provider_routing_model_capability(request.capability))
            }) {
                return Err(Failure::new(Stage::Binding, FailureKind::NoSelection));
            }
        }
        let candidates = self
            .resolve_text_generation_candidates(
                runtime,
                accounts,
                catalog,
                routing,
                request.capability,
                request.model_ref.as_deref(),
            )
            .map_err(|_| Failure::new(Stage::Binding, FailureKind::SelectionUnavailable))?
            .ok_or_else(|| Failure::new(Stage::Binding, FailureKind::NoSelection))?;
        // Preparation freezes the first configured selection. It never probes/falls back.
        let (account, model, timeout) = candidates
            .into_iter()
            .next()
            .ok_or_else(|| Failure::new(Stage::Binding, FailureKind::NoSelection))?;
        let protocol = provider_execution_protocol(account)
            .filter(|protocol| *protocol != ProviderApiProtocol::GoogleGenerativeAi)
            .ok_or_else(|| Failure::new(Stage::Binding, FailureKind::UnsupportedProtocol))?;
        provider_execution_endpoint(account).map_err(|_| invalid())?;
        if matches!(
            account.configuration().auth_mode(),
            ProviderAccountAuthMode::Local | ProviderAccountAuthMode::CliReuse
        ) {
            return Err(Failure::new(
                Stage::Binding,
                FailureKind::UnsupportedAuthentication,
            ));
        }
        if request.strict_reproducibility {
            return Err(Failure::new(
                Stage::Binding,
                FailureKind::RemoteVersionUnlocked,
            ));
        }
        let limits = text_generation_model_limits(model, timeout);
        let mut options = request.options;
        if let (Some(requested), Some(maximum)) = (options.max_output_tokens, limits.max_tokens) {
            options.max_output_tokens =
                Some(requested.min(u32::try_from(maximum).unwrap_or(u32::MAX)));
        }
        let mut binding = Binding {
            account_id: account.id().clone(),
            model_id: model.model_id().to_owned(),
            selection_id: model.selection_id(),
            account_revision: account.revision().get(),
            configuration_fingerprint: String::new(),
            capability: request.capability,
            protocol,
            limits,
            options,
            descriptor: crate::generation::BindingDescriptor(String::new()),
        };
        binding.configuration_fingerprint = fingerprint(account, model, &binding)?;
        binding.descriptor = issued.issue(&binding)?;
        Ok(binding)
    }

    pub(super) fn restore_generation_binding(
        &self,
        accounts: &[ProviderAccount],
        catalog: &ProviderModelCatalog,
        issued: &crate::adapters::generation_bindings::GenerationBindings,
        descriptor: crate::generation::BindingDescriptor,
    ) -> Result<Binding, Failure> {
        let binding = issued.restore(descriptor)?;
        validate_binding(accounts, catalog, &binding)?;
        Ok(binding)
    }

    pub(super) async fn count_bound_input(
        &self,
        accounts: &[ProviderAccount],
        catalog: &ProviderModelCatalog,
        request: BoundRequest,
        cancellation: CancellationToken,
    ) -> Result<u64, Failure> {
        validate_binding(accounts, catalog, &request.binding)?;
        if request.binding.protocol != ProviderApiProtocol::OpenAiResponses {
            return Err(Failure::new(
                Stage::Admission,
                FailureKind::UnsupportedParameter {
                    parameter: "max_input_tokens".into(),
                },
            ));
        }
        let timeout = request.binding.limits.timeout_ms
            .map(Duration::from_millis)
            .map_or(INPUT_TOKEN_COUNT_TIMEOUT, |timeout| {
                timeout.min(INPUT_TOKEN_COUNT_TIMEOUT)
            });
        let request = self
            .bound_request(accounts, catalog, request, &cancellation)
            .await?;
        let client = self
            .llm_client
            .as_ref()
            .ok_or_else(|| Failure::new(Stage::Connect, FailureKind::ConnectFailed))?;
        let mut observation = Observation::default();
        let result = {
            let count = client.count_input_tokens(request, &mut observation);
            tokio::pin!(count);
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => return Err(Failure::new(Stage::Read, FailureKind::Cancelled)),
                result = tokio::time::timeout(timeout, &mut count) => result
                    .map_err(|_| Failure::new(Stage::Read, FailureKind::GenerationDeadline)),
            }
        }?;
        result.map_err(|error| match error {
            LlmClientError::HttpStatus {
                status: 404 | 405 | 501,
                ..
            } => Failure::new(
                Stage::Admission,
                FailureKind::UnsupportedParameter {
                    parameter: "max_input_tokens".into(),
                },
            ),
            error => classify(&error, &observation),
        })
    }

    async fn bound_request(
        &self,
        accounts: &[ProviderAccount],
        catalog: &ProviderModelCatalog,
        request: BoundRequest,
        cancellation: &CancellationToken,
    ) -> Result<LlmRequest, Failure> {
        let binding = request.binding;
        let account = validate_binding(accounts, catalog, &binding)?;
        if request.messages.is_empty() || (binding.capability != ProviderRoutingCapability::ImageUnderstand
            && request.messages.iter().any(|message| matches!(&message.content,
                LlmMessageContent::Parts(parts) if parts.iter().any(|part| matches!(part, LlmMessagePart::Image(_))))))
        { return Err(Failure::new(Stage::Binding, FailureKind::BindingInvalid)); }
        if cancellation.is_cancelled() {
            return Err(Failure::new(Stage::Credential, FailureKind::Cancelled));
        }
        let credential = tokio::select! {
            biased;
            _ = cancellation.cancelled() => return Err(Failure::new(Stage::Credential, FailureKind::Cancelled)),
            credential = provider_generation_credential(account, &self.private_resolver) => credential,
        }.map_err(|reason| Failure::new(Stage::Credential, match reason {
            crate::ProviderTextGenerationUnavailableReason::CredentialMissing => FailureKind::CredentialMissing,
            _ => FailureKind::CredentialUnavailable,
        }))?.ok_or_else(|| Failure::new(Stage::Credential, FailureKind::UnsupportedAuthentication))?;
        let endpoint = provider_execution_endpoint(account)
            .map_err(|_| Failure::new(Stage::Binding, FailureKind::BindingStale))?;
        Ok(LlmRequest {
            endpoint: LlmEndpoint::new(endpoint, binding.protocol),
            credential,
            model: binding.model_id,
            messages: request.messages,
            options: binding.options,
        })
    }

    pub(super) async fn generate_bound(
        &self,
        accounts: &[ProviderAccount],
        catalog: &ProviderModelCatalog,
        request: BoundRequest,
        cancellation: CancellationToken,
        call_reference: Option<String>,
        sink: Option<&mut dyn LlmStreamSink>,
    ) -> Result<Receipt, Failure> {
        let binding = request.binding.clone();
        // Counting and generation resolve current private credentials against the same exact binding.
        let llm_request = self
            .bound_request(accounts, catalog, request, &cancellation)
            .await?;
        let client = self
            .llm_client
            .as_ref()
            .ok_or_else(|| Failure::new(Stage::Connect, FailureKind::ConnectFailed))?;
        let streaming = sink.is_some();
        let mut stream = BoundStreamSink::new(sink);
        let mut observation = Observation::default();
        let result = {
            let generation = async {
                if streaming {
                    client.stream_generate_observed(llm_request, &mut stream, Some(&mut observation)).await
                        .map(|_| None)
                } else {
                    client.generate_observed(llm_request, Some(&mut observation)).await.map(Some)
                }
            };
            tokio::pin!(generation);
            tokio::select! {
                biased;
                _ = cancellation.cancelled() => Err(Failure::new(Stage::Read, FailureKind::Cancelled)),
                result = tokio::time::timeout(
                    Duration::from_millis(text_generation_timeout_ms(binding.limits.timeout_ms)),
                    &mut generation,
                ) => result.map_err(|_| Failure::new(Stage::Read, FailureKind::GenerationDeadline)),
            }
        }.and_then(|result| result.map_err(|error| classify(&error, &observation)));
        let mut response = match &result {
            Ok(Some(response)) => response.clone(),
            _ => stream.response,
        };
        // Observation sees usage before a later diagnostic, sink failure, or cancellation.
        if observation.usage.is_some() {
            response.usage = observation.usage;
        }
        if observation.finish_reason.is_some() {
            response.finish_reason = observation.finish_reason.clone();
        }
        let mut receipt = Receipt {
            binding_fingerprint: binding.configuration_fingerprint,
            call_reference,
            response,
            actual_model: observation.actual_model.clone(),
            remote_revision: observation.remote_revision.clone(),
            remote_call_reference: observation.remote_call_reference.clone(),
            state: ReceiptState::Partial,
            delivered_text_bytes: stream.delivered_text_bytes,
            delivery_uncertain: stream.delivery_uncertain,
        };
        let failure = match result {
            Err(failure) => Some(failure),
            Ok(_) => {
                if let Some(reason) = observation.failure {
                    Some(remote_failure(reason, observation.status))
                } else if observation.refused
                    || matches!(
                        receipt.response.finish_reason,
                        Some(LlmFinishReason::ContentFilter)
                    )
                {
                    receipt.state = ReceiptState::Refused;
                    Some(Failure::new(Stage::Output, FailureKind::Refused))
                } else {
                    match &receipt.response.finish_reason {
                        Some(LlmFinishReason::Length) => {
                            receipt.state = ReceiptState::Truncated;
                            Some(Failure::new(Stage::Output, FailureKind::Truncated))
                        }
                        Some(LlmFinishReason::Stop) if !receipt.response.text.trim().is_empty() => {
                            None
                        }
                        Some(LlmFinishReason::Other(_)) => Some(Failure::new(
                            Stage::Output,
                            FailureKind::RemoteUnrecognized {
                                status: observation.status,
                            },
                        )),
                        _ => Some(Failure::new(Stage::Output, FailureKind::InvalidOutput)),
                    }
                }
            }
        };
        if let Some(mut failure) = failure {
            if failure.kind == FailureKind::Refused {
                receipt.state = ReceiptState::Refused;
            }
            failure.receipt = Some(receipt);
            Err(failure)
        } else {
            receipt.state = ReceiptState::Completed;
            Ok(receipt)
        }
    }
}

fn validate_binding<'a>(
    accounts: &'a [ProviderAccount],
    catalog: &ProviderModelCatalog,
    binding: &Binding,
) -> Result<&'a ProviderAccount, Failure> {
    let stale = || Failure::new(Stage::Binding, FailureKind::BindingStale);
    let account = accounts
        .iter()
        .find(|account| account.id() == &binding.account_id)
        .ok_or_else(stale)?;
    let model = catalog
        .models()
        .iter()
        .find(|model| {
            model.account_id() == &binding.account_id && model.model_id() == binding.model_id
        })
        .ok_or_else(stale)?;
    if !account.configuration().enabled()
        || !model.supports(crate::provider_routing_model_capability(binding.capability))
        || provider_execution_protocol(account) != Some(binding.protocol)
        || fingerprint(account, model, binding)? != binding.configuration_fingerprint
    {
        return Err(stale());
    }
    Ok(account)
}

fn fingerprint(
    account: &ProviderAccount,
    model: &ProviderModel,
    binding: &Binding,
) -> Result<String, Failure> {
    let endpoint = provider_execution_endpoint(account)
        .map_err(|_| Failure::new(Stage::Binding, FailureKind::BindingStale))?;
    let kind = match account.configuration().kind() {
        crate::ProviderAccountKind::Chat => "chat",
        crate::ProviderAccountKind::Media => "media",
    };
    let auth = match account.configuration().auth_mode() {
        ProviderAccountAuthMode::ApiKey => "api_key",
        ProviderAccountAuthMode::OAuthBrowser => "oauth_browser",
        ProviderAccountAuthMode::OAuthDevice => "oauth_device",
        ProviderAccountAuthMode::Token => "token",
        ProviderAccountAuthMode::CliReuse => "cli_reuse",
        ProviderAccountAuthMode::Local => "local",
    };
    let protocol = match provider_execution_protocol(account) {
        Some(ProviderApiProtocol::AnthropicMessages) => "anthropic_messages",
        Some(ProviderApiProtocol::OpenAiCompletions) => "openai_completions",
        Some(ProviderApiProtocol::OpenAiResponses) => "openai_responses",
        Some(ProviderApiProtocol::GoogleGenerativeAi) => "google_generative_ai",
        None => "none",
    };
    let capability = match binding.capability {
        ProviderRoutingCapability::Chat => "chat",
        ProviderRoutingCapability::ImageUnderstand => "image_understand",
        _ => return Err(Failure::new(Stage::Binding, FailureKind::BindingInvalid)),
    };
    // Only executable semantics: display/media metadata and rotating credentials are excluded.
    // The selected timeout/options remain the immutable snapshot even if routing later changes.
    let semantics = (
        (
            account.id().as_str(),
            account.provider().as_str(),
            endpoint.as_str(),
            kind,
            auth,
            protocol,
        ),
        (
            model.model_id(),
            model.supports(crate::provider_routing_model_capability(binding.capability)),
            model.context_window(),
            model.max_tokens(),
        ),
        (
            capability,
            binding.limits.context_window,
            binding.limits.max_tokens,
            binding.limits.timeout_ms,
        ),
        (
            binding.options.max_output_tokens,
            binding.options.temperature.map(f32::to_bits),
            binding.options.top_p.map(f32::to_bits),
            binding.options.top_k,
            &binding.options.stop,
        ),
    );
    let bytes = serde_json::to_vec(&semantics)
        .map_err(|_| Failure::new(Stage::Binding, FailureKind::BindingInvalid))?;
    let mut hash = Sha256::new();
    hash.update(b"provider-generation-binding/1\n");
    hash.update(bytes);
    let mut fingerprint = String::from("generation-binding:v1:");
    for byte in hash.finalize() {
        let _ = write!(fingerprint, "{byte:02x}");
    }
    Ok(fingerprint)
}

fn classify(error: &LlmClientError, observation: &Observation) -> Failure {
    let status = observation
        .status
        .filter(|status| *status >= 400)
        .or_else(|| match error {
            LlmClientError::HttpStatus { status, .. } => Some(*status),
            LlmClientError::Http(error) => error.status().map(|status| status.as_u16()),
            _ => None,
        });
    match status {
        Some(401) => return Failure::new(Stage::Connect, FailureKind::Authentication),
        Some(403) => return Failure::new(Stage::Connect, FailureKind::PermissionDenied),
        Some(429) => {
            return Failure::new(
                Stage::Connect,
                FailureKind::RateLimited {
                    retry_after: retry_after(observation),
                },
            );
        }
        _ => {}
    }
    if let Some(reason) = observation.failure {
        let mut failure = remote_failure(reason, status);
        if matches!(failure.kind, FailureKind::RateLimited { .. }) {
            failure.kind = FailureKind::RateLimited {
                retry_after: retry_after(observation),
            };
        }
        return failure;
    }
    if let Some(status) = status {
        return Failure::new(
            Stage::Connect,
            if status >= 500 {
                FailureKind::ProviderUnavailable {
                    status: Some(status),
                }
            } else {
                FailureKind::ProviderRejected {
                    status: Some(status),
                }
            },
        );
    }
    match error {
        LlmClientError::UnsupportedProtocol => {
            Failure::new(Stage::Binding, FailureKind::UnsupportedProtocol)
        }
        LlmClientError::Http(error) if error.is_timeout() && error.is_connect() => {
            Failure::new(Stage::Connect, FailureKind::ConnectDeadline)
        }
        LlmClientError::Http(error) if error.is_timeout() => {
            Failure::new(Stage::Read, FailureKind::ReadDeadline)
        }
        LlmClientError::Http(error) if error.is_connect() => {
            Failure::new(Stage::Connect, FailureKind::ConnectFailed)
        }
        LlmClientError::Http(error) if error.is_decode() => {
            Failure::new(Stage::Output, FailureKind::InvalidOutput)
        }
        LlmClientError::Http(_) => Failure::new(Stage::Read, FailureKind::ReadFailed),
        LlmClientError::Deadline => Failure::new(Stage::Read, FailureKind::GenerationDeadline),
        LlmClientError::Protocol(_) => Failure::new(Stage::Output, FailureKind::InvalidOutput),
        LlmClientError::StreamSink(_) => Failure::new(Stage::Output, FailureKind::Sink),
        LlmClientError::HttpStatus { status, .. } => Failure::new(
            Stage::Connect,
            FailureKind::RemoteUnrecognized {
                status: Some(*status),
            },
        ),
    }
}

fn retry_after(observation: &Observation) -> Option<RetryAfter> {
    let value = observation.retry_after.as_deref()?.trim();
    if let Ok(seconds) = value.parse() {
        return Some(RetryAfter::Seconds(seconds));
    }
    // Preserve a syntactically bounded HTTP-date, never an arbitrary upstream value.
    (value.len() == 29
        && value.as_bytes().get(3) == Some(&b',')
        && value.ends_with(" GMT")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b", :".contains(&byte)))
    .then(|| RetryAfter::HttpDate(value.to_owned()))
}

fn remote_failure(reason: RemoteFailure, status: Option<u16>) -> Failure {
    Failure::new(
        Stage::Read,
        match reason {
            RemoteFailure::Authentication => FailureKind::Authentication,
            RemoteFailure::Permission => FailureKind::PermissionDenied,
            RemoteFailure::RateLimit => FailureKind::RateLimited { retry_after: None },
            RemoteFailure::Rejected => FailureKind::ProviderRejected { status },
            RemoteFailure::Unavailable => FailureKind::ProviderUnavailable { status },
            RemoteFailure::Refused => FailureKind::Refused,
            RemoteFailure::Unrecognized => FailureKind::RemoteUnrecognized { status },
        },
    )
}

struct BoundStreamSink<'a> {
    sink: Option<&'a mut dyn LlmStreamSink>,
    response: LlmResponse,
    delivered_text_bytes: u64,
    delivery_uncertain: bool,
}

impl<'a> BoundStreamSink<'a> {
    fn new(sink: Option<&'a mut dyn LlmStreamSink>) -> Self {
        Self {
            sink,
            response: LlmResponse {
                text: String::new(),
                finish_reason: None,
                usage: None,
            },
            delivered_text_bytes: 0,
            delivery_uncertain: false,
        }
    }
}

impl LlmStreamSink for BoundStreamSink<'_> {
    fn send<'a>(
        &'a mut self,
        event: LlmStreamEvent,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), LlmClientError>> + Send + 'a>>
    {
        Box::pin(async move {
            let bytes = match &event {
                LlmStreamEvent::TextDelta(text) => {
                    self.response.text.push_str(text);
                    text.len()
                }
                LlmStreamEvent::FinalText(text) if self.response.text.is_empty() => {
                    self.response.text = text.clone();
                    text.len()
                }
                LlmStreamEvent::FinishReason(reason) => {
                    self.response.finish_reason = Some(reason.clone());
                    0
                }
                LlmStreamEvent::Usage(usage) => {
                    self.response.usage = Some(*usage);
                    0
                }
                LlmStreamEvent::Diagnostic(_) => {
                    return Err(LlmClientError::Protocol(
                        "provider stream reported an error".into(),
                    ));
                }
                _ => 0,
            };
            if let Some(sink) = self.sink.as_mut() {
                self.delivery_uncertain = true;
                sink.send(event).await?;
                self.delivery_uncertain = false;
                self.delivered_text_bytes += bytes as u64;
            }
            Ok(())
        })
    }
}
