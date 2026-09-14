use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use crate::{
    CredentialReference, ProviderAccount, ProviderAccountAuthMode, ProviderAccountConfiguration,
    ProviderAccountConfigurationInput, ProviderAccountId, ProviderAccountKind,
    ProviderAccountRevision, ProviderApiProtocol, ProviderEndpoint, ProviderMediaApiProtocol,
    ProviderReference,
};

const STORE_VERSION: u8 = 1;
const MAX_STORE_BYTES: u64 = 1024 * 1024;

pub struct ProviderAccountStore {
    path: PathBuf,
    lock_path: PathBuf,
    accounts: Vec<ProviderAccount>,
    requires_reopen: bool,
}

impl ProviderAccountStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, ProviderAccountStoreFault> {
        let path = path.into();
        ensure_parent_directory(&path)?;
        let lock_path = lock_path(&path);
        let _lock = WriterLock::acquire(&lock_path)?;
        remove_stale_temporary(&path)?;
        let accounts = recover(&path)?;
        Ok(Self {
            accounts,
            path,
            lock_path,
            requires_reopen: false,
        })
    }

    pub fn accounts(&self) -> &[ProviderAccount] {
        &self.accounts
    }

    pub fn account(&self, id: &ProviderAccountId) -> Option<&ProviderAccount> {
        self.accounts.iter().find(|account| account.id() == id)
    }

    /// Refreshes this read model after a related Host-owned provider mutation.
    pub fn reload(&mut self) -> Result<(), ProviderAccountStoreFault> {
        let _lock = WriterLock::acquire(&self.lock_path)?;
        let accounts = recover(&self.path)?;
        self.accounts = accounts;
        self.requires_reopen = false;
        Ok(())
    }

    pub fn persist(
        &mut self,
        account: ProviderAccount,
    ) -> Result<&ProviderAccount, ProviderAccountStoreFault> {
        if self.requires_reopen {
            return Err(ProviderAccountStoreFault::RecoveryRequired);
        }
        let account_id = account.id().clone();
        let _lock = WriterLock::acquire(&self.lock_path)?;
        let accounts = recover(&self.path)?;
        self.accounts = accounts;
        let mut accounts = self.accounts.clone();
        match accounts
            .iter()
            .position(|current| current.id() == account.id())
        {
            None if account.revision().get() == 1 => accounts.push(account),
            None => return Err(ProviderAccountStoreFault::InitialRevisionRequired),
            Some(index) => {
                let current = &accounts[index];
                if account.provider() != current.provider() {
                    return Err(ProviderAccountStoreFault::ProviderImmutable);
                }
                if account.revision() < current.revision() {
                    return Err(ProviderAccountStoreFault::StaleRevision);
                }
                if account.revision() == current.revision() {
                    if &account != current {
                        return Err(ProviderAccountStoreFault::RevisionConflict);
                    }
                    return Ok(self
                        .account(&account_id)
                        .expect("existing account remains addressable"));
                }
                if current.revision().get().checked_add(1) != Some(account.revision().get()) {
                    return Err(ProviderAccountStoreFault::RevisionMustFollowCurrent);
                }
                accounts[index] = account;
            }
        }
        accounts.sort_by(|left, right| left.id().as_str().cmp(right.id().as_str()));
        self.replace(&accounts)?;
        self.accounts = accounts;
        Ok(self
            .account(&account_id)
            .expect("persisted account remains addressable"))
    }

    pub fn delete(
        &mut self,
        id: &ProviderAccountId,
        revision: ProviderAccountRevision,
    ) -> Result<(), ProviderAccountStoreFault> {
        if self.requires_reopen {
            return Err(ProviderAccountStoreFault::RecoveryRequired);
        }
        let _lock = WriterLock::acquire(&self.lock_path)?;
        let accounts = recover(&self.path)?;
        self.accounts = accounts;
        let index = self
            .accounts
            .iter()
            .position(|account| account.id() == id)
            .ok_or(ProviderAccountStoreFault::UnknownAccount)?;
        let current = &self.accounts[index];
        if revision < current.revision() {
            return Err(ProviderAccountStoreFault::StaleRevision);
        }
        if revision > current.revision() {
            return Err(ProviderAccountStoreFault::RevisionMustFollowCurrent);
        }
        let mut accounts = self.accounts.clone();
        accounts.remove(index);
        self.replace(&accounts)?;
        self.accounts = accounts;
        Ok(())
    }

    fn replace(&mut self, accounts: &[ProviderAccount]) -> Result<(), ProviderAccountStoreFault> {
        let bytes = serde_json::to_vec(&ProviderAccountStoreDocument::from_accounts(accounts))
            .map_err(|_| ProviderAccountStoreFault::Encode)?;
        if bytes.len() > MAX_STORE_BYTES as usize {
            return Err(ProviderAccountStoreFault::RecordTooLarge);
        }
        let temporary = temporary_path(&self.path);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| ProviderAccountStoreFault::Commit(error.kind()))?;
        use std::io::Write;
        if let Err(error) = file.write_all(&bytes) {
            let _ = fs::remove_file(&temporary);
            return Err(ProviderAccountStoreFault::Commit(error.kind()));
        }
        if let Err(error) = file.sync_data() {
            self.requires_reopen = true;
            let _ = fs::remove_file(&temporary);
            return Err(ProviderAccountStoreFault::CommitOutcomeUnknown(
                error.kind(),
            ));
        }
        drop(file);
        if let Err(error) = fs::rename(&temporary, &self.path) {
            self.requires_reopen = true;
            let _ = fs::remove_file(&temporary);
            return Err(ProviderAccountStoreFault::CommitOutcomeUnknown(
                error.kind(),
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderAccountStoreFault {
    Commit(io::ErrorKind),
    CommitOutcomeUnknown(io::ErrorKind),
    Decode,
    Encode,
    InitialRevisionRequired,
    ProviderImmutable,
    RecordTooLarge,
    RecoveryRequired,
    RevisionConflict,
    UnknownAccount,
    RevisionMustFollowCurrent,
    StaleRevision,
    WriterBusy,
}

impl std::fmt::Display for ProviderAccountStoreFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Commit(_) => "provider account facts could not be committed",
            Self::CommitOutcomeUnknown(_) => {
                "provider account commit outcome is unknown; reopen before retrying"
            }
            Self::Decode => "provider account facts are invalid",
            Self::Encode => "provider account facts could not be encoded",
            Self::InitialRevisionRequired => "initial provider account revision must be one",
            Self::ProviderImmutable => "provider account provider is immutable",
            Self::RecordTooLarge => "provider account facts exceed the durable limit",
            Self::RecoveryRequired => {
                "provider account facts require reopening before another mutation"
            }
            Self::RevisionConflict => {
                "provider account revision is already assigned to different facts"
            }
            Self::UnknownAccount => "provider account is unknown",
            Self::RevisionMustFollowCurrent => {
                "provider account revision must immediately follow current facts"
            }
            Self::StaleRevision => "provider account revision must advance monotonically",
            Self::WriterBusy => "provider account facts writer is busy",
        })
    }
}

