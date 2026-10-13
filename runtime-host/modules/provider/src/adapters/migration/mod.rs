use std::{
    env,
    fs::File,
    io::{self, BufReader, Read},
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::Value;

mod account;
mod model;
mod recovery;
mod routing;

pub use recovery::{ProviderRecoveryNotice, ProviderRecoveryStore};

const MAX_STORE_BYTES: u64 = 1024 * 1024;
const PROVIDER_ACCOUNTS_ENV: &str = "MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE";
const PROVIDER_MODELS_ENV: &str = "MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE";
const PROVIDER_ROUTING_ENV: &str = "MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE";
const PROVIDER_ACCOUNTS_FILE: &str = "matchaclaw-provider-accounts.json";
const PROVIDER_MODELS_FILE: &str = "matchaclaw-provider-models.json";
const PROVIDER_ROUTING_FILE: &str = "matchaclaw-capability-routing.json";

pub struct ProviderLegacyStoreCandidates {
    pub accounts: Vec<PathBuf>,
    pub models: Vec<PathBuf>,
    pub routing: Vec<PathBuf>,
}

pub fn locate_provider_legacy_store_candidates(
    default_root: &Path,
) -> ProviderLegacyStoreCandidates {
    let legacy_root = legacy_runtime_host_data_dir();
    ProviderLegacyStoreCandidates {
        accounts: legacy_store_candidates(
            PROVIDER_ACCOUNTS_ENV,
            default_root,
            PROVIDER_ACCOUNTS_FILE,
            legacy_root.as_deref(),
        ),
        models: legacy_store_candidates(
            PROVIDER_MODELS_ENV,
            default_root,
            PROVIDER_MODELS_FILE,
            legacy_root.as_deref(),
        ),
        routing: legacy_store_candidates(
            PROVIDER_ROUTING_ENV,
            default_root,
            PROVIDER_ROUTING_FILE,
            legacy_root.as_deref(),
        ),
    }
}

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
    let paths = [
        std::path::absolute(accounts_path.into()).map_err(read_fault)?,
        std::path::absolute(models_path.into()).map_err(read_fault)?,
        std::path::absolute(routing_path.into()).map_err(read_fault)?,
    ];
    let store =
        ProviderRecoveryStore::new(paths[0].parent().ok_or(ProviderMigrationFault::Recovery)?);
    let _lock = store.writer_lock()?;
    store.recover_prepared(&paths)?;
    let (account_sources, model_sources, routing_sources) = sources;
    let selected = [
        select_source(&paths[0], account_sources)?,
        select_source(&paths[1], model_sources)?,
        select_source(&paths[2], routing_sources)?,
    ];
    if selected
        .iter()
        .all(|source| matches!(source.selection, SourceSelection::Unchanged))
    {
        return Ok(());
    }
    let backup = recovery::backup_sources(&store, &paths, &selected)?;
    let prepared = [
        account::prepare(&selected[0]),
        model::prepare(&selected[1]),
        routing::prepare(&selected[2]),
    ];
    let mut reset = false;
    for result in &prepared {
        match result {
            Err(ProviderMigrationFault::Decode | ProviderMigrationFault::InputTooLarge) => {
                reset = true;
            }
            Err(error) => return Err(*error),
            Ok(_) => {}
        }
    }
    let outputs = if reset {
        empty_store_bytes()?.map(Some)
    } else {
        prepared.map(|result| result.expect("preparation faults were handled"))
    };
    recovery::commit(&store, backup, &paths, &outputs, reset)
}

fn legacy_store_candidates(
    env_name: &str,
    default_root: &Path,
    file_name: &str,
    legacy_root: Option<&Path>,
) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    if let Ok(source) = env::var(env_name) {
        push_unique(&mut sources, PathBuf::from(source.trim()));
    }
    push_unique(&mut sources, default_root.join(file_name));
    if let Some(legacy_root) = legacy_root {
        push_unique(&mut sources, legacy_root.join(file_name));
    }
    sources
}

fn legacy_runtime_host_data_dir() -> Option<PathBuf> {
    if let Ok(root) = env::var("OPENCLAW_CONFIG_DIR") {
        let root = root.trim();
        if !root.is_empty() {
            return Some(PathBuf::from(root));
        }
    }
    home_dir().map(|home| home.join(".openclaw"))
}

fn home_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .or_else(|| env::var_os("USERPROFILE").filter(|value| !value.is_empty()))
        .map(PathBuf::from)
}

fn push_unique(sources: &mut Vec<PathBuf>, source: PathBuf) {
    if !source.as_os_str().is_empty() && !sources.iter().any(|candidate| candidate == &source) {
        sources.push(source);
    }
}

struct SelectedSource {
    target_exists: bool,
    target_bytes: Option<Vec<u8>>,
    path: Option<PathBuf>,
    source_bytes: Option<Vec<u8>>,
    selection: SourceSelection,
}

enum SourceSelection {
    Unchanged,
    Legacy(Vec<u8>),
    Invalid(ProviderMigrationFault),
}

