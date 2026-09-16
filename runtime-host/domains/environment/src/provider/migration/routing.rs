use std::{collections::BTreeMap, path::Path, path::PathBuf};

use serde::Deserialize;

use crate::{
    ProviderAccountId, ProviderModelReference, ProviderRoute, ProviderRouting,
    ProviderRoutingCapability, ProviderRoutingRevision,
};

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
    let Some(legacy) = legacy_source::<_, _, LegacyRouting>(sources, path)? else {
        return Ok(());
    };
    if legacy.schema_version != LEGACY_VERSION {
        return Err(ProviderMigrationFault::Decode);
    }
    let mut routes = Vec::new();
    for (name, route) in legacy.routing {
        let Some(capability) = capability(&name) else {
            continue;
        };
        let Some(route) = route.into_route()? else {
            continue;
        };
        routes.push((capability, route));
    }
    let routing = ProviderRouting::try_new(
        ProviderRoutingRevision::try_new(1).expect("one is valid"),
        routes,
    )
    .map_err(|_| ProviderMigrationFault::Decode)?;
    let bytes =
        crate::routing::migration_bytes(&routing).map_err(|_| ProviderMigrationFault::Encode)?;
    write_atomic(path, &bytes)
}

#[derive(Deserialize)]
struct LegacyRouting {
    #[serde(rename = "schemaVersion")]
    schema_version: u8,
    routing: BTreeMap<String, LegacyRoute>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum LegacyRoute {
    Valid(LegacyRouteData),
    Ignored(serde::de::IgnoredAny),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRouteData {
    primary: Option<LegacyReference>,
    #[serde(default)]
    fallbacks: Vec<LegacyReference>,
    timeout_ms: Option<f64>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum LegacyReference {
    Valid(LegacyReferenceData),
    Ignored(serde::de::IgnoredAny),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyReferenceData {
    credential_id: Option<String>,
    model_id: Option<String>,
}

impl LegacyRoute {
    fn into_route(self) -> Result<Option<ProviderRoute>, ProviderMigrationFault> {
        let Self::Valid(route) = self else {
            return Ok(None);
        };
        let Some(primary) = reference(route.primary) else {
            return Ok(None);
        };
        let mut fallbacks = Vec::new();
        for reference in route
            .fallbacks
            .into_iter()
            .filter_map(|legacy| reference(Some(legacy)))
        {
            if reference != primary && !fallbacks.contains(&reference) {
                fallbacks.push(reference);
            }
        }
        ProviderRoute::try_new(primary, fallbacks, positive_integer(route.timeout_ms))
            .map(Some)
            .map_err(|_| ProviderMigrationFault::Decode)
    }
}

fn reference(reference: Option<LegacyReference>) -> Option<ProviderModelReference> {
    match reference? {
        LegacyReference::Valid(reference) => ProviderModelReference::try_new(
            ProviderAccountId::try_new(reference.credential_id?.trim()).ok()?,
            reference.model_id?.trim(),
        )
        .ok(),
        LegacyReference::Ignored(_) => None,
    }
}

fn positive_integer(value: Option<f64>) -> Option<u64> {
    let value = value?;
    (value.is_finite() && value > 0.0 && value.floor() <= u64::MAX as f64)
        .then_some(value.floor() as u64)
}

fn capability(value: &str) -> Option<ProviderRoutingCapability> {
    Some(match value {
        "chat" => ProviderRoutingCapability::Chat,
        "imageUnderstand" => ProviderRoutingCapability::ImageUnderstand,
        "imageGenerate" => ProviderRoutingCapability::ImageGenerate,
        "videoGenerate" => ProviderRoutingCapability::VideoGenerate,
        "musicGenerate" => ProviderRoutingCapability::MusicGenerate,
        "tts" => ProviderRoutingCapability::Tts,
        _ => return None,
    })
}
