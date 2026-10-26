use std::sync::Arc;

use provider_module::{
    ProviderApiProtocol, ProviderHandle, ProviderRoutingCapability,
    generation::{Binding, BindingDescriptor, BindingRequest, BoundRequest},
    llm_client::{LlmGenerationOptions, LlmMessage, LlmRole},
};
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;
use world::generation::{
    BoundGeneration, GenerationError, GenerationFuture, GenerationInput, GenerationSelection,
    WorldGeneration,
};
use world_protocol::{
    generation::{
        GenerationFailure, GenerationFailureKind as Kind, GenerationParameters,
        GenerationStage as Stage, ModelBinding, ModelBindingRef, RemoteVersionLock,
    },
    ids::{Digest, ModelBindingId, ModelCallId, Revision},
    value::Decimal,
};

mod receipt;

pub(crate) struct HostWorldGeneration(pub(crate) ProviderHandle);

struct Bound {
    provider: ProviderHandle,
    binding: Binding,
    model: ModelBinding,
    descriptor: String,
}

impl WorldGeneration for HostWorldGeneration {
    fn prepare<'a>(
        &'a self,
        selection: GenerationSelection,
        cancellation: CancellationToken,
    ) -> GenerationFuture<'a, Arc<dyn BoundGeneration>> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(rejected(Stage::Admission, Kind::Cancelled));
            }
            let options = options(&selection.parameters)?;
            let binding = self
                .0
                .prepare_generation_binding(BindingRequest {
                    model_ref: selection.model_ref,
                    capability: ProviderRoutingCapability::Chat,
                    options,
                    strict_reproducibility: selection.strict_reproducibility,
                })
                .await
                .map_err(receipt::binding_failure)?;
            if cancellation.is_cancelled() {
                return Err(rejected(Stage::Admission, Kind::Cancelled));
            }
            Ok(Arc::new(bound(self.0.clone(), binding)?) as Arc<dyn BoundGeneration>)
        })
    }

    fn restore<'a>(
        &'a self,
        expected: ModelBinding,
        descriptor: String,
        cancellation: CancellationToken,
    ) -> GenerationFuture<'a, Arc<dyn BoundGeneration>> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(rejected(Stage::Admission, Kind::Cancelled));
            }
            let issued: BindingDescriptor = serde_json::from_str(&descriptor)
                .map_err(|cause| caused(Stage::Binding, Kind::BindingInvalid, cause))?;
            let binding = self
                .0
                .restore_generation_binding(issued)
                .await
                .map_err(receipt::binding_failure)?;
            let bound = bound(self.0.clone(), binding)?;
            if bound.model != expected || bound.descriptor != descriptor {
                return Err(rejected(Stage::Binding, Kind::BindingStale));
            }
            if cancellation.is_cancelled() {
                return Err(rejected(Stage::Admission, Kind::Cancelled));
            }
            Ok(Arc::new(bound) as Arc<dyn BoundGeneration>)
        })
    }
}

impl BoundGeneration for Bound {
    fn binding(&self) -> &ModelBinding {
        &self.model
    }
    fn descriptor(&self) -> &str {
        &self.descriptor
    }

