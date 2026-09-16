use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::Value;

mod account;
mod model;
mod routing;

const MAX_STORE_BYTES: u64 = 1024 * 1024;

/// Imports explicit pre-Rust provider candidates and converts legacy provider documents.
///
/// This is bootstrap-only. Typed stores intentionally recover canonical documents exclusively.
pub fn migrate_provider_legacy_stores<
    AccountSources,
    ModelSources,
    RoutingSources,
    AccountSource,
    ModelSource,
    RoutingSource,
>(
    accounts_path: impl Into<PathBuf>,
    models_path: impl Into<PathBuf>,
    routing_path: impl Into<PathBuf>,
    sources: (AccountSources, ModelSources, RoutingSources),
) -> Result<(), ProviderMigrationFault>
where
    AccountSources: IntoIterator<Item = AccountSource>,
    ModelSources: IntoIterator<Item = ModelSource>,
    RoutingSources: IntoIterator<Item = RoutingSource>,
    AccountSource: Into<PathBuf>,
    ModelSource: Into<PathBuf>,
    RoutingSource: Into<PathBuf>,
{
    let accounts_path = accounts_path.into();
    let models_path = models_path.into();
    let routing_path = routing_path.into();
    let (account_sources, model_sources, routing_sources) = sources;
    account::migrate(&accounts_path, account_sources)?;
    model::migrate(&models_path, model_sources)?;
    routing::migrate(&routing_path, routing_sources)?;
    Ok(())
}

fn legacy_source<Sources, Source, T>(
    sources: Sources,
    target: &Path,
) -> Result<Option<T>, ProviderMigrationFault>
where
    Sources: IntoIterator<Item = Source>,
    Source: Into<PathBuf>,
    T: for<'de> Deserialize<'de>,
{
    match legacy_target(target)? {
        TargetDocument::Legacy(legacy) => return Ok(Some(legacy)),
        TargetDocument::Canonical => return Ok(None),
        TargetDocument::Missing => {}
    }
    let mut visited_sources = Vec::new();
    for source in sources {
        let source = source.into();
        if source.as_os_str().is_empty()
            || source == target
            || visited_sources.iter().any(|candidate| candidate == &source)
        {
            continue;
        }
        visited_sources.push(source.clone());
        let bytes = read_bounded(&source)?;
        if bytes.is_empty() || !legacy_source_contains_facts(&bytes)? {
            continue;
        }
        return serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| ProviderMigrationFault::Decode);
    }
    Ok(None)
}

enum TargetDocument<T> {
    Missing,
    Canonical,
    Legacy(T),
}

fn legacy_target<T>(target: &Path) -> Result<TargetDocument<T>, ProviderMigrationFault>
where
    T: for<'de> Deserialize<'de>,
{
    let bytes = read_bounded(target)?;
    if bytes.is_empty() {
        return Ok(TargetDocument::Missing);
    }
    if !legacy_document_shape(&bytes)? {
        return Ok(TargetDocument::Canonical);
    }
    serde_json::from_slice(&bytes)
        .map(TargetDocument::Legacy)
        .map_err(|_| ProviderMigrationFault::Decode)
}

fn legacy_source_contains_facts(bytes: &[u8]) -> Result<bool, ProviderMigrationFault> {
    let value = legacy_json(bytes)?;
    if !legacy_value_shape(&value) {
        return Ok(false);
    }
    Ok(non_empty_object(value.get("accounts"))
        || non_empty_array(value.get("models"))
        || non_empty_object(value.get("routing")))
}

fn legacy_document_shape(bytes: &[u8]) -> Result<bool, ProviderMigrationFault> {
    Ok(legacy_value_shape(&legacy_json(bytes)?))
}

fn legacy_json(bytes: &[u8]) -> Result<Value, ProviderMigrationFault> {
    serde_json::from_slice::<Value>(bytes).map_err(|_| ProviderMigrationFault::Decode)
}

fn legacy_value_shape(value: &Value) -> bool {
    value.is_object() && value.get("version").is_none() && value.get("schemaVersion").is_some()
}

fn non_empty_object(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_object)
        .is_some_and(|value| !value.is_empty())
}

fn non_empty_array(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_array)
        .is_some_and(|value| !value.is_empty())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderMigrationFault {
    Decode,
    Encode,
    RecordTooLarge,
    Commit(io::ErrorKind),
    CommitOutcomeUnknown(io::ErrorKind),
}

impl std::fmt::Display for ProviderMigrationFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Decode => "legacy provider facts are invalid",
            Self::Encode => "legacy provider facts could not be encoded",
            Self::RecordTooLarge => "legacy provider facts exceed the durable limit",
            Self::Commit(_) => "legacy provider facts could not be committed",
            Self::CommitOutcomeUnknown(_) => "legacy provider migration commit outcome is unknown",
        })
    }
}

