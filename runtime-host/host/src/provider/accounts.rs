use std::collections::{BTreeMap, BTreeSet};

use environment::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountId, ProviderAccountRevision,
    ProviderCascade,
};
use openclaw::projection::provider_models::{
    ProviderModelRuntimeIdentity, public_provider_model_identities, public_provider_model_identity,
};
use serde_json::Value;

use crate::transport::provider_accounts::{
    AccountDraft, ProviderAccountsDelivery,
    private_auth::{Resolver, ResolverFailure},
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
    private_resolver: Resolver,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProviderAccountsDesiredOutcome {
    Stored,
    Deleted,
    Rejected,
    Unknown,
    Unavailable,
}

pub(super) struct ProviderAccountsMutation {
    pub(super) desired: ProviderAccountsDesiredOutcome,
    pub(super) kind: Option<ProviderAccountMutationKind>,
    pub(super) account: Option<Value>,
    pub(super) retired: Vec<ProviderAccount>,
    pub(super) required_auth_accounts: BTreeSet<ProviderAccountId>,
    pub(super) persisted: ProviderPersistedOutcome,
    pub(super) commit: ProviderCommitOutcome,
    pub(super) private: Result<(), PrivateProfileProjectionError>,
    pub(super) auth_state_refresh_required: bool,
}

impl ProviderAccountsMutation {
    fn completed(desired: ProviderAccountsDesiredOutcome) -> Self {
        Self {
            desired,
            kind: None,
            account: None,
            retired: Vec::new(),
            required_auth_accounts: BTreeSet::new(),
            persisted: ProviderPersistedOutcome::Unknown,
            commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            private: Ok(()),
            auth_state_refresh_required: false,
        }
    }

    fn unknown(kind: ProviderAccountMutationKind) -> Self {
        Self {
            desired: ProviderAccountsDesiredOutcome::Unknown,
            kind: Some(kind),
            account: None,
            retired: Vec::new(),
            required_auth_accounts: BTreeSet::new(),
            persisted: ProviderPersistedOutcome::Unknown,
            commit: ProviderCommitOutcome::CommitOutcomeUnknown,
            private: Ok(()),
            auth_state_refresh_required: false,
        }
    }

    pub(super) fn required_auth_accounts(&self) -> &BTreeSet<ProviderAccountId> {
        &self.required_auth_accounts
    }
}

impl ProviderAccountsOwner {
    pub(crate) fn new(private_resolver: Resolver) -> Self {
        Self { private_resolver }
    }

    pub(crate) fn set_private_resolver(&mut self, private_resolver: Resolver) {
        self.private_resolver = private_resolver;
    }

    pub(crate) fn list(&mut self, cascade: &mut ProviderCascade) -> ProviderAccountsDelivery {
        if cascade.reload().is_err() {
            return ProviderAccountsDelivery::Unavailable;
        }
        ProviderAccountsDelivery::List(cascade.accounts().iter().map(account_json).collect())
    }

    pub(crate) fn get(
        &mut self,
        cascade: &mut ProviderCascade,
        id: ProviderAccountId,
    ) -> ProviderAccountsDelivery {
        if cascade.reload().is_err() {
            return ProviderAccountsDelivery::Unavailable;
        }
        cascade
            .account(&id)
            .map(account_json)
            .map(ProviderAccountsDelivery::Account)
            .unwrap_or(ProviderAccountsDelivery::Missing)
    }

    pub(super) fn replace(
        &mut self,
        cascade: &mut ProviderCascade,
        draft: AccountDraft,
    ) -> ProviderAccountsMutation {
        if cascade.reload().is_err() {
            return ProviderAccountsMutation::completed(
                ProviderAccountsDesiredOutcome::Unavailable,
            );
        }
        let existing = cascade.account_for_draft(&draft).cloned();
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
        if cascade.persist_account(account.clone()).is_err() {
            return ProviderAccountsMutation::unknown(ProviderAccountMutationKind::Stored);
        }
        let (private, auth_state_refresh_required) = match account.configuration().auth_mode() {
            ProviderAccountAuthMode::Local | ProviderAccountAuthMode::CliReuse => {
                let previous = existing.as_ref().and_then(|previous| {
                    previous
                        .configuration()
                        .credential()
                        .map(|reference| (previous, reference))
                });
                match previous {
                    Some((previous, reference)) => (
                        private_profile_provider_key_for_account(previous)
                            .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey)
                            .and_then(|profile_provider| {
                                self.private_resolver
                                    .discard(
                                        reference.as_str(),
                                        profile_provider.as_str(),
                                        account.revision().get(),
                                    )
                                    .map_err(PrivateProfileProjectionError::Resolver)
                            }),
                        true,
                    ),
                    None => (Ok(()), false),
                }
            }
            ProviderAccountAuthMode::ApiKey
            | ProviderAccountAuthMode::Token
            | ProviderAccountAuthMode::OAuthBrowser
            | ProviderAccountAuthMode::OAuthDevice => {
                if account.configuration().enabled() {
                    let identities = public_provider_model_identities(cascade.accounts())
                        .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey);
                    (
                        identities.and_then(|identities| {
                            self.apply_private_profile(&identities, &account)
                        }),
                        true,
                    )
                } else {
                    match account.configuration().credential() {
                        Some(reference) => (
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
                                }),
                            true,
                        ),
                        None => (Ok(()), false),
                    }
                }
            }
        };
        let retired = (!account.configuration().enabled())
            .then_some(account.clone())
            .into_iter()
            .collect::<Vec<_>>();
        let required_auth_accounts = BTreeSet::from([account.id().clone()]);
        let account = cascade.account(account.id()).map(account_json);
        ProviderAccountsMutation {
            desired: account
                .as_ref()
                .map(|_| ProviderAccountsDesiredOutcome::Stored)
                .unwrap_or(ProviderAccountsDesiredOutcome::Unavailable),
            kind: Some(ProviderAccountMutationKind::Stored),
            account,
            retired,
            required_auth_accounts,
            persisted: ProviderPersistedOutcome::Confirmed,
            commit: ProviderCommitOutcome::Committed,
            private,
            auth_state_refresh_required,
        }
    }

    pub(super) fn delete(
        &mut self,
        cascade: &mut ProviderCascade,
        id: ProviderAccountId,
        revision: ProviderAccountRevision,
    ) -> ProviderAccountsMutation {
        if cascade.reload().is_err() {
            return ProviderAccountsMutation::completed(
                ProviderAccountsDesiredOutcome::Unavailable,
            );
        }
        let Some(account) = cascade.account(&id).cloned() else {
            return ProviderAccountsMutation::unknown(ProviderAccountMutationKind::Deleted);
        };
        if account.revision() != revision {
            return ProviderAccountsMutation::completed(ProviderAccountsDesiredOutcome::Rejected);
        }
        if cascade.delete_account(&id, revision).is_err() {
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
        let required_auth_accounts = cascade
            .routing()
            .into_iter()
            .flat_map(|routing| routing.routes())
            .flat_map(|(_, route)| std::iter::once(route.primary()).chain(route.fallbacks()))
            .map(|reference| reference.account_id().clone())
            .collect();
        let auth_state_refresh_required = account_has_private_auth_profile(&account);
        ProviderAccountsMutation {
            desired: ProviderAccountsDesiredOutcome::Deleted,
            kind: Some(ProviderAccountMutationKind::Deleted),
            account: None,
            retired: vec![account],
            required_auth_accounts,
            persisted: ProviderPersistedOutcome::Confirmed,
            commit: ProviderCommitOutcome::Committed,
            private: Ok(()),
            auth_state_refresh_required,
        }
    }

    pub(crate) fn apply_private_profiles_for_provider_config(
        &self,
        accounts: &[ProviderAccount],
        required_account_ids: &BTreeSet<ProviderAccountId>,
    ) -> Result<bool, PrivateProfileProjectionError> {
        if required_account_ids.is_empty() {
            return Ok(false);
        }
        let identities = public_provider_model_identities(accounts)
            .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey)?;
        let mut applied = false;
        for account in accounts
            .iter()
            .filter(|account| required_account_ids.contains(account.id()))
            .filter(|account| account.configuration().enabled())
            .filter(|account| account_uses_private_auth_mode(account))
        {
            self.apply_private_profile(&identities, account)?;
            applied = true;
        }
        Ok(applied)
    }

    fn apply_private_profile(
        &self,
        identities: &BTreeMap<String, ProviderModelRuntimeIdentity>,
        account: &ProviderAccount,
    ) -> Result<(), PrivateProfileProjectionError> {
        match account.configuration().auth_mode() {
            ProviderAccountAuthMode::Local | ProviderAccountAuthMode::CliReuse => Ok(()),
            ProviderAccountAuthMode::ApiKey
            | ProviderAccountAuthMode::Token
            | ProviderAccountAuthMode::OAuthBrowser
            | ProviderAccountAuthMode::OAuthDevice => {
                let reference = account
                    .configuration()
                    .credential()
                    .ok_or(PrivateProfileProjectionError::CredentialMissing)?;
                let credential_provider = credential_provider_name(account)
                    .ok_or(PrivateProfileProjectionError::InvalidProviderKey)?;
                let profile_provider = private_profile_provider_key(identities, account)
                    .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey)?;
                self.private_resolver
                    .apply(
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
}

pub(super) enum PrivateProfileProjectionError {
    CredentialMissing,
    InvalidProviderKey,
    Resolver(ResolverFailure),
}

impl PrivateProfileProjectionError {
    pub(super) fn diagnostic_detail(&self) -> String {
        match self {
            Self::CredentialMissing => "credential-missing".to_owned(),
            Self::InvalidProviderKey => "invalid-provider-key".to_owned(),
            Self::Resolver(error) => format!(
                "{}{}",
                error.reason(),
                error
                    .status()
                    .map(|status| format!(" status={status}"))
                    .unwrap_or_default()
            ),
        }
    }
}

fn account_json(account: &ProviderAccount) -> Value {
    crate::transport::provider_accounts::account_json_for_owner(account)
}

fn credential_provider_name(account: &ProviderAccount) -> Option<&str> {
    account.provider().as_str().strip_prefix("provider:")
}

fn account_has_private_auth_profile(account: &ProviderAccount) -> bool {
    account_uses_private_auth_mode(account) && account.configuration().credential().is_some()
}

fn account_uses_private_auth_mode(account: &ProviderAccount) -> bool {
    matches!(
        account.configuration().auth_mode(),
        ProviderAccountAuthMode::ApiKey
            | ProviderAccountAuthMode::Token
            | ProviderAccountAuthMode::OAuthBrowser
            | ProviderAccountAuthMode::OAuthDevice
    )
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
