use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
};

use crate::{
    ProviderAccount, ProviderAccountId, ProviderAccountRevision, ProviderAccountStore,
    ProviderModelCatalog, ProviderModelStore, ProviderRoute, ProviderRouting,
    ProviderRoutingRevision, ProviderRoutingStore,
};

/// Coordinates the durable desired facts affected by an account removal.
///
/// The individual account, model, and routing stores deliberately remain their own read models.
/// This journal is the single recovery authority for their cross-file removal transaction. It
/// contains only opaque identifiers and desired-fact preconditions; private auth material and
/// projection/observed receipts never enter it.
pub struct ProviderCascade {
    accounts: ProviderAccountStore,
    models: ProviderModelStore,
    routing: ProviderRoutingStore,
    journal: ProviderCascadeJournal,
}

impl ProviderCascade {
    pub fn open(
        accounts_path: impl Into<PathBuf>,
        models_path: impl Into<PathBuf>,
        routing_path: impl Into<PathBuf>,
        journal_path: impl Into<PathBuf>,
    ) -> Result<Self, ProviderCascadeFault> {
        let mut cascade = Self {
            accounts: ProviderAccountStore::open(accounts_path)
                .map_err(|_| ProviderCascadeFault::Open)?,
            models: ProviderModelStore::open(models_path)
                .map_err(|_| ProviderCascadeFault::Open)?,
            routing: ProviderRoutingStore::open(routing_path)
                .map_err(|_| ProviderCascadeFault::Open)?,
            journal: ProviderCascadeJournal::open(journal_path.into())?,
        };
        cascade.recover()?;
        Ok(cascade)
    }

    pub fn accounts(&self) -> &[ProviderAccount] {
        self.accounts.accounts()
    }

    pub fn account(&self, id: &ProviderAccountId) -> Option<&ProviderAccount> {
        self.accounts.account(id)
    }

    pub fn catalog(&self) -> &ProviderModelCatalog {
        self.models.catalog()
    }

    pub fn routing(&self) -> Option<&ProviderRouting> {
        self.routing.routing()
    }

    pub fn reload(&mut self) -> Result<(), ProviderCascadeFault> {
        self.accounts
            .reload()
            .map_err(|_| ProviderCascadeFault::Open)?;
        self.models
            .reload()
            .map_err(|_| ProviderCascadeFault::Open)?;
        self.routing
            .reload()
            .map_err(|_| ProviderCascadeFault::Open)?;
        self.recover()
    }

    pub fn persist_account(
        &mut self,
        account: ProviderAccount,
    ) -> Result<&ProviderAccount, ProviderCascadeFault> {
        self.accounts
            .persist(account)
            .map_err(|_| ProviderCascadeFault::Open)
    }

    pub fn delete_account_only(
        &mut self,
        id: &ProviderAccountId,
        revision: ProviderAccountRevision,
    ) -> Result<(), ProviderCascadeFault> {
        self.accounts
            .delete(id, revision)
            .map_err(|_| ProviderCascadeFault::Apply)
    }

    /// Deletes all desired facts owned by an account identity as one recoverable operation.
    ///
    /// A caller must surface every failure as unknown. Retrying is only safe after a fresh open,
    /// where `recover` has resolved the durable journal before accepting another mutation.
    pub fn delete_account(
        &mut self,
        id: &ProviderAccountId,
        revision: ProviderAccountRevision,
    ) -> Result<(), ProviderCascadeFault> {
        let routing_revision = self.routing.routing().and_then(|current| {
            routing_references(current, id).then_some(current.revision().get())
        });
        let transaction = AccountDeletion {
            account_id: id.as_str().to_owned(),
            revision: revision.get(),
            routing_revision,
        };
        self.journal.prepare(&transaction)?;
        self.apply(&transaction)?;
        self.journal.clear()?;
        Ok(())
    }

    fn recover(&mut self) -> Result<(), ProviderCascadeFault> {
        let Some(transaction) = self.journal.pending()? else {
            return Ok(());
        };
        self.apply(&transaction)?;
        self.journal.clear()
    }

    fn apply(&mut self, transaction: &AccountDeletion) -> Result<(), ProviderCascadeFault> {
        let id = ProviderAccountId::try_new(transaction.account_id.clone())
            .map_err(|_| ProviderCascadeFault::Recovery)?;
        let revision = ProviderAccountRevision::try_new(transaction.revision)
            .map_err(|_| ProviderCascadeFault::Recovery)?;
        if self
            .models
            .catalog()
            .models()
            .iter()
            .any(|model| model.account_id() == &id)
        {
            self.models
                .replace(&id, Vec::new())
                .map_err(|_| ProviderCascadeFault::Apply)?;
        }

        if let Some(expected_revision) = transaction.routing_revision {
            self.apply_routing(&id, expected_revision)?
        }

        match self.accounts.account(&id) {
            None => Ok(()),
            Some(account) if account.revision() == revision => self
                .accounts
                .delete(&id, revision)
                .map_err(|_| ProviderCascadeFault::Apply),
            Some(_) => Err(ProviderCascadeFault::Recovery),
        }
    }