impl std::error::Error for ProviderAccountStoreFault {}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderAccountStoreDocument {
    version: u8,
    accounts: Vec<ProviderAccountDocument>,
}

impl ProviderAccountStoreDocument {
    fn from_accounts(accounts: &[ProviderAccount]) -> Self {
        Self {
            version: STORE_VERSION,
            accounts: accounts
                .iter()
                .map(ProviderAccountDocument::from_account)
                .collect(),
        }
    }

    fn into_accounts(self) -> Result<Vec<ProviderAccount>, ProviderAccountStoreFault> {
        if self.version != STORE_VERSION {
            return Err(ProviderAccountStoreFault::Decode);
        }
        let mut accounts = self
            .accounts
            .into_iter()
            .map(ProviderAccountDocument::into_account)
            .collect::<Result<Vec<_>, _>>()?;
        accounts.sort_by(|left, right| left.id().as_str().cmp(right.id().as_str()));
        if accounts.windows(2).any(|pair| pair[0].id() == pair[1].id()) {
            return Err(ProviderAccountStoreFault::Decode);
        }
        Ok(accounts)
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderAccountDocument {
    id: String,
    provider: String,
    revision: u64,
    label: String,
    enabled: bool,
    kind: ProviderAccountKindDocument,
    endpoint: Option<String>,
    protocol: Option<ProviderApiProtocolDocument>,
    media_protocol: Option<ProviderMediaApiProtocolDocument>,
    auth_mode: ProviderAccountAuthModeDocument,
    credential: Option<String>,
    created_at: String,
    updated_at: String,
}

impl ProviderAccountDocument {
    fn from_account(account: &ProviderAccount) -> Self {
        let configuration = account.configuration();
        Self {
            id: account.id().as_str().to_owned(),
            provider: account.provider().as_str().to_owned(),
            revision: account.revision().get(),
            label: configuration.label().to_owned(),
            enabled: configuration.enabled(),
            kind: configuration.kind().into(),
            endpoint: configuration
                .endpoint()
                .map(|endpoint| endpoint.as_str().to_owned()),
            protocol: configuration.protocol().map(Into::into),
            media_protocol: configuration.media_protocol().map(Into::into),
            auth_mode: configuration.auth_mode().into(),
            credential: configuration
                .credential()
                .map(|reference| reference.as_str().to_owned()),
            created_at: configuration.created_at().to_owned(),
            updated_at: configuration.updated_at().to_owned(),
        }
    }

    fn into_account(self) -> Result<ProviderAccount, ProviderAccountStoreFault> {
        let configuration =
            ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
                label: self.label,
                enabled: self.enabled,
                kind: self.kind.into(),
                endpoint: self
                    .endpoint
                    .map(ProviderEndpoint::try_new)
                    .transpose()
                    .map_err(|_| ProviderAccountStoreFault::Decode)?,
                protocol: self.protocol.map(Into::into),
                media_protocol: self.media_protocol.map(Into::into),
                auth_mode: self.auth_mode.into(),
                credential: self
                    .credential
                    .map(CredentialReference::try_new)
                    .transpose()
                    .map_err(|_| ProviderAccountStoreFault::Decode)?,
                created_at: self.created_at,
                updated_at: self.updated_at,
            })
            .map_err(|_| ProviderAccountStoreFault::Decode)?;
        Ok(ProviderAccount::new(
            ProviderAccountId::try_new(self.id).map_err(|_| ProviderAccountStoreFault::Decode)?,
            ProviderReference::try_new(self.provider)
                .map_err(|_| ProviderAccountStoreFault::Decode)?,
            ProviderAccountRevision::try_new(self.revision)
                .map_err(|_| ProviderAccountStoreFault::Decode)?,
            configuration,
        ))
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderAccountKindDocument {
    Chat,
    Media,
}

impl From<ProviderAccountKind> for ProviderAccountKindDocument {
    fn from(value: ProviderAccountKind) -> Self {
        match value {
            ProviderAccountKind::Chat => Self::Chat,
            ProviderAccountKind::Media => Self::Media,
        }
    }
}

impl From<ProviderAccountKindDocument> for ProviderAccountKind {
    fn from(value: ProviderAccountKindDocument) -> Self {
        match value {
            ProviderAccountKindDocument::Chat => Self::Chat,
            ProviderAccountKindDocument::Media => Self::Media,
        }
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderAccountAuthModeDocument {
    ApiKey,
    OAuthBrowser,
    OAuthDevice,
    Token,
    CliReuse,
    Local,
}

impl From<ProviderAccountAuthMode> for ProviderAccountAuthModeDocument {
    fn from(value: ProviderAccountAuthMode) -> Self {
        match value {
            ProviderAccountAuthMode::ApiKey => Self::ApiKey,
            ProviderAccountAuthMode::OAuthBrowser => Self::OAuthBrowser,
            ProviderAccountAuthMode::OAuthDevice => Self::OAuthDevice,
            ProviderAccountAuthMode::Token => Self::Token,
            ProviderAccountAuthMode::CliReuse => Self::CliReuse,
            ProviderAccountAuthMode::Local => Self::Local,
        }
    }
}

impl From<ProviderAccountAuthModeDocument> for ProviderAccountAuthMode {
    fn from(value: ProviderAccountAuthModeDocument) -> Self {
        match value {
            ProviderAccountAuthModeDocument::ApiKey => Self::ApiKey,
            ProviderAccountAuthModeDocument::OAuthBrowser => Self::OAuthBrowser,
            ProviderAccountAuthModeDocument::OAuthDevice => Self::OAuthDevice,
            ProviderAccountAuthModeDocument::Token => Self::Token,
            ProviderAccountAuthModeDocument::CliReuse => Self::CliReuse,
            ProviderAccountAuthModeDocument::Local => Self::Local,
        }
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderApiProtocolDocument {
    AnthropicMessages,
    GoogleGenerativeAi,
    OpenAiCompletions,
    OpenAiResponses,
}

impl From<ProviderApiProtocol> for ProviderApiProtocolDocument {
    fn from(value: ProviderApiProtocol) -> Self {
        match value {
            ProviderApiProtocol::AnthropicMessages => Self::AnthropicMessages,
            ProviderApiProtocol::GoogleGenerativeAi => Self::GoogleGenerativeAi,
            ProviderApiProtocol::OpenAiCompletions => Self::OpenAiCompletions,
            ProviderApiProtocol::OpenAiResponses => Self::OpenAiResponses,
        }
    }
}

impl From<ProviderApiProtocolDocument> for ProviderApiProtocol {
    fn from(value: ProviderApiProtocolDocument) -> Self {
        match value {
            ProviderApiProtocolDocument::AnthropicMessages => Self::AnthropicMessages,
            ProviderApiProtocolDocument::GoogleGenerativeAi => Self::GoogleGenerativeAi,
            ProviderApiProtocolDocument::OpenAiCompletions => Self::OpenAiCompletions,
            ProviderApiProtocolDocument::OpenAiResponses => Self::OpenAiResponses,
        }
    }
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
enum ProviderMediaApiProtocolDocument {
    Google,
    OpenAi,
    OpenRouter,
}

impl From<ProviderMediaApiProtocol> for ProviderMediaApiProtocolDocument {
    fn from(value: ProviderMediaApiProtocol) -> Self {
        match value {
            ProviderMediaApiProtocol::Google => Self::Google,
            ProviderMediaApiProtocol::OpenAi => Self::OpenAi,
            ProviderMediaApiProtocol::OpenRouter => Self::OpenRouter,
        }
    }
}

impl From<ProviderMediaApiProtocolDocument> for ProviderMediaApiProtocol {
    fn from(value: ProviderMediaApiProtocolDocument) -> Self {
        match value {
            ProviderMediaApiProtocolDocument::Google => Self::Google,
            ProviderMediaApiProtocolDocument::OpenAi => Self::OpenAi,
            ProviderMediaApiProtocolDocument::OpenRouter => Self::OpenRouter,
        }
    }
}

fn recover(path: &Path) -> Result<Vec<ProviderAccount>, ProviderAccountStoreFault> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() <= MAX_STORE_BYTES as usize => {
            serde_json::from_slice::<ProviderAccountStoreDocument>(&bytes)
                .map_err(|_| ProviderAccountStoreFault::Decode)?
                .into_accounts()
        }
        Ok(_) => Err(ProviderAccountStoreFault::RecordTooLarge),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(ProviderAccountStoreFault::Commit(error.kind())),
    }
}

pub(crate) fn migration_bytes(
    accounts: &[ProviderAccount],
) -> Result<Vec<u8>, ProviderAccountStoreFault> {
    let bytes = serde_json::to_vec(&ProviderAccountStoreDocument::from_accounts(accounts))
        .map_err(|_| ProviderAccountStoreFault::Encode)?;
    if bytes.len() > MAX_STORE_BYTES as usize {
        return Err(ProviderAccountStoreFault::RecordTooLarge);
    }
    Ok(bytes)
}

fn ensure_parent_directory(path: &Path) -> Result<(), ProviderAccountStoreFault> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent)
            .map_err(|error| ProviderAccountStoreFault::Commit(error.kind()))?;
    }
    Ok(())
}

fn lock_path(path: &Path) -> PathBuf {
    let mut lock = path.as_os_str().to_owned();
    lock.push(".lock");
    lock.into()
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".next");
    temporary.into()
}

fn remove_stale_temporary(path: &Path) -> Result<(), ProviderAccountStoreFault> {
    match fs::remove_file(temporary_path(path)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(ProviderAccountStoreFault::Commit(error.kind())),
    }
}

struct WriterLock {
    path: PathBuf,
}

impl WriterLock {
    fn acquire(path: &Path) -> Result<Self, ProviderAccountStoreFault> {
        match File::create_new(path) {
            Ok(file) => {
                drop(file);
                Ok(Self {
                    path: path.to_owned(),
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(ProviderAccountStoreFault::WriterBusy)
            }
            Err(error) => Err(ProviderAccountStoreFault::Commit(error.kind())),
        }
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
#[path = "provider_account_store_tests.rs"]
mod tests;
