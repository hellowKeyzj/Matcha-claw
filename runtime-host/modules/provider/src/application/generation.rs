use crate::llm_client::{LlmGenerationOptions, LlmMessage, LlmResponse};

#[derive(Clone, Debug, PartialEq)]
pub struct ProviderTextGenerationRequest {
    pub model_ref: Option<String>,
    pub messages: Vec<LlmMessage>,
    pub options: LlmGenerationOptions,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProviderTextGenerationModelLimitsRequest {
    pub model_ref: Option<String>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct ProviderTextGenerationModelLimits {
    pub context_window: Option<u64>,
    pub max_tokens: Option<u64>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug)]
pub enum ProviderTextGenerationModelLimitsOutcome {
    Available(ProviderTextGenerationModelLimits),
    Rejected,
}

#[derive(Debug)]
pub enum ProviderTextGenerationOutcome {
    Generated {
        response: LlmResponse,
        model_limits: ProviderTextGenerationModelLimits,
    },
    Rejected,
    Unavailable,
    Cancelled,
}