impl std::error::Error for ProviderMigrationFault {}

fn read_bounded(path: &Path) -> Result<Vec<u8>, ProviderMigrationFault> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(ProviderMigrationFault::Commit(error.kind())),
    };
    if file
        .metadata()
        .map_err(|error| ProviderMigrationFault::Commit(error.kind()))?
        .len()
        > MAX_STORE_BYTES
    {
        return Err(ProviderMigrationFault::RecordTooLarge);
    }
    let mut bytes = Vec::new();
    BufReader::new(file)
        .take(MAX_STORE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| ProviderMigrationFault::Commit(error.kind()))?;
    if bytes.len() > MAX_STORE_BYTES as usize {
        return Err(ProviderMigrationFault::RecordTooLarge);
    }
    Ok(bytes)
}

pub(super) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), ProviderMigrationFault> {
    if bytes.len() > MAX_STORE_BYTES as usize {
        return Err(ProviderMigrationFault::RecordTooLarge);
    }
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        fs::create_dir_all(parent).map_err(|error| ProviderMigrationFault::Commit(error.kind()))?;
    }
    let temporary = temporary_path(path);
    fs::remove_file(&temporary)
        .or_else(|error| {
            (error.kind() == io::ErrorKind::NotFound)
                .then_some(())
                .ok_or(error)
        })
        .map_err(|error| ProviderMigrationFault::Commit(error.kind()))?;
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| ProviderMigrationFault::Commit(error.kind()))?;
    if let Err(error) = file.write_all(bytes) {
        let _ = fs::remove_file(&temporary);
        return Err(ProviderMigrationFault::Commit(error.kind()));
    }
    if let Err(error) = file.sync_data() {
        let _ = fs::remove_file(&temporary);
        return Err(ProviderMigrationFault::CommitOutcomeUnknown(error.kind()));
    }
    drop(file);
    if let Err(error) = crate::persistence::replace_file(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(ProviderMigrationFault::CommitOutcomeUnknown(error.kind()));
    }
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".next");
    temporary.into()
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::Value;

    use super::migrate_provider_legacy_stores;

    #[test]
    fn imports_explicit_legacy_candidates_before_canonical_migration() {
        let root = test_root("explicit-legacy-provider-import");
        fs::create_dir_all(&root).unwrap();
        let legacy_accounts = root.join("legacy-accounts.json");
        let legacy_models = root.join("legacy-models.json");
        let legacy_routing = root.join("legacy-routing.json");
        let accounts = root
            .join("canonical")
            .join("matchaclaw-provider-accounts.json");
        let models = root
            .join("canonical")
            .join("matchaclaw-provider-models.json");
        let routing = root
            .join("canonical")
            .join("matchaclaw-capability-routing.json");
        fs::write(
            &legacy_accounts,
            r#"{
              "schemaVersion":2,
              "accounts":{
                "openai-main":{
                  "id":"openai-main",
                  "vendorId":"openai",
                  "label":"OpenAI",
                  "authMode":"api_key",
                  "enabled":true,
                  "providerKind":"chat",
                  "baseUrl":"https://api.openai.com/v1",
                  "apiProtocol":"openai-responses",
                  "createdAt":"2026-08-11T00:00:00Z",
                  "updatedAt":"2026-08-11T00:00:00Z"
                }
              },
              "apiKeys":{"openai-main":"sk-secret"}
            }"#,
        )
        .unwrap();
        fs::write(
            &legacy_models,
            r#"{
              "schemaVersion":1,
              "models":[{
                "credentialId":"openai-main",
                "modelId":"gpt-5.6",
                "capabilities":["chat","imageUnderstand"],
                "contextWindow":128000
              }]
            }"#,
        )
        .unwrap();
        fs::write(
            &legacy_routing,
            r#"{
              "schemaVersion":1,
              "routing":{
                "chat":{"primary":{"credentialId":"openai-main","modelId":"gpt-5.6"},"fallbacks":[]}
              }
            }"#,
        )
        .unwrap();
        migrate_provider_legacy_stores(
            &accounts,
            &models,
            &routing,
            (
                vec![legacy_accounts.clone()],
                vec![legacy_models.clone()],
                vec![legacy_routing.clone()],
            ),
        )
        .unwrap();

        let account_doc = json(&accounts);
        assert_eq!(
            account_doc.pointer("/accounts/0/id"),
            Some(&Value::String("openai-main".into()))
        );
        assert_eq!(
            account_doc.pointer("/accounts/0/provider"),
            Some(&Value::String("provider:openai".into()))
        );
        assert_eq!(
            account_doc.pointer("/accounts/0/credential"),
            Some(&Value::String("credential:v1:openai-main".into()))
        );
        assert!(!fs::read_to_string(&accounts).unwrap().contains("sk-secret"));
        let model_doc = json(&models);
        assert_eq!(
            model_doc.pointer("/models/0/account_id"),
            Some(&Value::String("openai-main".into()))
        );
        assert_eq!(
            model_doc.pointer("/models/0/model_id"),
            Some(&Value::String("gpt-5.6".into()))
        );
        let routing_doc = json(&routing);
        assert_eq!(
            routing_doc.pointer("/routes/0/primary/account_id"),
            Some(&Value::String("openai-main".into()))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_legacy_target_is_rewritten_to_canonical_without_secret() {
        let root = test_root("existing-legacy-provider-target");
        fs::create_dir_all(&root).unwrap();
        let accounts = root.join("matchaclaw-provider-accounts.json");
        fs::write(
            &accounts,
            r#"{"schemaVersion":2,"accounts":{"openai-main":{"id":"openai-main","vendorId":"openai","label":"OpenAI","authMode":"api_key","enabled":true,"providerKind":"chat","baseUrl":"https://api.openai.com/v1","apiProtocol":"openai-responses","createdAt":"2026-08-11T00:00:00Z","updatedAt":"2026-08-11T00:00:00Z"}},"apiKeys":{"openai-main":"sk-secret"}}"#,
        )
        .unwrap();

        migrate_provider_legacy_stores(
            &accounts,
            root.join("missing-models.json"),
            root.join("missing-routing.json"),
            (
                Vec::<PathBuf>::new(),
                Vec::<PathBuf>::new(),
                Vec::<PathBuf>::new(),
            ),
        )
        .unwrap();

        let contents = fs::read_to_string(&accounts).unwrap();
        assert!(!contents.contains("sk-secret"));
        assert_eq!(
            json(&accounts).pointer("/accounts/0/credential"),
            Some(&Value::String("credential:v1:openai-main".into()))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_empty_legacy_target_is_rewritten_to_canonical_store() {
        let root = test_root("existing-empty-legacy-provider-target");
        fs::create_dir_all(&root).unwrap();
        let accounts = root.join("matchaclaw-provider-accounts.json");
        let models = root.join("matchaclaw-provider-models.json");
        let routing = root.join("matchaclaw-capability-routing.json");
        fs::write(
            &accounts,
            r#"{"schemaVersion":2,"accounts":{},"apiKeys":{}}"#,
        )
        .unwrap();
        fs::write(&models, r#"{"schemaVersion":1,"models":[]}"#).unwrap();
        fs::write(&routing, r#"{"schemaVersion":1,"routing":{}}"#).unwrap();

        migrate_provider_legacy_stores(
            &accounts,
            &models,
            &routing,
            (
                Vec::<PathBuf>::new(),
                Vec::<PathBuf>::new(),
                Vec::<PathBuf>::new(),
            ),
        )
        .unwrap();

        assert_eq!(
            json(&accounts).pointer("/accounts"),
            Some(&Value::Array(Vec::new()))
        );
        assert_eq!(
            json(&models).pointer("/models"),
            Some(&Value::Array(Vec::new()))
        );
        assert_eq!(
            json(&routing).pointer("/routes"),
            Some(&Value::Array(Vec::new()))
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_canonical_store_is_not_overwritten_by_legacy_candidates() {
        let root = test_root("explicit-legacy-provider-preserve");
        fs::create_dir_all(&root).unwrap();
        let legacy_accounts = root.join("legacy-accounts.json");
        let accounts = root.join("matchaclaw-provider-accounts.json");
        fs::write(
            &legacy_accounts,
            r#"{"schemaVersion":2,"accounts":{"legacy":{"id":"legacy","vendorId":"openai","label":"Legacy","authMode":"api_key","enabled":true,"createdAt":"2026-08-11T00:00:00Z","updatedAt":"2026-08-11T00:00:00Z"}},"apiKeys":{}}"#,
        )
        .unwrap();
        fs::write(
            &accounts,
            r#"{"version":1,"accounts":[{"id":"canonical","provider":"provider:openai","revision":1,"label":"Canonical","enabled":true,"kind":"chat","endpoint":null,"protocol":null,"media_protocol":null,"auth_mode":"local","credential":null,"created_at":"2026-08-11T00:00:00Z","updated_at":"2026-08-11T00:00:00Z"}]}"#,
        )
        .unwrap();
        migrate_provider_legacy_stores(
            &accounts,
            root.join("missing-models.json"),
            root.join("missing-routing.json"),
            (
                vec![legacy_accounts],
                Vec::<PathBuf>::new(),
                Vec::<PathBuf>::new(),
            ),
        )
        .unwrap();

        assert_eq!(
            json(&accounts).pointer("/accounts/0/id"),
            Some(&Value::String("canonical".into()))
        );
        let _ = fs::remove_dir_all(root);
    }

    fn test_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("matchaclaw-{name}-{}-{nanos}", std::process::id()))
    }

    fn json(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }
}
