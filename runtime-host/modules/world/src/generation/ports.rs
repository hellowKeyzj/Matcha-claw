use std::{future::Future, pin::Pin, sync::Arc};

use tokio_util::sync::CancellationToken;
use world_protocol::{
    generation::{GenerationParameters, GenerationReceipt, ModelBinding},
    ids::ModelCallId,
};

use super::GenerationError;

pub type GenerationFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, GenerationError>> + Send + 'a>>;

pub struct GenerationSelection {
    pub model_ref: Option<String>,
    pub parameters: GenerationParameters,
    pub strict_reproducibility: bool,
}

#[derive(Clone)]
pub struct GenerationInput {
    pub request: world_protocol::generation::GenerationRequest,
    pub prompt: String,
    pub context: Vec<String>,
    pub sources: Vec<world_protocol::materials::SourceVersionRef>,
}

/// One exact Provider binding; its issued descriptor belongs to the durable run basis.
pub trait BoundGeneration: Send + Sync {
    fn binding(&self) -> &ModelBinding;
    fn descriptor(&self) -> &str;
    fn count_input<'a>(
        &'a self,
        input: &'a GenerationInput,
        cancellation: CancellationToken,
    ) -> GenerationFuture<'a, u64>;
    fn generate<'a>(
        &'a self,
        input: GenerationInput,
        call_id: ModelCallId,
        cancellation: CancellationToken,
    ) -> GenerationFuture<'a, GenerationReceipt>;
}

/// Host owns Provider credentials and binding custody, never the world's model-call ledger.
pub trait WorldGeneration: Send + Sync {
    fn prepare<'a>(
        &'a self,
        selection: GenerationSelection,
        cancellation: CancellationToken,
    ) -> GenerationFuture<'a, Arc<dyn BoundGeneration>>;

    fn restore<'a>(
        &'a self,
        expected: ModelBinding,
        descriptor: String,
        cancellation: CancellationToken,
    ) -> GenerationFuture<'a, Arc<dyn BoundGeneration>>;
}
