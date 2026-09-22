use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
};

use super::*;
use crate::{
    CredentialReference, ProviderAccountAuthMode, ProviderAccountConfiguration,
    ProviderAccountConfigurationInput, ProviderAccountKind, ProviderApiProtocol, ProviderEndpoint,
    ProviderModel, ProviderModelCapability, ProviderModelReference, ProviderReference,
    ProviderRoute, ProviderRoutingCapability, ProviderRoutingRevision,
    provider_routing_is_admissible,
};

static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

struct Paths {
    accounts: PathBuf,
    models: PathBuf,
    routing: PathBuf,
    journal: PathBuf,
}

impl Paths {
    fn new(name: &str) -> Self {
        let id = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
        let root = std::env::temp_dir().join(format!(
            "matcha-provider-cascade-{name}-{}-{id}",
            std::process::id()
        ));
        Self {
            accounts: root.join("accounts.json"),
            models: root.join("models.json"),
            routing: root.join("routing.json"),
            journal: root.join("cascade.json"),
        }
    }

    fn remove(&self) {
        for path in [&self.accounts, &self.models, &self.routing, &self.journal] {
            let _ = fs::remove_file(path);
            let _ = fs::remove_file(sibling_path(path, ".lock"));
            let _ = fs::remove_file(sibling_path(path, ".next"));
        }
        if let Some(root) = self.accounts.parent() {
            let _ = fs::remove_dir(root);
        }
    }
}

fn credential(value: &str) -> CredentialReference {
    CredentialReference::try_new(format!("credential:v1:{value}")).unwrap()
}

fn account(id: &str, credential: CredentialReference) -> ProviderAccount {
    account_with_enabled(id, credential, true)
}

fn disabled_account(id: &str, credential: CredentialReference) -> ProviderAccount {
    account_with_enabled(id, credential, false)
}

fn account_with_enabled(
    id: &str,
    credential: CredentialReference,
    enabled: bool,
) -> ProviderAccount {
    account_with_updated_at(id, credential, enabled, "2026-07-30T10:00:00Z")
}

fn account_with_updated_at(
    id: &str,
    credential: CredentialReference,
    enabled: bool,
    updated_at: &str,
) -> ProviderAccount {
    account_with_revision(
        id,
        credential,
        ProviderAccountRevision::try_new(1).unwrap(),
        enabled,
        updated_at,
    )
}

fn account_with_revision(
    id: &str,
    credential: CredentialReference,
    revision: ProviderAccountRevision,
    enabled: bool,
    updated_at: &str,
) -> ProviderAccount {
    ProviderAccount::new(
        ProviderAccountId::try_new(id).unwrap(),
        ProviderReference::try_new("provider:openai").unwrap(),
        revision,
        ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
            label: "Primary".to_owned(),
            enabled,
            kind: ProviderAccountKind::Chat,
            endpoint: Some(ProviderEndpoint::try_new("https://api.example.com/v1").unwrap()),
            protocol: Some(ProviderApiProtocol::OpenAiResponses),
            media_protocol: None,
            auth_mode: ProviderAccountAuthMode::ApiKey,
            credential: Some(credential),
            created_at: "2026-07-30T10:00:00Z".to_owned(),
            updated_at: updated_at.to_owned(),
        })
        .unwrap(),
    )
}

fn local_account(id: &str) -> ProviderAccount {
    ProviderAccount::new(
        ProviderAccountId::try_new(id).unwrap(),
        ProviderReference::try_new("provider:ollama").unwrap(),
        ProviderAccountRevision::try_new(1).unwrap(),
        ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
            label: "Local".to_owned(),
            enabled: true,
            kind: ProviderAccountKind::Chat,
            endpoint: Some(ProviderEndpoint::try_new("http://127.0.0.1:11434/v1").unwrap()),
            protocol: Some(ProviderApiProtocol::OpenAiResponses),
            media_protocol: None,
            auth_mode: ProviderAccountAuthMode::Local,
            credential: None,
            created_at: "2026-07-30T10:00:00Z".to_owned(),
            updated_at: "2026-07-30T10:00:00Z".to_owned(),
        })
        .unwrap(),
    )
}

