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
    ProviderRoute, ProviderRoutingCapability,
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
    ProviderAccount::new(
        ProviderAccountId::try_new(id).unwrap(),
        ProviderReference::try_new("provider:openai").unwrap(),
        ProviderAccountRevision::try_new(1).unwrap(),
        ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
            label: "Primary".to_owned(),
            enabled: true,
            kind: ProviderAccountKind::Chat,
            endpoint: Some(ProviderEndpoint::try_new("https://api.example.com/v1").unwrap()),
            protocol: Some(ProviderApiProtocol::OpenAiResponses),
            media_protocol: None,
            auth_mode: ProviderAccountAuthMode::ApiKey,
            credential: Some(credential),
            created_at: "2026-07-30T10:00:00Z".to_owned(),
            updated_at: "2026-07-30T10:00:00Z".to_owned(),
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
    ProviderModel::try_new(
        account_id,
        model_id,
        vec![ProviderModelCapability::Chat],
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
    assert!(reopened.routing().unwrap().routes().is_empty());
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
