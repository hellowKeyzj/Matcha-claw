use std::{
    collections::{BTreeMap, BTreeSet},
    time::{SystemTime, UNIX_EPOCH},
};

use environment::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountId, ProviderAccountRevision,
    ProviderCascade, ProviderModelCatalog, ProviderRouting,
};
use openclaw::{
    port::ProviderNativeConfigurationEffect,
    projection::provider_models::{
        ProviderModelRuntimeIdentity, public_provider_model_identities,
        public_provider_model_identity,
    },
};
use serde_json::Value;

use crate::{
    composition::Host,
    transport::provider_accounts::{
        AccountDraft, ProviderAccountsDelivery, private_auth::{Resolver, ResolverFailure},
    },
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderCommitOutcome {
    Committed,
    CommitOutcomeUnknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderPersistedOutcome {
    Confirmed,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ProviderAccountMutationKind {
    Stored,
    Deleted,
}

pub(crate) struct ProviderAccountsOwner {
    cascade: ProviderCascade,
    private_resolver: Resolver,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderAccountsDesiredOutcome {
    Stored,
    Deleted,
    Rejected,
    Unknown,
    Unavailable,
}

struct ProviderAccountsMutation {
    desired: ProviderAccountsDesiredOutcome,
    kind: Option<ProviderAccountMutationKind>,
    account: Option<Value>,
    retired: Vec<ProviderAccount>,
    persisted: ProviderPersistedOutcome,
    commit: ProviderCommitOutcome,
    private: Result<(), PrivateProfileProjectionError>,
}

impl ProviderAccountsMutation {
    const fn completed(desired: ProviderAccountsDesiredOutcome) -> Self {
        Self {
            desired,
            kind: None,
            account: None,
            retired: Vec::new(),
            persisted: ProviderPersistedOutcome::Unknown,
            commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            private: Ok(()),
        }
    }

    fn unknown(kind: ProviderAccountMutationKind) -> Self {
        Self {
            desired: ProviderAccountsDesiredOutcome::Unknown,
            kind: Some(kind),
            account: None,
            retired: Vec::new(),
            persisted: ProviderPersistedOutcome::Unknown,
            commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            private: Ok(()),
        }
    }

    fn required_auth_accounts(&self) -> BTreeSet<ProviderAccountId> {
        self.account
            .as_ref()
            .and_then(|account| account.get("id"))
            .and_then(Value::as_str)
            .and_then(|id| ProviderAccountId::try_new(id.to_owned()).ok())
            .into_iter()
            .collect()
    }
}

impl ProviderAccountsOwner {
    pub(crate) fn new(cascade: ProviderCascade, private_resolver: Resolver) -> Self {
        Self {
            cascade,
            private_resolver,
        }
    }

    pub(crate) fn set_private_resolver(&mut self, private_resolver: Resolver) {
        self.private_resolver = private_resolver;
    }

    pub(crate) fn accounts(&self) -> &[ProviderAccount] {
        self.cascade.accounts()
    }

    pub(crate) fn catalog(&self) -> &ProviderModelCatalog {
        self.cascade.catalog()
    }

    pub(crate) fn routing(&self) -> Option<&ProviderRouting> {
        self.cascade.routing()
    }

    pub(crate) fn list(&mut self) -> ProviderAccountsDelivery {
        if self.reload_all().is_err() {
            return ProviderAccountsDelivery::Unavailable;
        }
        ProviderAccountsDelivery::List(self.cascade.accounts().iter().map(account_json).collect())
    }

    pub(crate) fn get(&mut self, id: ProviderAccountId) -> ProviderAccountsDelivery {
        if self.reload_all().is_err() {
            return ProviderAccountsDelivery::Unavailable;
        }
        self.cascade
            .account(&id)
            .map(account_json)
            .map(ProviderAccountsDelivery::Account)
            .unwrap_or(ProviderAccountsDelivery::Missing)
    }

    fn replace(&mut self, draft: AccountDraft) -> ProviderAccountsMutation {
        if self.reload_all().is_err() {
            return ProviderAccountsMutation::completed(
                ProviderAccountsDesiredOutcome::Unavailable,
            );
        }
        let existing = self.cascade.account_for_draft(&draft).cloned();
        if existing.as_ref().is_some_and(|current| {
            current.revision().get() == draft.revision()
                && !crate::transport::provider_accounts::same_public_facts_for_owner(
                    current, &draft,
                )
        }) {
            return ProviderAccountsMutation::completed(ProviderAccountsDesiredOutcome::Rejected);
        }
        let Some(account) =
            crate::transport::provider_accounts::materialize_for_owner(&draft, existing.as_ref())
        else {
            return ProviderAccountsMutation::completed(ProviderAccountsDesiredOutcome::Rejected);
        };
        if self.cascade.persist_account(account.clone()).is_err() {
            return ProviderAccountsMutation::unknown(ProviderAccountMutationKind::Stored);
        }
        let private = match account.configuration().auth_mode() {
            ProviderAccountAuthMode::Local => existing
                .as_ref()
                .and_then(|previous| {
                    previous
                        .configuration()
                        .credential()
                        .map(|reference| (previous, reference))
                })
                .map(|(previous, reference)| {
                    private_profile_provider_key_for_account(previous)
                        .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey)
                        .and_then(|profile_provider| {
                            self.private_resolver.discard(
                                reference.as_str(),
                                profile_provider.as_str(),
                                account.revision().get(),
                            )
                            .map_err(PrivateProfileProjectionError::Resolver)
                        })
                })
                .unwrap_or(Ok(())),
            ProviderAccountAuthMode::ApiKey
            | ProviderAccountAuthMode::OAuthBrowser
            | ProviderAccountAuthMode::OAuthDevice => {
                if account.configuration().enabled() {
                    let identities = public_provider_model_identities(self.cascade.accounts())
                        .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey);
                    identities
                        .and_then(|identities| self.apply_private_profile(&identities, &account))
                } else {
                    account
                        .configuration()
                        .credential()
                        .map(|reference| {
                            private_profile_provider_key_for_account(&account)
                                .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey)
                                .and_then(|profile_provider| {
                                    self.private_resolver
                                        .discard(
                                            reference.as_str(),
                                            profile_provider.as_str(),
                                            account.revision().get(),
                                        )
                                        .map_err(PrivateProfileProjectionError::Resolver)
                                })
                        })
                        .unwrap_or(Ok(()))
                }
            }
        };
        let retired = (!account.configuration().enabled())
            .then_some(account.clone())
            .into_iter()
            .collect::<Vec<_>>();
        let account = self.cascade.account(account.id()).map(account_json);
        ProviderAccountsMutation {
            desired: account
                .as_ref()
                .map(|_| ProviderAccountsDesiredOutcome::Stored)
                .unwrap_or(ProviderAccountsDesiredOutcome::Unavailable),
            kind: Some(ProviderAccountMutationKind::Stored),
            account,
            retired,
            persisted: ProviderPersistedOutcome::Confirmed,
            commit: ProviderCommitOutcome::Committed,
            private,
        }
    }

    fn delete(
        &mut self,
        id: ProviderAccountId,
        revision: ProviderAccountRevision,
    ) -> ProviderAccountsMutation {
        if self.reload_all().is_err() {
            return ProviderAccountsMutation::completed(
                ProviderAccountsDesiredOutcome::Unavailable,
            );
        }
        let Some(account) = self.cascade.account(&id).cloned() else {
            return ProviderAccountsMutation::unknown(ProviderAccountMutationKind::Deleted);
        };
        if account.revision() != revision {
            return ProviderAccountsMutation::completed(ProviderAccountsDesiredOutcome::Rejected);
        }
        if self.cascade.delete_account(&id, revision).is_err() {
            return ProviderAccountsMutation::unknown(ProviderAccountMutationKind::Deleted);
        }
        if let Some(credential) = account.configuration().credential() {
            let Ok(profile_provider) = private_profile_provider_key_for_account(&account) else {
                return ProviderAccountsMutation::unknown(ProviderAccountMutationKind::Deleted);
            };
            if self
                .private_resolver
                .delete(
                    credential.as_str(),
                    profile_provider.as_str(),
                    revision.get(),
                )
                .is_err()
            {
                return ProviderAccountsMutation::unknown(ProviderAccountMutationKind::Deleted);
            }
        }
        ProviderAccountsMutation {
            desired: ProviderAccountsDesiredOutcome::Deleted,
            kind: Some(ProviderAccountMutationKind::Deleted),
            account: None,
            retired: vec![account],
            persisted: ProviderPersistedOutcome::Confirmed,
            commit: ProviderCommitOutcome::Committed,
            private: Ok(()),
        }
    }

    pub(crate) fn apply_private_profiles_for_provider_config(
        &self,
        accounts: &[ProviderAccount],
        required_account_ids: &BTreeSet<ProviderAccountId>,
    ) -> Result<(), PrivateProfileProjectionError> {
        if required_account_ids.is_empty() {
            return Ok(());
        }
        let identities = public_provider_model_identities(accounts).map_err(|_| PrivateProfileProjectionError::InvalidProviderKey)?;
        for account in accounts
            .iter()
            .filter(|account| required_account_ids.contains(account.id()))
            .filter(|account| account.configuration().enabled())
        {
            self.apply_private_profile(&identities, account)?;
        }
        Ok(())
    }

    fn apply_private_profile(
        &self,
        identities: &BTreeMap<String, ProviderModelRuntimeIdentity>,
        account: &ProviderAccount,
    ) -> Result<(), PrivateProfileProjectionError> {
        match account.configuration().auth_mode() {
            ProviderAccountAuthMode::Local => Ok(()),
            ProviderAccountAuthMode::ApiKey
            | ProviderAccountAuthMode::OAuthBrowser
            | ProviderAccountAuthMode::OAuthDevice => {
                let reference = account.configuration().credential().ok_or(PrivateProfileProjectionError::CredentialMissing)?;
                let credential_provider = credential_provider_name(account).ok_or(PrivateProfileProjectionError::InvalidProviderKey)?;
                let profile_provider = private_profile_provider_key(identities, account)
                    .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey)?;
                self.private_resolver.apply(
                    reference.as_str(),
                    profile_provider,
                    credential_provider,
                    account.configuration().auth_mode(),
                    account.revision().get(),
                )
                .map_err(PrivateProfileProjectionError::Resolver)
            }
        }
    }

    fn reload_all(&mut self) -> Result<(), ()> {
        self.cascade.reload().map_err(|_| ())
    }
}