fn model(account_id: ProviderAccountId, model_id: &str) -> ProviderModel {
    model_with_capabilities(account_id, model_id, vec![ProviderModelCapability::Chat])
}

fn model_with_capabilities(
    account_id: ProviderAccountId,
    model_id: &str,
    capabilities: Vec<ProviderModelCapability>,
) -> ProviderModel {
    ProviderModel::try_new(
        account_id,
        model_id,
        capabilities,
        None,
        None,
        None,
        None,
        None,
        None,
    )
    .unwrap()
}

fn reference(account_id: ProviderAccountId, model_id: &str) -> ProviderModelReference {
    ProviderModelReference::try_new(account_id, model_id).unwrap()
}

fn open_cascade(paths: &Paths) -> ProviderCascade {
    ProviderCascade::open(
        &paths.accounts,
        &paths.models,
        &paths.routing,
        &paths.journal,
    )
    .unwrap()
}

#[test]
fn account_deletion_cascades_models_and_routes_through_one_recoverable_journal() {
    let paths = Paths::new("delete");
    let removed = credential("removed");
    let retained = credential("retained");
    let removed_id = ProviderAccountId::try_new("removed").unwrap();
    let retained_id = ProviderAccountId::try_new("retained").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("removed", removed.clone()))
        .unwrap();
    cascade
        .persist_account(account("retained", retained.clone()))
        .unwrap();
    cascade
        .models
        .replace(
            &removed_id,
            vec![model(removed_id.clone(), "removed-model")],
        )
        .unwrap();
    cascade
        .models
        .replace(
            &retained_id,
            vec![model(retained_id.clone(), "retained-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(removed_id.clone(), "removed-model"),
                        vec![reference(retained_id.clone(), "retained-model")],
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();

    cascade
        .delete_account(
            &ProviderAccountId::try_new("removed").unwrap(),
            ProviderAccountRevision::try_new(1).unwrap(),
        )
        .unwrap();
    drop(cascade);

    let reopened = open_cascade(&paths);
    assert!(
        reopened
            .account(&ProviderAccountId::try_new("removed").unwrap())
            .is_none()
    );
    assert_eq!(
        reopened
            .catalog()
            .models()
            .iter()
            .map(ProviderModel::model_id)
            .collect::<Vec<_>>(),
        ["retained-model"]
    );
    let route = reopened
        .routing()
        .unwrap()
        .route(ProviderRoutingCapability::Chat)
        .unwrap();
    assert_eq!(route.primary().account_id(), &retained_id);
    assert_eq!(route.primary().model_id(), "retained-model");
    assert!(route.fallbacks().is_empty());
    assert!(!paths.journal.exists());
    paths.remove();
}

#[test]
fn deleting_fallback_keeps_primary_route() {
    let paths = Paths::new("delete-fallback");
    let primary_id = ProviderAccountId::try_new("primary").unwrap();
    let removed_id = ProviderAccountId::try_new("removed").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("primary", credential("primary")))
        .unwrap();
    cascade
        .persist_account(account("removed", credential("removed")))
        .unwrap();
    cascade
        .models
        .replace(
            &primary_id,
            vec![model(primary_id.clone(), "primary-model")],
        )
        .unwrap();
    cascade
        .models
        .replace(
            &removed_id,
            vec![model(removed_id.clone(), "removed-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(primary_id.clone(), "primary-model"),
                        vec![reference(removed_id.clone(), "removed-model")],
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();

    cascade
        .delete_account(&removed_id, ProviderAccountRevision::try_new(1).unwrap())
        .unwrap();

    let route = cascade
        .routing()
        .unwrap()
        .route(ProviderRoutingCapability::Chat)
        .unwrap();
    assert_eq!(route.primary().account_id(), &primary_id);
    assert!(route.fallbacks().is_empty());
    assert!(!paths.journal.exists());
    paths.remove();
}

#[test]
fn deleting_primary_without_fallback_drops_route() {
    let paths = Paths::new("delete-primary-no-fallback");
    let removed_id = ProviderAccountId::try_new("removed").unwrap();
    let retained_id = ProviderAccountId::try_new("retained").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("removed", credential("removed")))
        .unwrap();
    cascade
        .persist_account(account("retained", credential("retained")))
        .unwrap();
    cascade
        .models
        .replace(
            &removed_id,
            vec![model(removed_id.clone(), "removed-model")],
        )
        .unwrap();
    cascade
        .models
        .replace(
            &retained_id,
            vec![model(retained_id.clone(), "retained-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(removed_id.clone(), "removed-model"),
                        Vec::new(),
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();

    cascade
        .delete_account(&removed_id, ProviderAccountRevision::try_new(1).unwrap())
        .unwrap();

    assert!(
        cascade
            .routing()
            .unwrap()
            .route(ProviderRoutingCapability::Chat)
            .is_none()
    );
    assert!(
        cascade
            .catalog()
            .models()
            .iter()
            .any(|model| model.account_id() == &retained_id)
    );
    assert!(!paths.journal.exists());
    paths.remove();
}

#[test]
fn local_account_deletion_cascades_models_and_routes_by_account_identity() {
    let paths = Paths::new("local-delete");
    let account = local_account("local");
    let account_id = account.id().clone();
    let mut cascade = open_cascade(&paths);
    cascade.persist_account(account).unwrap();
    cascade
        .models
        .replace(&account_id, vec![model(account_id.clone(), "local-model")])
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(account_id.clone(), "local-model"),
                        Vec::new(),
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();

    cascade
        .delete_account(&account_id, ProviderAccountRevision::try_new(1).unwrap())
        .unwrap();

    assert!(cascade.account(&account_id).is_none());
    assert!(cascade.catalog().models().is_empty());
    assert!(cascade.routing().unwrap().routes().is_empty());
    assert!(!paths.journal.exists());
    paths.remove();
}

#[test]
fn disabling_primary_account_promotes_valid_fallback() {
    let paths = Paths::new("disable-primary-promote-fallback");
    let primary_id = ProviderAccountId::try_new("primary").unwrap();
    let fallback_id = ProviderAccountId::try_new("fallback").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("primary", credential("primary")))
        .unwrap();
    cascade
        .persist_account(account("fallback", credential("fallback")))
        .unwrap();
    cascade
        .replace_models(
            &primary_id,
            vec![model(primary_id.clone(), "primary-model")],
        )
        .unwrap();
    cascade
        .replace_models(
            &fallback_id,
            vec![model(fallback_id.clone(), "fallback-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(primary_id.clone(), "primary-model"),
                        vec![reference(fallback_id.clone(), "fallback-model")],
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();

    cascade
        .persist_account(account_with_revision(
            "primary",
            credential("primary"),
            ProviderAccountRevision::try_new(2).unwrap(),
            false,
            "2026-07-30T10:01:00Z",
        ))
        .unwrap();

    let routing = cascade.routing().unwrap();
    assert_eq!(routing.revision().get(), 2);
    let route = routing.route(ProviderRoutingCapability::Chat).unwrap();
    assert_eq!(route.primary().account_id(), &fallback_id);
    assert_eq!(route.primary().model_id(), "fallback-model");
    assert!(route.fallbacks().is_empty());
    assert!(provider_routing_is_admissible(
        routing,
        cascade.accounts(),
        cascade.catalog()
    ));
    paths.remove();
}

#[test]
fn replacing_models_promotes_first_valid_fallback_when_primary_model_is_removed() {
    let paths = Paths::new("replace-promote-fallback");
    let primary_id = ProviderAccountId::try_new("primary").unwrap();
    let fallback_id = ProviderAccountId::try_new("fallback").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("primary", credential("primary")))
        .unwrap();
    cascade
        .persist_account(account("fallback", credential("fallback")))
        .unwrap();
    cascade
        .replace_models(
            &primary_id,
            vec![model(primary_id.clone(), "primary-model")],
        )
        .unwrap();
    cascade
        .replace_models(
            &fallback_id,
            vec![model(fallback_id.clone(), "fallback-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(primary_id.clone(), "primary-model"),
                        vec![reference(fallback_id.clone(), "fallback-model")],
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();

    cascade.replace_models(&primary_id, Vec::new()).unwrap();

    let routing = cascade.routing().unwrap();
    assert_eq!(routing.revision().get(), 2);
    let route = routing.route(ProviderRoutingCapability::Chat).unwrap();
    assert_eq!(route.primary().account_id(), &fallback_id);
    assert_eq!(route.primary().model_id(), "fallback-model");
    assert!(route.fallbacks().is_empty());
    assert!(provider_routing_is_admissible(
        routing,
        cascade.accounts(),
        cascade.catalog()
    ));
    paths.remove();
}

#[test]
fn replacing_models_drops_removed_fallback_without_changing_primary() {
    let paths = Paths::new("replace-drop-fallback");
    let primary_id = ProviderAccountId::try_new("primary").unwrap();
    let fallback_id = ProviderAccountId::try_new("fallback").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("primary", credential("primary")))
        .unwrap();
    cascade
        .persist_account(account("fallback", credential("fallback")))
        .unwrap();
    cascade
        .replace_models(
            &primary_id,
            vec![model(primary_id.clone(), "primary-model")],
        )
        .unwrap();
    cascade
        .replace_models(
            &fallback_id,
            vec![model(fallback_id.clone(), "fallback-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(primary_id.clone(), "primary-model"),
                        vec![reference(fallback_id.clone(), "fallback-model")],
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();

    cascade.replace_models(&fallback_id, Vec::new()).unwrap();

    let routing = cascade.routing().unwrap();
    assert_eq!(routing.revision().get(), 2);
    let route = routing.route(ProviderRoutingCapability::Chat).unwrap();
    assert_eq!(route.primary().account_id(), &primary_id);
    assert_eq!(route.primary().model_id(), "primary-model");
    assert!(route.fallbacks().is_empty());
    assert!(provider_routing_is_admissible(
        routing,
        cascade.accounts(),
        cascade.catalog()
    ));
    paths.remove();
}

#[test]
fn replacing_models_with_empty_catalog_drops_route_without_valid_fallback() {
    let paths = Paths::new("replace-empty-drops-route");
    let account_id = ProviderAccountId::try_new("primary").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("primary", credential("primary")))
        .unwrap();
    cascade
        .replace_models(
            &account_id,
            vec![model(account_id.clone(), "primary-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(account_id.clone(), "primary-model"),
                        Vec::new(),
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();

    cascade.replace_models(&account_id, Vec::new()).unwrap();

    let routing = cascade.routing().unwrap();
    assert_eq!(routing.revision().get(), 2);
    assert!(routing.route(ProviderRoutingCapability::Chat).is_none());
    assert!(provider_routing_is_admissible(
        routing,
        cascade.accounts(),
        cascade.catalog()
    ));
    paths.remove();
}

#[test]
fn opening_prunes_routing_left_stale_after_interrupted_model_replace() {
    let paths = Paths::new("open-prunes-stale-routing");
    let removed_id = ProviderAccountId::try_new("removed").unwrap();
    let fallback_id = ProviderAccountId::try_new("fallback").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("removed", credential("removed")))
        .unwrap();
    cascade
        .persist_account(account("fallback", credential("fallback")))
        .unwrap();
    cascade
        .replace_models(
            &removed_id,
            vec![model(removed_id.clone(), "removed-model")],
        )
        .unwrap();
    cascade
        .replace_models(
            &fallback_id,
            vec![model(fallback_id.clone(), "fallback-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(removed_id.clone(), "removed-model"),
                        vec![reference(fallback_id.clone(), "fallback-model")],
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();
    cascade.models.replace(&removed_id, Vec::new()).unwrap();
    drop(cascade);

    let reopened = open_cascade(&paths);

    let routing = reopened.routing().unwrap();
    assert_eq!(routing.revision().get(), 2);
    let route = routing.route(ProviderRoutingCapability::Chat).unwrap();
    assert_eq!(route.primary().account_id(), &fallback_id);
    assert_eq!(route.primary().model_id(), "fallback-model");
    assert!(route.fallbacks().is_empty());
    assert!(provider_routing_is_admissible(
        routing,
        reopened.accounts(),
        reopened.catalog()
    ));
    drop(reopened);

    let reopened = open_cascade(&paths);
    assert_eq!(reopened.routing().unwrap().revision().get(), 2);
    paths.remove();
}

#[test]
fn reload_prunes_routing_left_stale_after_external_model_replace() {
    let paths = Paths::new("reload-prunes-stale-routing");
    let account_id = ProviderAccountId::try_new("primary").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("primary", credential("primary")))
        .unwrap();
    cascade
        .replace_models(
            &account_id,
            vec![model(account_id.clone(), "primary-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(account_id.clone(), "primary-model"),
                        Vec::new(),
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();
    let mut other = open_cascade(&paths);
    other.models.replace(&account_id, Vec::new()).unwrap();
    drop(other);

    cascade.reload().unwrap();

    let routing = cascade.routing().unwrap();
    assert_eq!(routing.revision().get(), 2);
    assert!(routing.route(ProviderRoutingCapability::Chat).is_none());
    assert!(provider_routing_is_admissible(
        routing,
        cascade.accounts(),
        cascade.catalog()
    ));
    cascade.reload().unwrap();
    assert_eq!(cascade.routing().unwrap().revision().get(), 2);
    paths.remove();
}

#[test]
fn pruning_current_catalog_removes_disabled_account_and_unsupported_capability() {
    let paths = Paths::new("prune-disabled-unsupported");
    let disabled_id = ProviderAccountId::try_new("disabled").unwrap();
    let fallback_id = ProviderAccountId::try_new("fallback").unwrap();
    let image_only_id = ProviderAccountId::try_new("image-only").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(disabled_account("disabled", credential("disabled")))
        .unwrap();
    cascade
        .persist_account(account("fallback", credential("fallback")))
        .unwrap();
    cascade
        .persist_account(account("image-only", credential("image-only")))
        .unwrap();
    cascade
        .replace_models(
            &disabled_id,
            vec![model(disabled_id.clone(), "disabled-model")],
        )
        .unwrap();
    cascade
        .replace_models(
            &fallback_id,
            vec![model(fallback_id.clone(), "fallback-model")],
        )
        .unwrap();
    cascade
        .replace_models(
            &image_only_id,
            vec![model_with_capabilities(
                image_only_id.clone(),
                "image-model",
                vec![ProviderModelCapability::ImageGenerate],
            )],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(disabled_id.clone(), "disabled-model"),
                        vec![
                            reference(image_only_id.clone(), "image-model"),
                            reference(fallback_id.clone(), "fallback-model"),
                        ],
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();

    cascade.prune_routing_to_current_catalog().unwrap();

    let routing = cascade.routing().unwrap();
    assert_eq!(routing.revision().get(), 2);
    let route = routing.route(ProviderRoutingCapability::Chat).unwrap();
    assert_eq!(route.primary().account_id(), &fallback_id);
    assert_eq!(route.primary().model_id(), "fallback-model");
    assert!(route.fallbacks().is_empty());
    assert!(provider_routing_is_admissible(
        routing,
        cascade.accounts(),
        cascade.catalog()
    ));
    paths.remove();
}

#[test]
fn opening_recovers_pending_deletion_then_prunes_unrelated_stale_routing() {
    let paths = Paths::new("recover-then-prune-stale-routing");
    let removed_id = ProviderAccountId::try_new("removed").unwrap();
    let stale_id = ProviderAccountId::try_new("stale").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("removed", credential("removed")))
        .unwrap();
    cascade
        .persist_account(account("stale", credential("stale")))
        .unwrap();
    cascade
        .models
        .replace(
            &removed_id,
            vec![model(removed_id.clone(), "removed-model")],
        )
        .unwrap();
    cascade
        .models
        .replace(&stale_id, vec![model(stale_id.clone(), "stale-model")])
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(stale_id.clone(), "stale-model"),
                        Vec::new(),
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();
    cascade.models.replace(&stale_id, Vec::new()).unwrap();
    cascade
        .journal
        .prepare(&AccountDeletion {
            account_id: "removed".to_owned(),
            revision: 1,
            routing_revision: None,
        })
        .unwrap();
    drop(cascade);

    let reopened = open_cascade(&paths);

    assert!(reopened.account(&removed_id).is_none());
    assert!(!paths.journal.exists());
    let routing = reopened.routing().unwrap();
    assert_eq!(routing.revision().get(), 2);
    assert!(routing.route(ProviderRoutingCapability::Chat).is_none());
    assert!(provider_routing_is_admissible(
        routing,
        reopened.accounts(),
        reopened.catalog()
    ));
    paths.remove();
}

#[test]
fn reopening_finishes_a_prepared_deletion_after_an_interrupted_first_step() {
    let paths = Paths::new("recover");
    let removed = credential("removed");
    let removed_id = ProviderAccountId::try_new("removed").unwrap();
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("removed", removed.clone()))
        .unwrap();
    cascade
        .models
        .replace(
            &removed_id,
            vec![model(removed_id.clone(), "removed-model")],
        )
        .unwrap();
    cascade
        .routing
        .replace(
            ProviderRouting::try_new(
                ProviderRoutingRevision::try_new(1).unwrap(),
                vec![(
                    ProviderRoutingCapability::Chat,
                    ProviderRoute::try_new(
                        reference(removed_id.clone(), "removed-model"),
                        Vec::new(),
                        None,
                    )
                    .unwrap(),
                )],
            )
            .unwrap(),
        )
        .unwrap();
    let transaction = AccountDeletion {
        account_id: "removed".to_owned(),
        revision: 1,
        routing_revision: Some(1),
    };
    cascade.journal.prepare(&transaction).unwrap();
    let journal = fs::read_to_string(&paths.journal).unwrap();
    for forbidden in ["apiKey", "secret-value", "observed", "applied", "endpoint"] {
        assert!(!journal.contains(forbidden));
    }
    cascade.models.replace(&removed_id, Vec::new()).unwrap();
    drop(cascade);

    let reopened = open_cascade(&paths);
    assert!(
        reopened
            .account(&ProviderAccountId::try_new("removed").unwrap())
            .is_none()
    );
    assert!(reopened.catalog().models().is_empty());
    assert!(reopened.routing().unwrap().routes().is_empty());
    assert!(!paths.journal.exists());
    paths.remove();
}

#[test]
fn ambiguous_journal_precondition_fails_closed_without_replaying() {
    let paths = Paths::new("ambiguous");
    let removed = credential("removed");
    let mut cascade = open_cascade(&paths);
    cascade
        .persist_account(account("removed", removed.clone()))
        .unwrap();
    cascade
        .journal
        .prepare(&AccountDeletion {
            account_id: "removed".to_owned(),
            revision: 1,
            routing_revision: Some(1),
        })
        .unwrap();
    drop(cascade);

    let error = match ProviderCascade::open(
        &paths.accounts,
        &paths.models,
        &paths.routing,
        &paths.journal,
    ) {
        Ok(_) => panic!("ambiguous transaction must not replay"),
        Err(error) => error,
    };
    assert_eq!(
        error.to_string(),
        "provider cascade requires manual recovery"
    );
    assert!(paths.journal.exists());
    paths.remove();
}
