use std::{
    env,
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, de::DeserializeOwned};
use serde_json::Value;

#[path = "provider_migration_account.rs"]
mod provider_migration_account;
#[path = "provider_migration_model.rs"]
mod provider_migration_model;
#[path = "provider_migration_routing.rs"]
mod provider_migration_routing;

const MAX_STORE_BYTES: u64 = 1024 * 1024;

/// Converts the three pre-Rust provider documents before their typed stores are opened.
///
/// This is bootstrap-only. Typed stores intentionally recover canonical documents exclusively.
pub fn migrate_provider_legacy_stores(
    accounts_path: impl Into<PathBuf>,
    models_path: impl Into<PathBuf>,
    routing_path: impl Into<PathBuf>,
) -> Result<(), ProviderMigrationFault> {
    let accounts_path = accounts_path.into();
    let models_path = models_path.into();
    let routing_path = routing_path.into();
    let default_root = accounts_path.parent().unwrap_or_else(|| Path::new(""));
    import_legacy_runtime_host_store(
        "MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE",
        &accounts_path,
        default_root,
        "matchaclaw-provider-accounts.json",
    )?;
    import_legacy_runtime_host_store(
        "MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE",
        &models_path,
        default_root,
        "matchaclaw-provider-models.json",
    )?;
    import_legacy_runtime_host_store(
        "MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE",
        &routing_path,
        default_root,
        "matchaclaw-capability-routing.json",
    )?;
    provider_migration_account::migrate(&accounts_path)?;
    provider_migration_model::migrate(&models_path)?;
    provider_migration_routing::migrate(&routing_path)?;
    Ok(())
}

fn import_legacy_runtime_host_store(
    env_name: &str,
    target: &Path,
    default_root: &Path,
    file_name: &str,
) -> Result<(), ProviderMigrationFault> {
    if target.exists() {
        return Ok(());
    }
    for source in legacy_store_candidates(env_name, default_root, file_name) {
        if source.as_os_str().is_empty() || source == target {
            continue;
        }
        let bytes = read_bounded(&source)?;
        if bytes.is_empty() || !legacy_source_contains_facts(&bytes)? {
            continue;
        }
        return write_atomic(target, &bytes);
    }
    Ok(())
}

fn legacy_store_candidates(env_name: &str, default_root: &Path, file_name: &str) -> Vec<PathBuf> {
    let mut sources = Vec::new();
    if let Ok(source) = env::var(env_name) {
        push_unique(&mut sources, PathBuf::from(source.trim()));
    }
    push_unique(&mut sources, default_root.join(file_name));
    if let Some(legacy_root) = legacy_runtime_host_data_dir() {
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

fn legacy_source_contains_facts(bytes: &[u8]) -> Result<bool, ProviderMigrationFault> {
    let value =
        serde_json::from_slice::<Value>(bytes).map_err(|_| ProviderMigrationFault::Decode)?;
    if !value.is_object() || value.get("version").is_some() || value.get("schemaVersion").is_none()
    {
        return Ok(false);
    }
    Ok(non_empty_object(value.get("accounts"))
        || non_empty_array(value.get("models"))
        || non_empty_object(value.get("routing")))
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

pub(super) enum LegacyDocument<T> {
    Missing,
    Canonical,
    Legacy(T),
}

pub(super) fn legacy_document<T: DeserializeOwned>(
    path: &Path,
) -> Result<LegacyDocument<T>, ProviderMigrationFault> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LegacyDocument::Missing);
        }
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
    let mut reader = BufReader::new(file).take(MAX_STORE_BYTES + 1);
    let shape: DocumentShape =
        serde_json::from_reader(&mut reader).map_err(|_| ProviderMigrationFault::Decode)?;
    if shape.version.is_some() || shape.schema_version.is_none() {
        return Ok(LegacyDocument::Canonical);
    }
    let file = File::open(path).map_err(|error| ProviderMigrationFault::Commit(error.kind()))?;
    let mut reader = BufReader::new(file).take(MAX_STORE_BYTES + 1);
    serde_json::from_reader(&mut reader)
        .map(LegacyDocument::Legacy)
        .map_err(|_| ProviderMigrationFault::Decode)
}

#[derive(Deserialize)]
struct DocumentShape {
    version: Option<u8>,
    #[serde(rename = "schemaVersion")]
    schema_version: Option<u8>,
}

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
    if let Err(error) = fs::rename(&temporary, path) {
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
        env, fs,
        path::{Path, PathBuf},
        sync::{Mutex, OnceLock},
        time::{SystemTime, UNIX_EPOCH},
    };

    use serde_json::Value;

    use super::migrate_provider_legacy_stores;

    static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    #[test]
    fn imports_env_legacy_stores_before_canonical_migration() {
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let root = test_root("env-legacy-provider-import");
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
        set_env(
            "MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE",
            &legacy_accounts,
        );
        set_env(
            "MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE",
            &legacy_models,
        );
        set_env(
            "MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE",
            &legacy_routing,
        );

        migrate_provider_legacy_stores(&accounts, &models, &routing).unwrap();

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
        unset_env("MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE");
        unset_env("MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE");
        unset_env("MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn env_legacy_import_does_not_overwrite_existing_canonical_store() {
        let _guard = ENV_LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
        let root = test_root("env-legacy-provider-preserve");
        fs::create_dir_all(&root).unwrap();
        let legacy_accounts = root.join("legacy-accounts.json");
        let accounts = root.join("matchaclaw-provider-accounts.json");
        fs::write(
            &legacy_accounts,
            r#"{"schemaVersion":2,"accounts":{"legacy":{"id":"legacy","vendorId":"openai","label":"Legacy","authMode":"api_key","enabled":true,"createdAt":"2026-08-11T00:00:00Z","updatedAt":"2026-08-11T00:00:00Z"}},"apiKeys":{}}"#,
        )
        .unwrap();
        fs::write(&accounts, r#"{"version":1,"accounts":[]}"#).unwrap();
        set_env(
            "MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE",
            &legacy_accounts,
        );

        migrate_provider_legacy_stores(
            &accounts,
            root.join("missing-models.json"),
            root.join("missing-routing.json"),
        )
        .unwrap();

        assert_eq!(
            json(&accounts).pointer("/accounts"),
            Some(&Value::Array(Vec::new()))
        );
        unset_env("MATCHACLAW_RUNTIME_HOST_PROVIDER_STORE_FILE");
        unset_env("MATCHACLAW_RUNTIME_HOST_PROVIDER_MODELS_STORE_FILE");
        unset_env("MATCHACLAW_RUNTIME_HOST_CAPABILITY_ROUTING_STORE_FILE");
        let _ = fs::remove_dir_all(root);
    }

    fn test_root(name: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        env::temp_dir().join(format!("matchaclaw-{name}-{}-{nanos}", std::process::id()))
    }

    fn json(path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    fn set_env(name: &str, value: &Path) {
        unsafe { env::set_var(name, value) }
    }

    fn unset_env(name: &str) {
        unsafe { env::remove_var(name) }
    }
}
