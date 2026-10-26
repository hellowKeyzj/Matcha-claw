use crate::{
    ProviderApiProtocol,
    llm_client::{LlmClientError, LlmRequest, LlmResponse, LlmStreamSink},
};

use super::{anthropic, openai_chat, openai_responses};

#[derive(Clone, Debug)]
pub struct LlmClient {
    http: reqwest::Client,
}

impl LlmClient {
    pub fn new(http: reqwest::Client) -> Self {
        Self { http }
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    pub(crate) async fn count_input_tokens(
        &self,
        request: LlmRequest,
        observation: &mut super::observation::Observation,
    ) -> Result<u64, LlmClientError> {
        match request.endpoint.protocol() {
            ProviderApiProtocol::OpenAiResponses => {
                openai_responses::count_input_tokens(&self.http, request, observation).await
            }
            _ => Err(LlmClientError::UnsupportedProtocol),
        }
    }

    pub async fn generate(&self, request: LlmRequest) -> Result<LlmResponse, LlmClientError> {
        self.generate_observed(request, None).await
    }

    pub(crate) async fn generate_observed(
        &self,
        request: LlmRequest,
        observation: Option<&mut super::observation::Observation>,
    ) -> Result<LlmResponse, LlmClientError> {
        match request.endpoint.protocol() {
            ProviderApiProtocol::OpenAiCompletions => {
                openai_chat::generate(&self.http, request, observation).await
            }
            ProviderApiProtocol::OpenAiResponses => {
                openai_responses::generate(&self.http, request, observation).await
            }
            ProviderApiProtocol::AnthropicMessages => {
                anthropic::generate(&self.http, request, observation).await
            }
            ProviderApiProtocol::GoogleGenerativeAi => Err(LlmClientError::UnsupportedProtocol),
        }
    }

    pub async fn stream_generate(
        &self,
        request: LlmRequest,
        sink: &mut dyn LlmStreamSink,
    ) -> Result<(), LlmClientError> {
        self.stream_generate_observed(request, sink, None).await
    }

    pub(crate) async fn stream_generate_observed(
        &self,
        request: LlmRequest,
        sink: &mut dyn LlmStreamSink,
        observation: Option<&mut super::observation::Observation>,
    ) -> Result<(), LlmClientError> {
        match request.endpoint.protocol() {
            ProviderApiProtocol::OpenAiCompletions => {
                openai_chat::stream_generate(&self.http, request, sink, observation).await
            }
            ProviderApiProtocol::OpenAiResponses => {
                openai_responses::stream_generate(&self.http, request, sink, observation).await
            }
            ProviderApiProtocol::AnthropicMessages => {
                anthropic::stream_generate(&self.http, request, sink, observation).await
            }
            ProviderApiProtocol::GoogleGenerativeAi => Err(LlmClientError::UnsupportedProtocol),
        }
    }
}
