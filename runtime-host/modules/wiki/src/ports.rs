use std::{future::Future, path::PathBuf, pin::Pin};

use tokio_util::sync::CancellationToken;

use crate::domain::WikiFailure;

pub type WikiFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Clone, Debug, PartialEq)]
pub struct WikiIngestLlmRequest {
    pub model_ref: Option<String>,
    pub messages: Vec<WikiIngestLlmMessage>,
    pub options: WikiIngestLlmOptions,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WikiIngestImageCaptionRequest {
    pub model_ref: Option<String>,
    pub prompt: String,
    pub mime_type: String,
    pub data_base64: String,
    pub options: WikiIngestLlmOptions,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WikiIngestImageCaptionResponse {
    pub caption: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WikiIngestLlmMessage {
    pub role: WikiIngestLlmRole,
    pub content: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WikiIngestLlmRole {
    System,
    User,
    Assistant,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WikiIngestLlmOptions {
    pub max_output_tokens: Option<u32>,
    pub temperature: Option<f32>,
}

impl Default for WikiIngestLlmOptions {
    fn default() -> Self {
        Self {
            max_output_tokens: None,
            temperature: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct WikiIngestLlmModelLimits {
    /// Provider context window in tokens, not a character budget.
    pub context_window: Option<u64>,
    /// Provider maximum output length in tokens.
    pub max_tokens: Option<u64>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WikiIngestLlmResponse {
    pub text: String,
    pub model_limits: Option<WikiIngestLlmModelLimits>,
}

pub trait WikiIngestLlmDeltaSink: Send {
    fn send<'a>(&'a mut self, delta: String) -> WikiFuture<'a, Result<(), WikiFailure>>;
}

pub trait WikiIngestLlm: Send + Sync {
    fn model_limits<'a>(
        &'a self,
        model_ref: Option<&'a str>,
    ) -> WikiFuture<'a, Result<Option<WikiIngestLlmModelLimits>, WikiFailure>> {
        let _ = model_ref;
        Box::pin(async { Ok(None) })
    }

    fn generate<'a>(
        &'a self,
        request: WikiIngestLlmRequest,
    ) -> WikiFuture<'a, Result<WikiIngestLlmResponse, WikiFailure>>;

    fn generate_cancellable<'a>(
        &'a self,
        request: WikiIngestLlmRequest,
        cancellation: CancellationToken,
    ) -> WikiFuture<'a, Result<WikiIngestLlmResponse, WikiFailure>> {
        Box::pin(async move {
            tokio::select! {
                _ = cancellation.cancelled() => Err(WikiFailure::cancelled()),
                response = self.generate(request) => response,
            }
        })
    }

    fn stream_generate_cancellable<'a>(
        &'a self,
        request: WikiIngestLlmRequest,
        cancellation: CancellationToken,
        sink: &'a mut dyn WikiIngestLlmDeltaSink,
    ) -> WikiFuture<'a, Result<WikiIngestLlmResponse, WikiFailure>> {
        Box::pin(async move {
            let _ = (request, sink);
            if cancellation.is_cancelled() {
                return Err(WikiFailure::cancelled());
            }
            Err(WikiFailure::state("provider text streaming is unavailable"))
        })
    }

    fn caption_image<'a>(
        &'a self,
        request: WikiIngestImageCaptionRequest,
    ) -> WikiFuture<'a, Result<WikiIngestImageCaptionResponse, WikiFailure>> {
        Box::pin(async move {
            let _ = request;
            Ok(WikiIngestImageCaptionResponse { caption: None })
        })
    }

    fn caption_image_cancellable<'a>(
        &'a self,
        request: WikiIngestImageCaptionRequest,
        cancellation: CancellationToken,
    ) -> WikiFuture<'a, Result<WikiIngestImageCaptionResponse, WikiFailure>> {
        Box::pin(async move {
            tokio::select! {
                _ = cancellation.cancelled() => Err(WikiFailure::cancelled()),
                response = self.caption_image(request) => response,
            }
        })
    }
}

pub trait WikiRequestAdmission: Send + Sync {
    fn admit_wiki_request(&self) -> Result<(), WikiRequestAdmissionClosed>;
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct WikiRequestAdmissionClosed;

pub trait WikiStateDirectory: Send + Sync {
    fn wiki_state_root(&self) -> Result<PathBuf, WikiFailure>;
}