impl Host {
    pub(crate) fn configure_provider_private_resolver(&mut self, private_resolver: Resolver) {
        self.provider_accounts
            .set_private_resolver(private_resolver.clone());
        self.provider_models
            .set_private_resolver(private_resolver.clone());
        self.external_connectors
            .set_private_resolver(private_resolver);
    }

    pub(crate) fn list_provider_accounts(&mut self) -> ProviderAccountsDelivery {
        if self.admission.admit_request().is_err() {
            return ProviderAccountsDelivery::Unavailable;
        }
        self.provider_accounts.list()
    }

    pub(crate) fn get_provider_account(
        &mut self,
        id: ProviderAccountId,
    ) -> ProviderAccountsDelivery {
        if self.admission.admit_request().is_err() {
            return ProviderAccountsDelivery::Unavailable;
        }
        self.provider_accounts.get(id)
    }

    pub(crate) async fn replace_provider_account(
        &mut self,
        draft: AccountDraft,
    ) -> ProviderAccountsDelivery {
        if self.admission.admit_request().is_err() {
            return ProviderAccountsDelivery::Unavailable;
        }
        let mutation = self.provider_accounts.replace(draft);
        self.apply_provider_accounts_mutation(mutation).await
    }

    pub(crate) async fn delete_provider_account(
        &mut self,
        id: ProviderAccountId,
        revision: ProviderAccountRevision,
    ) -> ProviderAccountsDelivery {
        if self.admission.admit_request().is_err() {
            return ProviderAccountsDelivery::Unavailable;
        }
        let mutation = self.provider_accounts.delete(id, revision);
        self.apply_provider_accounts_mutation(mutation).await
    }

