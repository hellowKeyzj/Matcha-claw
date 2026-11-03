use serde::{Deserialize, Serialize};

use crate::{ProviderAccount, ProviderModel, ProviderModelCatalog, ProviderRouting};

use super::{Failure, Kind, pixel_size};

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
    pub sizes: Option<Vec<String>>,
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
    let models = catalog
        .models()
        .iter()
        .filter(|model| model.supports(request.kind.model_capability()))
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
    let default_selection_id = super::select(accounts, catalog, routing, request.kind, None)
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
    if !model.supports(kind.model_capability()) {
        return Err(Failure::Unsupported);
    }
    let protocol = super::protocol(account)?;
    super::endpoint(account, protocol)?;
    protocol.capabilities(model, kind)
}
