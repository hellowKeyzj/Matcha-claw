use provider_module::{
    ProviderHandle, ProviderTextGenerationModelLimits, ProviderTextGenerationModelLimitsOutcome,
    ProviderTextGenerationModelLimitsRequest, ProviderTextGenerationOutcome,
    ProviderTextGenerationRequest,
    llm_client::{LlmGenerationOptions, LlmImageContent, LlmMessage, LlmMessagePart, LlmRole},
};
use tokio_util::sync::CancellationToken;
use wiki::{
    WikiFailure, WikiFuture, WikiIngestImageCaptionRequest, WikiIngestImageCaptionResponse,
    WikiIngestLlm, WikiIngestLlmMessage, WikiIngestLlmModelLimits, WikiIngestLlmRequest,
    WikiIngestLlmResponse, WikiIngestLlmRole,
};

pub(in crate::composition::host) struct ProviderWikiIngestLlm {
    provider: ProviderHandle,
}

impl ProviderWikiIngestLlm {
    pub(in crate::composition::host) fn new(provider: ProviderHandle) -> Self {
        Self { provider }
    }
}

impl WikiIngestLlm for ProviderWikiIngestLlm {
    fn model_limits<'a>(
        &'a self,
        model_ref: Option<&'a str>,
    ) -> WikiFuture<'a, Result<Option<WikiIngestLlmModelLimits>, WikiFailure>> {
        Box::pin(async move {
            let outcome = self
                .provider
                .text_generation_model_limits(ProviderTextGenerationModelLimitsRequest {
                    model_ref: model_ref.map(str::to_owned),
                })
                .await
                .map_err(|_| WikiFailure::OwnerUnavailable)?;
            match outcome {
                ProviderTextGenerationModelLimitsOutcome::Available(limits) => {
                    Ok(Some(map_model_limits(limits)))
                }
                ProviderTextGenerationModelLimitsOutcome::Rejected => Ok(None),
            }
        })
    }

    fn generate<'a>(
        &'a self,
        request: WikiIngestLlmRequest,
    ) -> WikiFuture<'a, Result<WikiIngestLlmResponse, WikiFailure>> {
        self.generate_cancellable(request, CancellationToken::new())
    }

    fn generate_cancellable<'a>(
        &'a self,
        request: WikiIngestLlmRequest,
        cancellation: CancellationToken,
    ) -> WikiFuture<'a, Result<WikiIngestLlmResponse, WikiFailure>> {
        Box::pin(async move {
            let provider = self.provider.generate_text_cancellable(
                map_text_generation_request(request),
                cancellation.clone(),
            );
            let outcome = tokio::select! {
                _ = cancellation.cancelled() => return Err(WikiFailure::cancelled()),
                outcome = provider => outcome.map_err(|_| WikiFailure::OwnerUnavailable)?,
            };
            match_generation_outcome(outcome)
        })
    }

    fn caption_image<'a>(
        &'a self,
        request: WikiIngestImageCaptionRequest,
    ) -> WikiFuture<'a, Result<WikiIngestImageCaptionResponse, WikiFailure>> {
        self.caption_image_cancellable(request, CancellationToken::new())
    }

    fn caption_image_cancellable<'a>(
        &'a self,
        request: WikiIngestImageCaptionRequest,
        cancellation: CancellationToken,
    ) -> WikiFuture<'a, Result<WikiIngestImageCaptionResponse, WikiFailure>> {
        Box::pin(async move {
            let provider = self
                .provider
                .generate_text_cancellable(map_caption_request(request), cancellation.clone());
            let outcome = tokio::select! {
                _ = cancellation.cancelled() => return Err(WikiFailure::cancelled()),
                outcome = provider => outcome.map_err(|_| WikiFailure::OwnerUnavailable)?,
            };
            match match_generation_outcome(outcome) {
                Ok(response) => Ok(WikiIngestImageCaptionResponse {
                    caption: non_empty_caption(response.text),
                }),
                Err(error) => Err(error),
            }
        })
    }
}

fn map_text_generation_request(request: WikiIngestLlmRequest) -> ProviderTextGenerationRequest {
    ProviderTextGenerationRequest {
        model_ref: request.model_ref,
        messages: request.messages.into_iter().map(map_message).collect(),
        options: map_options(request.options),
    }
}

fn map_caption_request(request: WikiIngestImageCaptionRequest) -> ProviderTextGenerationRequest {
    ProviderTextGenerationRequest {
        model_ref: request.model_ref,
        messages: vec![LlmMessage::parts(
            LlmRole::User,
            vec![
                LlmMessagePart::Text(request.prompt),
                LlmMessagePart::Image(LlmImageContent::new(request.mime_type, request.data_base64)),
            ],
        )],
        options: map_options(request.options),
    }
}

fn map_options(options: wiki::WikiIngestLlmOptions) -> LlmGenerationOptions {
    LlmGenerationOptions {
        max_output_tokens: options.max_output_tokens,
        temperature: options.temperature,
        top_p: None,
        top_k: None,
        stop: Vec::new(),
    }
}

fn match_generation_outcome(
    outcome: ProviderTextGenerationOutcome,
) -> Result<WikiIngestLlmResponse, WikiFailure> {
    match outcome {
        ProviderTextGenerationOutcome::Generated {
            response,
            model_limits,
        } => Ok(WikiIngestLlmResponse {
            text: response.text,
            model_limits: Some(map_model_limits(model_limits)),
        }),
        ProviderTextGenerationOutcome::Rejected => Err(WikiFailure::invalid_input(
            "provider",
            "no usable provider is configured for wiki ingest",
        )),
        ProviderTextGenerationOutcome::Unavailable => Err(WikiFailure::state(
            "provider text generation is unavailable",
        )),
        ProviderTextGenerationOutcome::Cancelled => Err(WikiFailure::cancelled()),
    }
}

fn non_empty_caption(text: String) -> Option<String> {
    let caption = text.trim();
    (!caption.is_empty()).then(|| caption.to_owned())
}

fn map_model_limits(limits: ProviderTextGenerationModelLimits) -> WikiIngestLlmModelLimits {
    WikiIngestLlmModelLimits {
        context_window: limits.context_window,
        max_tokens: limits.max_tokens,
        timeout_ms: limits.timeout_ms,
    }
}

fn map_message(message: WikiIngestLlmMessage) -> LlmMessage {
    LlmMessage::text(
        match message.role {
            WikiIngestLlmRole::System => LlmRole::System,
            WikiIngestLlmRole::User => LlmRole::User,
            WikiIngestLlmRole::Assistant => LlmRole::Assistant,
        },
        message.content,
    )
}