    pub(crate) async fn reconcile_provider_native_configuration(
        &mut self,
        retired: &[ProviderAccount],
        required_auth_accounts: &BTreeSet<ProviderAccountId>,
    ) -> ProviderNativeConfigurationEffect {
        if self.provider_accounts.reload_all().is_err() {
            return self.provider_native_unavailable("provider-accounts-reload", "desired-store-reload-failed", None);
        }
        let accounts = self.provider_accounts.accounts().to_vec();
        if let Err(error) = self
            .provider_accounts
            .apply_private_profiles_for_provider_config(&accounts, required_auth_accounts)
        {
            return self.provider_native_unavailable(
                "private-auth-projection",
                "private-profiles-apply-failed",
                Some(error.diagnostic_detail()),
            );
        }
        let catalog = self.provider_accounts.catalog().clone();
        let routing = self.provider_accounts.routing().cloned();
        self.apply_provider_native_configurations(
            &accounts,
            &catalog,
            routing.as_ref(),
            retired,
            required_auth_accounts,
            now_millis(),
        )
        .await
    }

    async fn apply_provider_accounts_mutation(
        &mut self,
        mutation: ProviderAccountsMutation,
    ) -> ProviderAccountsDelivery {
        let native = if let Err(error) = &mutation.private {
            self.provider_native_unavailable(
                "private-auth-projection",
                "private-profiles-apply-failed",
                Some(error.diagnostic_detail()),
            )
        } else if mutation.commit == ProviderCommitOutcome::Committed {
            self.reconcile_provider_native_configuration(&mutation.retired, &mutation.required_auth_accounts())
                .await
        } else {
            ProviderNativeConfigurationEffect::Unavailable
        };
        match mutation.desired {
            ProviderAccountsDesiredOutcome::Stored => ProviderAccountsDelivery::Stored {
                account: mutation
                    .account
                    .expect("stored provider account must contain an account"),
                persisted: mutation.persisted,
                native,
                commit: mutation.commit,
            },
            ProviderAccountsDesiredOutcome::Deleted => ProviderAccountsDelivery::Deleted {
                persisted: mutation.persisted,
                native,
                commit: mutation.commit,
            },
            ProviderAccountsDesiredOutcome::Rejected => ProviderAccountsDelivery::Rejected,
            ProviderAccountsDesiredOutcome::Unknown => ProviderAccountsDelivery::Unknown {
                desired: mutation
                    .kind
                    .expect("unknown provider account mutation must have a kind"),
                persisted: mutation.persisted,
                native,
                commit: mutation.commit,
            },
            ProviderAccountsDesiredOutcome::Unavailable => ProviderAccountsDelivery::Unavailable,
        }
    }
}