fn select_source<Sources, Source>(
    target: &Path,
    sources: Sources,
) -> Result<SelectedSource, ProviderMigrationFault>
where
    Sources: IntoIterator<Item = Source>,
    Source: Into<PathBuf>,
{
    let mut selected = SelectedSource {
        target_exists: false,
        target_bytes: None,
        path: None,
        source_bytes: None,
        selection: SourceSelection::Unchanged,
    };
    match read_bounded(target) {
        Ok(Some(bytes)) if bytes.is_empty() => {
            selected.target_exists = true;
            selected.target_bytes = Some(bytes);
        }
        Ok(Some(bytes)) => {
            selected.target_exists = true;
            selected.path = Some(target.to_owned());
            selected.selection = match legacy_document_shape(&bytes) {
                Ok(true) => SourceSelection::Legacy(bytes.clone()),
                Ok(false) => SourceSelection::Unchanged,
                Err(error) => SourceSelection::Invalid(error),
            };
            selected.target_bytes = Some(bytes);
            return Ok(selected);
        }
        Err(ProviderMigrationFault::InputTooLarge) => {
            selected.target_exists = true;
            selected.path = Some(target.to_owned());
            selected.selection = SourceSelection::Invalid(ProviderMigrationFault::InputTooLarge);
            return Ok(selected);
        }
        Err(error) => return Err(error),
        Ok(None) => {}
    }
    let mut visited = Vec::new();
    for source in sources {
        let source = source.into();
        if source.as_os_str().is_empty() {
            continue;
        }
        let source = std::path::absolute(source).map_err(read_fault)?;
        if source == target || visited.contains(&source) {
            continue;
        }
        visited.push(source.clone());
        let selection = match read_bounded(&source) {
            Ok(None) => continue,
            Ok(Some(bytes)) if bytes.is_empty() => continue,
            Ok(Some(bytes)) => match legacy_source_contains_facts(&bytes) {
                Ok(false) => continue,
                Ok(true) => SourceSelection::Legacy(bytes),
                Err(error) => {
                    selected.source_bytes = Some(bytes);
                    SourceSelection::Invalid(error)
                }
            },
            Err(ProviderMigrationFault::InputTooLarge) => {
                SourceSelection::Invalid(ProviderMigrationFault::InputTooLarge)
            }
            Err(error) => return Err(error),
        };
        selected.path = Some(source);
        selected.selection = selection;
        break;
    }
    Ok(selected)
}

fn legacy_source<T>(source: &SelectedSource) -> Result<Option<T>, ProviderMigrationFault>
where
    T: for<'de> Deserialize<'de>,
{
    match &source.selection {
        SourceSelection::Unchanged => Ok(None),
        SourceSelection::Invalid(error) => Err(*error),
        SourceSelection::Legacy(bytes) => serde_json::from_slice(bytes)
            .map(Some)
            .map_err(|_| ProviderMigrationFault::Decode),
    }
}

fn empty_store_bytes() -> Result<[Vec<u8>; 3], ProviderMigrationFault> {
    let routing = crate::ProviderRouting::try_new(
        crate::ProviderRoutingRevision::try_new(1).expect("one is valid"),
        Vec::new(),
    )
    .map_err(|_| ProviderMigrationFault::Encode)?;
    Ok([
        crate::adapters::account_store::migration_bytes(&[])
            .map_err(|_| ProviderMigrationFault::Encode)?,
        crate::adapters::model_store::migration_bytes(&crate::ProviderModelCatalog::default())
            .map_err(|_| ProviderMigrationFault::Encode)?,
        crate::adapters::routing_store::migration_bytes(&routing)
            .map_err(|_| ProviderMigrationFault::Encode)?,
    ])
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
    InputTooLarge,
    RecordTooLarge,
    Read(io::ErrorKind),
    Backup(io::ErrorKind),
    Permission,
    Journal(io::ErrorKind),
    Recovery,
    Commit(io::ErrorKind),
    CommitOutcomeUnknown(io::ErrorKind),
}

impl std::fmt::Display for ProviderMigrationFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Decode => "legacy provider facts are invalid",
            Self::Encode => "legacy provider facts could not be encoded",
            Self::InputTooLarge => "provider migration input exceeds the durable limit",
            Self::RecordTooLarge => "provider migration output exceeds the durable limit; original configuration retained",
            Self::Read(_) => "provider configuration could not be read; check file access and retry",
            Self::Backup(_) => "provider configuration backup failed; original configuration retained; check disk space and file access",
            Self::Permission => "provider recovery storage could not be made owner-only; original configuration retained; check permissions",
            Self::Journal(_) => "provider recovery record could not be persisted; check disk space and file access before restarting",
            Self::Recovery => "provider recovery record or deletion journal is invalid; restore from the provider backup before restarting",
            Self::Commit(_) => "provider configuration migration failed; original configuration retained; check disk space and file access",
            Self::CommitOutcomeUnknown(_) => "provider migration outcome is unknown; restart to recover the prepared backup before changing configuration",
        })
    }
}

impl std::error::Error for ProviderMigrationFault {}

fn read_fault(error: io::Error) -> ProviderMigrationFault {
    ProviderMigrationFault::Read(error.kind())
}

fn read_bounded(path: &Path) -> Result<Option<Vec<u8>>, ProviderMigrationFault> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(read_fault(error)),
    };
    if file.metadata().map_err(read_fault)?.len() > MAX_STORE_BYTES {
        return Err(ProviderMigrationFault::InputTooLarge);
    }
    let mut bytes = Vec::new();
    BufReader::new(file)
        .take(MAX_STORE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(read_fault)?;
    if bytes.len() > MAX_STORE_BYTES as usize {
        return Err(ProviderMigrationFault::InputTooLarge);
    }
    Ok(Some(bytes))
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
