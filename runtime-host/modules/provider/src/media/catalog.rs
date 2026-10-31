use serde::{Deserialize, Serialize};

use crate::{
    ProviderAccount, ProviderModel, ProviderModelCapability, ProviderModelCatalog, ProviderRouting,
    ProviderRoutingCapability,
};

use super::{Failure, Kind, Protocol, pixel_size};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListRequest {
    pub kind: Kind,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListOutput {
    pub models: Vec<Model>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_selection_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub selection_id: String,
    pub name: String,
    pub capabilities: Capabilities,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub max_images: u8,
    pub max_count: u8,
    pub mask: bool,
    pub pixel_size: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pixel_size_limits: Option<pixel_size::Limits>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sizes: Option<Vec<&'static str>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub durations_seconds: Option<Vec<u32>>,
    pub storyboard: bool,
}

pub(crate) fn list(
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
    routing: Option<&ProviderRouting>,
    request: ListRequest,
) -> Result<ListOutput, Failure> {
    let required = match request.kind {
        Kind::Image => ProviderModelCapability::ImageGenerate,
        Kind::Video => ProviderModelCapability::VideoGenerate,
    };
    let models = catalog
        .models()
        .iter()
        .filter(|model| model.supports(required))
        .filter_map(|model| {
            let account = accounts.iter().find(|account| {
                account.id() == model.account_id() && account.configuration().enabled()
            })?;
            let capabilities = capabilities(account, model, request.kind).ok()?;
            Some(Model {
                selection_id: model.selection_id(),
                name: format!("{} / {}", account.configuration().label(), model.model_id()),
                capabilities,
            })
        })
        .collect::<Vec<_>>();
    let capability = match request.kind {
        Kind::Image => ProviderRoutingCapability::ImageGenerate,
        Kind::Video => ProviderRoutingCapability::VideoGenerate,
    };
    let default_selection_id = super::select(accounts, catalog, routing, capability, None)
        .ok()
        .map(|(_, model, _)| model.selection_id())
        .filter(|id| models.iter().any(|model| &model.selection_id == id));
    Ok(ListOutput {
        models,
        default_selection_id,
    })
}

pub(super) fn capabilities(
    account: &ProviderAccount,
    model: &ProviderModel,
    kind: Kind,
) -> Result<Capabilities, Failure> {
    let protocol = super::protocol(account)?;
    super::endpoint(account, protocol)?;
    let mut limits = Capabilities {
        max_images: 0,
        max_count: 1,
        mask: false,
        pixel_size: false,
        pixel_size_limits: None,
        sizes: None,
        durations_seconds: None,
        storyboard: false,
    };
    // Catalog labels alone are not protocol evidence. Unknown/custom model names
    // remain usable through the unchanged explicit generate contract, not advertised here.
    match (protocol, kind) {
        (Protocol::OpenAi, Kind::Video) => {
            if !matches!(
                model.model_id(),
                "sora-2"
                    | "sora-2-pro"
                    | "sora-2-2025-10-06"
                    | "sora-2-pro-2025-10-06"
                    | "sora-2-2025-12-08"
            ) || model.quality().is_some()
                || model.aspect_ratio().is_some()
            {
                return Err(Failure::Unsupported);
            }
            limits.max_images = 1;
            limits.sizes = Some(if model.model_id().starts_with("sora-2-pro") {
                vec!["720x1280", "1280x720", "1024x1792", "1792x1024"]
            } else {
                vec!["720x1280", "1280x720"]
            });
            limits.durations_seconds = Some(vec![4, 8, 12]);
        }
        (Protocol::OpenAi, Kind::Image) => {
            if model.aspect_ratio().is_some() {
                return Err(Failure::Unsupported);
            }
            match model.model_id() {
                "dall-e-2" => {
                    limits.max_images = 1;
                    limits.max_count = 10;
                    limits.mask = true;
                    limits.sizes = Some(vec!["256x256", "512x512", "1024x1024"]);
                    if model.quality().is_some_and(|quality| quality != "standard") {
                        return Err(Failure::Unsupported);
                    }
                }
                "dall-e-3" => {
                    limits.sizes = Some(vec!["1024x1024", "1792x1024", "1024x1792"]);
                    if model
                        .quality()
                        .is_some_and(|quality| !matches!(quality, "standard" | "hd"))
                    {
                        return Err(Failure::Unsupported);
                    }
                }
                "gpt-image-1"
                | "gpt-image-1-mini"
                | "gpt-image-1.5"
                | "chatgpt-image-latest"
                | "gpt-image-2"
                | "gpt-image-2-2026-04-21"
                | "gpt-image-2.5-sunburst"
                | "gpt-image-2.5-sunburst-2026-09-08"
                | "gpt-image-2.5-flare"
                | "gpt-image-2.5-flare-2026-09-08" => {
                    limits.max_images = 16;
                    limits.max_count = 10;
                    limits.mask = true;
                    limits.pixel_size_limits = pixel_size::for_model(model.model_id());
                    limits.pixel_size = limits.pixel_size_limits.is_some();
                    limits.sizes = Some(vec!["auto", "1024x1024", "1536x1024", "1024x1536"]);
                    if model.quality().is_some_and(|quality| {
                        !matches!(quality, "auto" | "low" | "medium" | "high")
                            && !(model.model_id().starts_with("gpt-image-2.5-")
                                && matches!(quality, "xhigh" | "max"))
                    }) {
                        return Err(Failure::Unsupported);
                    }
                }
                _ => return Err(Failure::Unsupported),
            }
        }
        (Protocol::Google, Kind::Image) => {
            if model.quality().is_some() {
                return Err(Failure::Unsupported);
            }
            let name = model.model_id().trim_start_matches("models/");
            let sizes = match name {
                "gemini-2.5-flash-image" | "gemini-2.5-flash-image-preview" => None,
                "gemini-3-pro-image-preview" | "gemini-3-pro-image" => Some(vec!["1K", "2K", "4K"]),
                "gemini-3.1-flash-image" | "gemini-3.1-flash-image-preview" => {
                    Some(vec!["512", "1K", "2K", "4K"])
                }
                _ => return Err(Failure::Unsupported),
            };
            // Advertise a conservative single-reference contract, not an unverified
            // model-native maximum inferred from the adapter's 16-image body limit.
            limits.max_images = 1;
            limits.sizes = sizes;
        }
        (Protocol::Google, Kind::Video) => return Err(Failure::Unsupported),
    }
    if model.resolution().is_some_and(|size| {
        !limits
            .sizes
            .as_ref()
            .is_some_and(|sizes| sizes.contains(&size))
            && !limits
                .pixel_size_limits
                .as_ref()
                .is_some_and(|limits| limits.supports(size))
    }) {
        return Err(Failure::Unsupported);
    }
    Ok(limits)
}
