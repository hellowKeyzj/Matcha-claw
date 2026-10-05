use std::{path::PathBuf, sync::Arc};

use ort::{session::Session, value::TensorRef};
use tokenizers::{PaddingDirection, Tokenizer, TruncationParams};

pub(crate) const MODEL: &str = "Xenova/all-MiniLM-L6-v2";
pub(crate) const DIMENSION: usize = 384;

#[derive(Default)]
pub(super) struct LocalMiniLm {
    assets_root: Option<PathBuf>,
    session: Arc<tokio::sync::Mutex<Option<MiniLmSession>>>,
}

impl LocalMiniLm {
    pub(super) fn with_assets(mut self, assets_root: PathBuf) -> Self {
        self.assets_root = Some(assets_root);
        self
    }

    pub(super) async fn embed(&self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        // The owned lock stays with inference when its async caller is cancelled.
        let mut session = self.session.clone().lock_owned().await;
        let assets_root = self.assets_root.clone();
        tokio::task::spawn_blocking(move || {
            if session.is_none() {
                *session = Some(MiniLmSession::load(assets_root)?);
            }
            session
                .as_mut()
                .expect("loaded MiniLM session")
                .embed(texts)
        })
        .await
        .map_err(|_| "local MiniLM inference task failed".to_owned())?
    }
}

struct MiniLmSession {
    tokenizer: Tokenizer,
    session: Session,
}

impl MiniLmSession {
    fn load(assets_root: Option<PathBuf>) -> Result<Self, String> {
        let root = match assets_root {
            Some(root) => root,
            None => bundled_assets_root()?,
        };
        let model_root = root.join("models").join(MODEL);
        let tokenizer_path = model_root.join("tokenizer.json");
        let model_path = model_root.join("onnx/model.onnx");
        if !tokenizer_path.is_file() || !model_path.is_file() {
            return Err(
                "local MiniLM model assets are missing; reinstall the bundled Wiki resources"
                    .to_owned(),
            );
        }
        let library = root.join("onnxruntime").join(runtime_library()?);
        if !library.is_file() {
            return Err(
                "local MiniLM ONNX Runtime library is missing; reinstall the bundled Wiki resources"
                    .to_owned(),
            );
        }
        ort::init_from(library)
            .map_err(|_| "local MiniLM ONNX Runtime library could not be loaded; reinstall the bundled Wiki resources".to_owned())?
            .commit();
        let mut tokenizer = Tokenizer::from_file(tokenizer_path).map_err(|_| {
            "local MiniLM tokenizer could not be loaded; reinstall the bundled Wiki resources"
                .to_owned()
        })?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: 512,
                ..Default::default()
            }))
            .map_err(|_| "local MiniLM tokenizer truncation could not be configured".to_owned())?;
        tokenizer.with_padding(None);
        let session = (|| -> ort::Result<Session> {
            Session::builder()?
                .with_intra_threads(2)?
                .with_inter_threads(1)?
                .with_parallel_execution(false)?
                .commit_from_file(model_path)
        })()
        .map_err(|_| {
            "local MiniLM model could not be loaded; reinstall the bundled Wiki resources"
                .to_owned()
        })?;
        Ok(Self { tokenizer, session })
    }

    fn embed(&mut self, texts: Vec<String>) -> Result<Vec<Vec<f32>>, String> {
        // Keep tokenization sequential; encode_batch would create an unrestricted Rayon pool.
        let mut encodings = texts
            .into_iter()
            .map(|text| self.tokenizer.encode(text, true))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "local MiniLM input could not be tokenized".to_owned())?;
        let count = encodings.len();
        let length = encodings
            .iter()
            .map(|encoding| encoding.len())
            .max()
            .expect("nonempty embedding batch");
        for encoding in &mut encodings {
            encoding.pad(length, 0, 0, "[PAD]", PaddingDirection::Right);
        }
        let ids = encodings
            .iter()
            .flat_map(|encoding| encoding.get_ids().iter().map(|id| i64::from(*id)))
            .collect::<Vec<_>>();
        let mask = encodings
            .iter()
            .flat_map(|encoding| {
                encoding
                    .get_attention_mask()
                    .iter()
                    .map(|mask| i64::from(*mask))
            })
            .collect::<Vec<_>>();
        let types = encodings
            .iter()
            .flat_map(|encoding| encoding.get_type_ids().iter().map(|id| i64::from(*id)))
            .collect::<Vec<_>>();
        let tensor = |values| {
            TensorRef::from_array_view(([count, length], values))
                .map_err(|_| "local MiniLM input tensor could not be created".to_owned())
        };
        let outputs = self
            .session
            .run(ort::inputs! {
                "input_ids" => tensor(ids.as_slice())?,
                "attention_mask" => tensor(mask.as_slice())?,
                "token_type_ids" => tensor(types.as_slice())?,
            })
            .map_err(|_| "local MiniLM inference failed".to_owned())?;
        let (shape, hidden) = outputs
            .get("last_hidden_state")
            .ok_or_else(|| "local MiniLM output is missing token embeddings".to_owned())?
            .try_extract_tensor::<f32>()
            .map_err(|_| "local MiniLM output has an invalid tensor type".to_owned())?;
        if shape.as_ref() != [count as i64, length as i64, DIMENSION as i64] {
            return Err("local MiniLM output has invalid dimensions".to_owned());
        }
        let mut vectors = Vec::with_capacity(count);
        for (tokens, mask) in hidden
            .chunks_exact(length * DIMENSION)
            .zip(mask.chunks_exact(length))
        {
            let mut vector = vec![0.0f32; DIMENSION];
            let mut token_count = 0.0f32;
            for (token, mask) in tokens.chunks_exact(DIMENSION).zip(mask) {
                if *mask == 0 {
                    continue;
                }
                token_count += 1.0;
                for (value, hidden) in vector.iter_mut().zip(token) {
                    *value += hidden;
                }
            }
            for value in &mut vector {
                *value /= token_count;
            }
            let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
            if !norm.is_finite() || norm <= 0.0 {
                return Err("local MiniLM output cannot be normalized".to_owned());
            }
            for value in &mut vector {
                *value /= norm;
            }
            vectors.push(vector);
        }
        Ok(vectors)
    }
}

fn bundled_assets_root() -> Result<PathBuf, String> {
    if let Ok(executable) = std::env::current_exe() {
        for ancestor in executable.ancestors().skip(1) {
            let root = ancestor.join("resources/wiki");
            if root.is_dir() {
                return Ok(root);
            }
        }
    }
    if let Ok(directory) = std::env::current_dir() {
        let root = directory.join("resources/wiki");
        if root.is_dir() {
            return Ok(root);
        }
    }
    Err("local MiniLM model assets are missing; reinstall the bundled Wiki resources".to_owned())
}

fn runtime_library() -> Result<&'static str, String> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => Ok("win32/x64/onnxruntime.dll"),
        ("windows", "aarch64") => Ok("win32/arm64/onnxruntime.dll"),
        ("linux", "x86_64") => Ok("linux/x64/libonnxruntime.so.1"),
        ("linux", "aarch64") => Ok("linux/arm64/libonnxruntime.so.1"),
        ("macos", "aarch64") => Ok("darwin/arm64/libonnxruntime.1.24.3.dylib"),
        _ => Err("local MiniLM ONNX Runtime is not bundled for this platform".to_owned()),
    }
}
