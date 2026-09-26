use std::path::PathBuf;
use std::sync::Mutex;

use ort::session::Session;
use ort::value::Tensor;
use tokenizers::tokenizer::{PaddingParams, PaddingStrategy, Tokenizer, TruncationParams};

const MODEL_FILE: &str = "onnx/model.onnx";
const TOKENIZER_FILE: &str = "tokenizer.json";
const EMBEDDING_DIMENSION: usize = 384;

pub struct Embedder {
    tokenizer: Tokenizer,
    session: Mutex<Session>,
}

impl Embedder {
    pub fn load(model_dir: PathBuf) -> Result<Embedder, String> {
        let tokenizer_path = model_dir.join(TOKENIZER_FILE);
        let model_path = model_dir.join(MODEL_FILE);

        let mut tokenizer = Tokenizer::from_file(&tokenizer_path).map_err(|error| {
            format!(
                "failed to load tokenizer {}: {error}",
                tokenizer_path.display()
            )
        })?;
        ensure_truncation(&mut tokenizer)?;
        ensure_padding(&mut tokenizer)?;

        let session = Session::builder()
            .map_err(|error| format!("failed to create ONNX session builder: {error}"))?
            .commit_from_file(&model_path)
            .map_err(|error| {
                format!(
                    "failed to load ONNX model {}: {error}",
                    model_path.display()
                )
            })?;

        Ok(Self {
            tokenizer,
            session: Mutex::new(session),
        })
    }

    pub fn embed(&self, text: &str) -> Result<Vec<f32>, String> {
        let mut embeddings = self.embed_batch(&[text.to_owned()])?;
        embeddings
            .pop()
            .ok_or_else(|| "embedding batch returned no vectors".to_owned())
    }

    pub fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|error| format!("failed to tokenize embedding batch: {error}"))?;
        let batch_size = encodings.len();
        let sequence_length = encodings
            .first()
            .map(|encoding| encoding.get_ids().len())
            .ok_or_else(|| "tokenizer returned no encodings".to_owned())?;

        let mut input_ids = Vec::with_capacity(batch_size * sequence_length);
        let mut attention_mask = Vec::with_capacity(batch_size * sequence_length);
        let mut token_type_ids = Vec::with_capacity(batch_size * sequence_length);

        for encoding in &encodings {
            if encoding.get_ids().len() != sequence_length {
                return Err("tokenizer returned an unpadded batch".to_owned());
            }
            input_ids.extend(encoding.get_ids().iter().map(|id| i64::from(*id)));
            attention_mask.extend(
                encoding
                    .get_attention_mask()
                    .iter()
                    .map(|mask| i64::from(*mask)),
            );
            token_type_ids.extend(
                encoding
                    .get_type_ids()
                    .iter()
                    .map(|type_id| i64::from(*type_id)),
            );
        }

        let shape = [batch_size, sequence_length];
        let input_ids = Tensor::from_array((shape, input_ids.into_boxed_slice()))
            .map_err(|error| format!("failed to create input_ids tensor: {error}"))?;
        let attention_mask_tensor =
            Tensor::from_array((shape, attention_mask.clone().into_boxed_slice()))
                .map_err(|error| format!("failed to create attention_mask tensor: {error}"))?;
        let token_type_ids = Tensor::from_array((shape, token_type_ids.into_boxed_slice()))
            .map_err(|error| format!("failed to create token_type_ids tensor: {error}"))?;

        let mut session = self
            .session
            .lock()
            .map_err(|_| "embedding ONNX session lock was poisoned".to_owned())?;
        let outputs = session
            .run(ort::inputs! {
                "input_ids" => input_ids,
                "attention_mask" => attention_mask_tensor,
                "token_type_ids" => token_type_ids,
            })
            .map_err(|error| format!("failed to run MiniLM embedding model: {error}"))?;
        let (output_shape, output_values) = outputs[0]
            .try_extract_tensor::<f32>()
            .map_err(|error| format!("failed to read MiniLM output tensor: {error}"))?;
        let output_dims: &[i64] = output_shape;
        if output_dims.len() != 3 {
            return Err(format!(
                "MiniLM output must be [batch, tokens, hidden], got {output_shape}"
            ));
        }
        let output_batch = usize::try_from(output_dims[0])
            .map_err(|_| format!("invalid MiniLM output batch size: {}", output_dims[0]))?;
        let output_tokens = usize::try_from(output_dims[1])
            .map_err(|_| format!("invalid MiniLM output token count: {}", output_dims[1]))?;
        let output_hidden = usize::try_from(output_dims[2])
            .map_err(|_| format!("invalid MiniLM output hidden size: {}", output_dims[2]))?;
        if output_batch != batch_size
            || output_tokens != sequence_length
            || output_hidden != EMBEDDING_DIMENSION
        {
            return Err(format!(
                "MiniLM output shape mismatch: expected [{batch_size}, {sequence_length}, {EMBEDDING_DIMENSION}], got {output_shape}"
            ));
        }

        Ok(mean_pool_and_normalize(
            output_values,
            &attention_mask,
            batch_size,
            sequence_length,
        ))
    }
}

fn ensure_truncation(tokenizer: &mut Tokenizer) -> Result<(), String> {
    let params = tokenizer
        .get_truncation()
        .cloned()
        .unwrap_or_else(TruncationParams::default);
    tokenizer
        .with_truncation(Some(params))
        .map_err(|error| format!("failed to configure tokenizer truncation: {error}"))?;
    Ok(())
}

fn ensure_padding(tokenizer: &mut Tokenizer) -> Result<(), String> {
    let params = tokenizer
        .get_padding()
        .cloned()
        .unwrap_or_else(default_padding_params);
    tokenizer.with_padding(Some(params));
    Ok(())
}

fn default_padding_params() -> PaddingParams {
    PaddingParams {
        strategy: PaddingStrategy::Fixed(128),
        ..PaddingParams::default()
    }
}

fn mean_pool_and_normalize(
    token_embeddings: &[f32],
    attention_mask: &[i64],
    batch_size: usize,
    sequence_length: usize,
) -> Vec<Vec<f32>> {
    (0..batch_size)
        .map(|batch_index| {
            let mut embedding = vec![0.0; EMBEDDING_DIMENSION];
            let mut token_count = 0.0_f32;

            for token_index in 0..sequence_length {
                if attention_mask[batch_index * sequence_length + token_index] == 0 {
                    continue;
                }
                token_count += 1.0;
                let token_offset =
                    (batch_index * sequence_length + token_index) * EMBEDDING_DIMENSION;
                for dimension_index in 0..EMBEDDING_DIMENSION {
                    embedding[dimension_index] += token_embeddings[token_offset + dimension_index];
                }
            }

            if token_count > 0.0 {
                for value in &mut embedding {
                    *value /= token_count;
                }
            }

            let norm = embedding
                .iter()
                .map(|value| value * value)
                .sum::<f32>()
                .sqrt();
            if norm > 0.0 {
                for value in &mut embedding {
                    *value /= norm;
                }
            }

            embedding
        })
        .collect()
}