    fn count_input<'a>(
        &'a self,
        input: &'a GenerationInput,
        cancellation: CancellationToken,
    ) -> GenerationFuture<'a, u64> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(rejected(Stage::Admission, Kind::Cancelled));
            }
            let request = self.request(input)?;
            let input_tokens = self
                .provider
                .count_bound_input(request, cancellation)
                .await
                .map_err(receipt::binding_failure)?;
            if input_tokens > input.request.budget.max_input_tokens {
                return Err(rejected(
                    Stage::Admission,
                    Kind::BudgetExceeded {
                        dimension: world_protocol::budget::BudgetDimension::InputTokens,
                    },
                ));
            }
            if self.binding.limits().context_window.is_some_and(|limit| {
                input_tokens
                    .checked_add(self.model.parameters.maximum_output_tokens)
                    .is_none_or(|total| total > limit)
            }) {
                return Err(rejected(Stage::Binding, Kind::ContextLimit));
            }
            Ok(input_tokens)
        })
    }

    fn generate<'a>(
        &'a self,
        input: GenerationInput,
        call_id: ModelCallId,
        cancellation: CancellationToken,
    ) -> GenerationFuture<'a, world_protocol::generation::GenerationReceipt> {
        Box::pin(async move {
            if cancellation.is_cancelled() {
                return Err(rejected(Stage::Admission, Kind::Cancelled));
            }
            let request = self.request(&input)?;
            let started = chrono_timestamp()?;
            // Provider returns the final/partial receipt even after cancellation; retain owner custody.
            let result = self
                .provider
                .generate_bound(request, cancellation, None)
                .await;
            let completed = chrono_timestamp()?;
            match result {
                Ok(receipt) => Ok(receipt::convert(
                    receipt,
                    &input.request,
                    call_id,
                    started,
                    completed,
                )),
                Err(cause) => Err(receipt::generation_failure(
                    cause,
                    &input.request,
                    call_id,
                    started,
                    completed,
                )),
            }
        })
    }
}

impl Bound {
    fn request(&self, input: &GenerationInput) -> Result<BoundRequest, GenerationError> {
        if input.request.binding != self.model.reference
            || input.context.len() != input.request.context.len()
            || !matches_blob(&input.prompt, &input.request.prompt)
            || !input
                .context
                .iter()
                .zip(&input.request.context)
                .all(|(text, blob)| matches_blob(text, blob))
        {
            return Err(rejected(Stage::Binding, Kind::BindingInvalid));
        }
        let maximum = self.model.parameters.maximum_output_tokens;
        if maximum > input.request.budget.max_output_tokens {
            return Err(rejected(
                Stage::Admission,
                Kind::BudgetExceeded {
                    dimension: world_protocol::budget::BudgetDimension::OutputTokens,
                },
            ));
        }
        if self
            .binding
            .limits()
            .max_tokens
            .is_some_and(|limit| maximum > limit)
        {
            return Err(rejected(Stage::Binding, Kind::OutputLimit));
        }
        let mut messages = Vec::with_capacity(input.context.len() + 1);
        messages.extend(
            input
                .context
                .iter()
                .map(|text| LlmMessage::text(LlmRole::System, text.clone())),
        );
        messages.push(LlmMessage::text(LlmRole::User, input.prompt.clone()));
        Ok(BoundRequest {
            binding: self.binding.clone(),
            messages,
        })
    }
}

fn bound(provider: ProviderHandle, binding: Binding) -> Result<Bound, GenerationError> {
    let descriptor = serde_json::to_string(binding.descriptor())
        .map_err(|cause| caused(Stage::Binding, Kind::BindingInvalid, cause))?;
    let parameters = parameters(binding.options())?;
    let fingerprint = binding
        .configuration_fingerprint()
        .strip_prefix("generation-binding:v1:")
        .and_then(|hex| Digest::try_new(format!("sha256:{hex}")).ok())
        .ok_or_else(|| rejected(Stage::Binding, Kind::BindingInvalid))?;
    let reference_digest = digest(descriptor.as_bytes());
    let model = ModelBinding {
        reference: ModelBindingRef {
            id: ModelBindingId::try_new(format!("provider:{}", &reference_digest.as_str()[7..]))
                .map_err(|cause| caused(Stage::Binding, Kind::BindingInvalid, cause))?,
            revision: Revision(binding.account_revision()),
            digest: reference_digest,
        },
        account_id: binding.account_id().as_str().to_owned(),
        model_id: binding.model_id().to_owned(),
        selection_id: binding.selection_id().to_owned(),
        account_revision: Revision(binding.account_revision()),
        provider_fingerprint: fingerprint,
        protocol: match binding.protocol() {
            ProviderApiProtocol::AnthropicMessages => "anthropic_messages",
            ProviderApiProtocol::OpenAiCompletions => "openai_completions",
            ProviderApiProtocol::OpenAiResponses => "openai_responses",
            ProviderApiProtocol::GoogleGenerativeAi => "google_generative_ai",
        }
        .into(),
        capability: match binding.capability() {
            ProviderRoutingCapability::Chat => "chat",
            ProviderRoutingCapability::ImageUnderstand => "image_understand",
            _ => return Err(rejected(Stage::Binding, Kind::BindingInvalid)),
        }
        .into(),
        parameters,
        capabilities: None,
        remote_version_lock: match binding.remote_version_lock() {
            provider_module::generation::RemoteVersionLock::Unlocked => RemoteVersionLock::Unlocked,
        },
    };
    Ok(Bound {
        provider,
        binding,
        model,
        descriptor,
    })
}

