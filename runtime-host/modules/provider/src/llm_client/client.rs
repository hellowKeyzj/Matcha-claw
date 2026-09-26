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

    pub async fn generate(&self, request: LlmRequest) -> Result<LlmResponse, LlmClientError> {
        match request.endpoint.protocol() {
            ProviderApiProtocol::OpenAiCompletions => {
                openai_chat::generate(&self.http, request).await
            }
            ProviderApiProtocol::OpenAiResponses => {
                openai_responses::generate(&self.http, request).await
            }
            ProviderApiProtocol::AnthropicMessages => {
                anthropic::generate(&self.http, request).await
            }
            ProviderApiProtocol::GoogleGenerativeAi => Err(LlmClientError::UnsupportedProtocol),
        }
    }

    pub async fn stream_generate(
        &self,
        request: LlmRequest,
        sink: &mut dyn LlmStreamSink,
    ) -> Result<(), LlmClientError> {
        match request.endpoint.protocol() {
            ProviderApiProtocol::OpenAiCompletions => {
                openai_chat::stream_generate(&self.http, request, sink).await
            }
            ProviderApiProtocol::OpenAiResponses => {
                openai_responses::stream_generate(&self.http, request, sink).await
            }
            ProviderApiProtocol::AnthropicMessages => {
                anthropic::stream_generate(&self.http, request, sink).await
            }
            ProviderApiProtocol::GoogleGenerativeAi => Err(LlmClientError::UnsupportedProtocol),
        }
    }
}