enum PrivateProfileProjectionError {
    CredentialMissing,
    InvalidProviderKey,
    Resolver(ResolverFailure),
}

impl PrivateProfileProjectionError {
    fn diagnostic_detail(&self) -> String {
        match self {
            Self::CredentialMissing => "credential-missing".to_owned(),
            Self::InvalidProviderKey => "invalid-provider-key".to_owned(),
            Self::Resolver(error) => format!("{}{}", error.reason(), error.status().map(|status| format!(" status={status}")).unwrap_or_default()),
        }
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or(u64::MAX)
}

fn account_json(account: &ProviderAccount) -> Value {
    crate::transport::provider_accounts::account_json_for_owner(account)
}

fn credential_provider_name(account: &ProviderAccount) -> Option<&str> {
    account.provider().as_str().strip_prefix("provider:")
}

fn private_profile_provider_key_for_account(account: &ProviderAccount) -> Result<String, ()> {
    public_provider_model_identity(account)
        .map(|identity| identity.provider_key().to_owned())
        .map_err(|_| ())
}

fn private_profile_provider_key<'a>(
    identities: &'a BTreeMap<String, ProviderModelRuntimeIdentity>,
    account: &ProviderAccount,
) -> Result<&'a str, ()> {
    identities
        .get(account.id().as_str())
        .map(ProviderModelRuntimeIdentity::provider_key)
        .ok_or(())
}

trait AccountDraftLookup {
    fn account_for_draft(&self, draft: &AccountDraft) -> Option<&ProviderAccount>;
}

impl AccountDraftLookup for ProviderCascade {
    fn account_for_draft(&self, draft: &AccountDraft) -> Option<&ProviderAccount> {
        crate::transport::provider_accounts::account_id_for_owner(draft)
            .ok()
            .and_then(|id| self.account(&id))
    }
}