fn options(parameters: &GenerationParameters) -> Result<LlmGenerationOptions, GenerationError> {
    if parameters.seed.is_some() {
        return Err(unsupported("seed"));
    }
    let maximum = u32::try_from(parameters.maximum_output_tokens)
        .ok()
        .filter(|value| *value != 0)
        .ok_or_else(|| unsupported("maximumOutputTokens"))?;
    Ok(LlmGenerationOptions {
        max_output_tokens: Some(maximum),
        temperature: decimal_option(parameters.temperature.as_ref(), "temperature")?,
        top_p: decimal_option(parameters.top_p.as_ref(), "topP")?,
        top_k: None,
        stop: Vec::new(),
    })
}

fn decimal_option(value: Option<&Decimal>, name: &str) -> Result<Option<f32>, GenerationError> {
    value
        .map(|value| {
            let number = value
                .as_str()
                .parse::<f32>()
                .map_err(|_| unsupported(name))?;
            if !number.is_finite()
                || number < 0.0
                || (name == "topP" && number > 1.0)
                || Decimal::try_new(number.to_string()).ok().as_ref() != Some(value)
            {
                return Err(unsupported(name));
            }
            Ok(number)
        })
        .transpose()
}

fn parameters(options: &LlmGenerationOptions) -> Result<GenerationParameters, GenerationError> {
    let decimal = |value: f32| {
        Decimal::try_new(value.to_string())
            .map_err(|cause| caused(Stage::Binding, Kind::BindingInvalid, cause))
    };
    Ok(GenerationParameters {
        temperature: options.temperature.map(decimal).transpose()?,
        top_p: options.top_p.map(decimal).transpose()?,
        seed: None,
        maximum_output_tokens: options
            .max_output_tokens
            .ok_or_else(|| rejected(Stage::Binding, Kind::BindingInvalid))?
            .into(),
    })
}

fn matches_blob(text: &str, blob: &world_protocol::materials::BlobRef) -> bool {
    text.len() as u64 == blob.byte_size && digest(text.as_bytes()) == blob.digest
}
fn digest(bytes: &[u8]) -> Digest {
    Digest::try_new(format!("sha256:{:x}", Sha256::digest(bytes))).expect("SHA256 digest")
}
fn chrono_timestamp() -> Result<world_protocol::time::Timestamp, GenerationError> {
    world_protocol::time::Timestamp::try_new(chrono::Utc::now().to_rfc3339())
        .map_err(|cause| caused(Stage::Output, Kind::InternalFault, cause))
}
fn unsupported(name: &str) -> GenerationError {
    rejected(
        Stage::Binding,
        Kind::UnsupportedParameter {
            parameter: name.into(),
        },
    )
}
fn rejected(stage: Stage, kind: Kind) -> GenerationError {
    GenerationError::new(GenerationFailure {
        stage,
        kind,
        receipt: None,
    })
}
fn caused(
    stage: Stage,
    kind: Kind,
    cause: impl std::error::Error + Send + Sync + 'static,
) -> GenerationError {
    GenerationError::caused_by(
        GenerationFailure {
            stage,
            kind,
            receipt: None,
        },
        cause,
    )
}
