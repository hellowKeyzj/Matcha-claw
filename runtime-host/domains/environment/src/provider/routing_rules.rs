use std::collections::BTreeSet;

use crate::{
    ProviderAccount, ProviderAccountId, ProviderModel, ProviderModelCapability,
    ProviderModelCatalog, ProviderModelReference, ProviderRoute, ProviderRouting,
    ProviderRoutingCapability, ProviderRoutingRevision,
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

fn prune_provider_route_to_admissible(
    capability: ProviderRoutingCapability,
    route: &ProviderRoute,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
) -> Option<ProviderRoute> {
    let mut fallbacks = route
        .fallbacks()
        .iter()
        .filter(|reference| {
            provider_reference_is_admissible(capability, reference, accounts, catalog)
        })
        .cloned()
        .collect::<Vec<_>>();
    if provider_reference_is_admissible(capability, route.primary(), accounts, catalog) {
        return ProviderRoute::try_new(route.primary().clone(), fallbacks, route.timeout_ms()).ok();
    }
    let primary = fallbacks.first().cloned()?;
    fallbacks.remove(0);
    ProviderRoute::try_new(primary, fallbacks, route.timeout_ms()).ok()
}

pub fn prune_provider_routing_to_admissible(
    routing: &ProviderRouting,
    accounts: &[ProviderAccount],
    catalog: &ProviderModelCatalog,
) -> Result<Option<ProviderRouting>, ()> {
    let routes = routing
        .routes()
        .iter()
        .filter_map(|(capability, route)| {
            prune_provider_route_to_admissible(*capability, route, accounts, catalog)
                .map(|route| (*capability, route))
        })
        .collect::<Vec<_>>();
    if routes.len() == routing.routes().len()
        && routes
            .iter()
            .zip(routing.routes())
            .all(|(left, right)| left == right)
    {
        return Ok(None);
    }
    let revision = routing.revision().get().checked_add(1).ok_or(())?;
    ProviderRouting::try_new(
        ProviderRoutingRevision::try_new(revision).map_err(|_| ())?,
        routes,
    )
    .map(Some)
    .map_err(|_| ())
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