    fn apply_routing(
        &mut self,
        account_id: &ProviderAccountId,
        expected_revision: u64,
    ) -> Result<(), ProviderCascadeFault> {
        let Some(current) = self.routing.routing().cloned() else {
            return Err(ProviderCascadeFault::Recovery);
        };
        let current_revision = current.revision().get();
        if current_revision == expected_revision {
            let next = prune_routing(&current, account_id).ok_or(ProviderCascadeFault::Recovery)?;
            self.routing
                .replace(next)
                .map_err(|_| ProviderCascadeFault::Apply)?;
            return Ok(());
        }
        if current_revision
            == expected_revision
                .checked_add(1)
                .ok_or(ProviderCascadeFault::Recovery)?
            && !routing_references(&current, account_id)
        {
            return Ok(());
        }
        Err(ProviderCascadeFault::Recovery)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderCascadeFault {
    Apply,
    Journal(io::ErrorKind),
    Open,
    Recovery,
    Unknown,
}

impl std::fmt::Display for ProviderCascadeFault {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Apply => "provider cascade could not be applied",
            Self::Journal(_) => "provider cascade journal could not be committed",
            Self::Open => "provider cascade facts could not be opened",
            Self::Recovery => "provider cascade requires manual recovery",
            Self::Unknown => "provider cascade outcome is unknown; reopen before retrying",
        })
    }
}

impl std::error::Error for ProviderCascadeFault {}

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct AccountDeletion {
    account_id: String,
    revision: u64,
    routing_revision: Option<u64>,
}

struct ProviderCascadeJournal {
    path: PathBuf,
    lock_path: PathBuf,
}

impl ProviderCascadeJournal {
    fn open(path: PathBuf) -> Result<Self, ProviderCascadeFault> {
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            fs::create_dir_all(parent)
                .map_err(|error| ProviderCascadeFault::Journal(error.kind()))?;
        }
        let journal = Self {
            lock_path: sibling_path(&path, ".lock"),
            path,
        };
        let _lock = JournalLock::acquire(&journal.lock_path)?;
        match fs::remove_file(sibling_path(&journal.path, ".next")) {
            Ok(()) => Ok(journal),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(journal),
            Err(error) => Err(ProviderCascadeFault::Journal(error.kind())),
        }
    }

    fn pending(&self) -> Result<Option<AccountDeletion>, ProviderCascadeFault> {
        let _lock = JournalLock::acquire(&self.lock_path)?;
        match fs::read(&self.path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| ProviderCascadeFault::Recovery),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(ProviderCascadeFault::Journal(error.kind())),
        }
    }

    fn prepare(&self, transaction: &AccountDeletion) -> Result<(), ProviderCascadeFault> {
        let bytes = serde_json::to_vec(transaction).map_err(|_| ProviderCascadeFault::Recovery)?;
        self.replace(&bytes)
    }

    fn clear(&self) -> Result<(), ProviderCascadeFault> {
        let _lock = JournalLock::acquire(&self.lock_path)?;
        match fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(ProviderCascadeFault::Unknown),
        }
    }

    fn replace(&self, bytes: &[u8]) -> Result<(), ProviderCascadeFault> {
        let _lock = JournalLock::acquire(&self.lock_path)?;
        let temporary = sibling_path(&self.path, ".next");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| ProviderCascadeFault::Journal(error.kind()))?;
        use std::io::Write;
        if let Err(error) = file.write_all(bytes) {
            let _ = fs::remove_file(&temporary);
            return Err(ProviderCascadeFault::Journal(error.kind()));
        }
        if let Err(_error) = file.sync_data() {
            let _ = fs::remove_file(&temporary);
            return Err(ProviderCascadeFault::Unknown);
        }
        drop(file);
        if let Err(_error) = fs::rename(&temporary, &self.path) {
            let _ = fs::remove_file(&temporary);
            return Err(ProviderCascadeFault::Unknown);
        }
        Ok(())
    }
}

struct JournalLock {
    path: PathBuf,
}

impl JournalLock {
    fn acquire(path: &Path) -> Result<Self, ProviderCascadeFault> {
        match File::create_new(path) {
            Ok(file) => {
                drop(file);
                Ok(Self {
                    path: path.to_owned(),
                })
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(ProviderCascadeFault::Journal(error.kind()))
            }
            Err(error) => Err(ProviderCascadeFault::Journal(error.kind())),
        }
    }
}

impl Drop for JournalLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn sibling_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    value.into()
}

fn routing_references(routing: &ProviderRouting, account_id: &ProviderAccountId) -> bool {
    routing.routes().iter().any(|(_, route)| {
        route.primary().account_id() == account_id
            || route
                .fallbacks()
                .iter()
                .any(|reference| reference.account_id() == account_id)
    })
}

fn prune_routing(
    current: &ProviderRouting,
    account_id: &ProviderAccountId,
) -> Option<ProviderRouting> {
    let routes = current
        .routes()
        .iter()
        .filter_map(|(capability, route)| {
            if route.primary().account_id() == account_id {
                return None;
            }
            let fallbacks = route
                .fallbacks()
                .iter()
                .filter(|reference| reference.account_id() != account_id)
                .cloned()
                .collect();
            ProviderRoute::try_new(route.primary().clone(), fallbacks, route.timeout_ms())
                .ok()
                .map(|route| (*capability, route))
        })
        .collect();
    ProviderRouting::try_new(
        ProviderRoutingRevision::try_new(current.revision().get().checked_add(1)?).ok()?,
        routes,
    )
    .ok()
}

#[cfg(test)]
#[path = "provider_cascade_tests.rs"]
mod tests;
