use std::collections::BTreeSet;

use crate::{
    ProviderAccount, ProviderAccountId, ProviderModel, ProviderModelCapability,
    ProviderModelCatalog, ProviderModelReference, ProviderRoute, ProviderRouting,
    ProviderRoutingCapability,
};

pub fn provider_routing_account_ids(routing: &ProviderRouting) -> BTreeSet<ProviderAccountId> {
    routing
        .routes()
        .iter()
        .flat_map(|(_, route)| std::iter::once(route.primary()).chain(route.fallbacks()))
        .map(|reference| reference.account_id().clone())
        .collect()
}

pub fn provider_routing_is_admissible(
    routing: &ProviderRouting,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
) -> bool {
    routing.routes().iter().all(|(capability, route)| {
        provider_route_is_admissible(*capability, route, accounts, catalog)
    })
}

fn provider_route_is_admissible(
    capability: ProviderRoutingCapability,
    route: &ProviderRoute,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
) -> bool {
    provider_reference_is_admissible(capability, route.primary(), accounts, catalog)
        && route.fallbacks().iter().all(|reference| {
            provider_reference_is_admissible(capability, reference, accounts, catalog)
        })
}

fn provider_reference_is_admissible(
    capability: ProviderRoutingCapability,
    reference: &ProviderModelReference,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
) -> bool {
    accounts
        .iter()
        .find(|account| account.id() == reference.account_id())
        .is_some_and(|account| account.configuration().enabled())
        && catalog
            .models()
            .iter()
            .any(|model| provider_model_matches_routing_reference(model, capability, reference))
}

pub fn provider_model_matches_routing_reference(
    model: &ProviderModel,
    capability: ProviderRoutingCapability,
    reference: &ProviderModelReference,
) -> bool {
    model.account_id() == reference.account_id()
        && model.model_id() == reference.model_id()
        && model.supports(provider_routing_model_capability(capability))
}

pub const fn provider_routing_model_capability(
    capability: ProviderRoutingCapability,
) -> ProviderModelCapability {
    match capability {
        ProviderRoutingCapability::Chat => ProviderModelCapability::Chat,
        ProviderRoutingCapability::ImageUnderstand => ProviderModelCapability::ImageUnderstand,
        ProviderRoutingCapability::ImageGenerate => ProviderModelCapability::ImageGenerate,
        ProviderRoutingCapability::VideoGenerate => ProviderModelCapability::VideoGenerate,
        ProviderRoutingCapability::MusicGenerate => ProviderModelCapability::MusicGenerate,
        ProviderRoutingCapability::Tts => ProviderModelCapability::TextToSpeech,
    }
}
