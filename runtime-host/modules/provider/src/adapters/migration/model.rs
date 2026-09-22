use std::{collections::HashSet, path::Path, path::PathBuf};

use serde::Deserialize;

use crate::{ProviderAccountId, ProviderModel, ProviderModelCapability, ProviderModelCatalog};

use super::{ProviderMigrationFault, legacy_source, write_atomic};

const LEGACY_VERSION: u8 = 1;

pub(super) fn migrate<Sources, Source>(
    path: &Path,
    sources: Sources,
) -> Result<(), ProviderMigrationFault>
where
    Sources: IntoIterator<Item = Source>,
    Source: Into<PathBuf>,
{
    let Some(legacy) = legacy_source::<_, _, LegacyModels>(sources, path)? else {
        return Ok(());
    };
    if legacy.schema_version != LEGACY_VERSION {
        return Err(ProviderMigrationFault::Decode);
    }
    let mut models = Vec::new();
    let mut seen = HashSet::new();
    for legacy in legacy.models {
        let Some(model) = legacy.into_model() else {
            continue;
        };
        let key = (
            model.account_id().as_str().to_owned(),
            model.model_id().to_owned(),
        );
        if seen.insert(key) {
            models.push(model);
        }
    }
    let catalog =
        ProviderModelCatalog::try_new(models).map_err(|_| ProviderMigrationFault::Decode)?;
    let bytes = crate::adapters::model_store::migration_bytes(&catalog)
        .map_err(|_| ProviderMigrationFault::Encode)?;
    write_atomic(path, &bytes)
}

#[derive(Deserialize)]
struct LegacyModels {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    models: Vec<LegacyModel>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyModel {
    credential_id: Option<String>,
    model_id: Option<String>,
    capabilities: Option<Vec<String>>,
    context_window: Option<f64>,
    max_tokens: Option<f64>,
    timeout_ms: Option<f64>,
    aspect_ratio: Option<String>,
    resolution: Option<String>,
    quality: Option<String>,
}

impl LegacyModel {
    fn into_model(self) -> Option<ProviderModel> {
        let account_id = ProviderAccountId::try_new(self.credential_id?.trim()).ok()?;
        let capabilities = self
            .capabilities
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| capability(&value))
            .collect::<Vec<_>>();
        (!capabilities.is_empty()).then(|| {
            ProviderModel::try_new(
                account_id,
                self.model_id?,
                capabilities,
                positive_integer(self.context_window),
                positive_integer(self.max_tokens),
                positive_integer(self.timeout_ms),
                trimmed(self.aspect_ratio),
                trimmed(self.resolution),
                trimmed(self.quality),
            )
            .ok()
        })?
    }
}

fn trimmed(value: Option<String>) -> Option<String> {
    value.map(|value| value.trim().to_owned())
}

fn positive_integer(value: Option<f64>) -> Option<u64> {
    let value = value?;
    (value.is_finite() && value > 0.0 && value.floor() <= u64::MAX as f64)
        .then_some(value.floor() as u64)
}

fn capability(value: &str) -> Option<ProviderModelCapability> {
    Some(match value {
        "chat" => ProviderModelCapability::Chat,
        "imageUnderstand" => ProviderModelCapability::ImageUnderstand,
        "imageGenerate" => ProviderModelCapability::ImageGenerate,
        "videoGenerate" => ProviderModelCapability::VideoGenerate,
        "musicGenerate" => ProviderModelCapability::MusicGenerate,
        "tts" => ProviderModelCapability::TextToSpeech,
        "transcribe" => ProviderModelCapability::Transcribe,
        _ => return None,
    })
}
