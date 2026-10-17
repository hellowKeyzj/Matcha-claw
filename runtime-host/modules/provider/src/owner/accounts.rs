use std::collections::{BTreeMap, BTreeSet};

use tokio::time::Instant;

use crate::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountId, ProviderAccountRevision,
    ProviderCascade, Resolver,
    application::ProviderAccountDraft,
    application::receipts::{
        ProviderAccountMutationKind, ProviderCommitOutcome, ProviderPersistedOutcome,
    },
    ports::ProviderRuntimeIdentityOps,
    provider_routing_account_ids,
};

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
    pub(super) account: Option<ProviderAccount>,
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

    pub(super) fn private_resolver(&self) -> &Resolver {
        &self.private_resolver
    }

    pub(super) async fn begin_transaction(
        &self,
        account_id: ProviderAccountId,
        revision: u64,
        kind: &str,
        credential_required: bool,
    ) -> Result<Option<crate::api::ProviderAccountPrivateTransaction>, crate::ResolverFailure> {
        Ok(self.private_resolver.begin_account_transaction(
            account_id.as_str(), revision, kind, credential_required,
        ).await?.map(|id| crate::api::ProviderAccountPrivateTransaction {
            id,
            reference: format!("credential:v1:{}", account_id.as_str()),
            revision,
            account_id,
        }))
    }

    pub(super) async fn claim_transaction(
        &self,
        transaction: &crate::api::ProviderAccountPrivateTransaction,
        previous_reference: Option<&str>,
    ) -> Result<(), crate::ResolverFailure> {
        self.private_resolver.claim_account_transaction(
            &transaction.id,
            &transaction.reference,
            transaction.revision,
            previous_reference,
        ).await
    }

    pub(super) async fn settle_transaction(
        &self,
        transaction: &crate::api::ProviderAccountPrivateTransaction,
        settlement: &str,
        committed: bool,
    ) -> Result<(), crate::ResolverFailure> {
        self.private_resolver.settle_account_transaction(
            &transaction.id,
            &transaction.reference,
            transaction.revision,
            settlement,
            committed,
        ).await
    }

    pub(super) async fn replace(
        &mut self,
        cascade: &mut ProviderCascade,
        identity_ops: &dyn ProviderRuntimeIdentityOps,
        draft: ProviderAccountDraft,
        transaction: Option<&crate::api::ProviderAccountPrivateTransaction>,
    ) -> ProviderAccountsMutation {
        if cascade.reload().is_err() {
            return ProviderAccountsMutation::completed(
                ProviderAccountsDesiredOutcome::Unavailable,
            );
        }
        let existing = match draft.existing_account(cascade.accounts()) {
            Ok(existing) => existing.cloned(),
            Err(_) => {
                return ProviderAccountsMutation::completed(
                    ProviderAccountsDesiredOutcome::Rejected,
                );
            }
        };
        if existing.as_ref().is_some_and(|current| {
            current.revision().get() == draft.revision_value() && !draft.same_public_facts(current)
        }) {
            return ProviderAccountsMutation::completed(ProviderAccountsDesiredOutcome::Rejected);
        }
        let credential = transaction.map(|transaction| crate::CredentialReference::for_transaction(
            transaction.account_id.as_str(), &transaction.id,
        ));
        let Ok(account) = draft.materialize_with_credential(existing.as_ref(), current_timestamp(), credential) else {
            return ProviderAccountsMutation::completed(ProviderAccountsDesiredOutcome::Rejected);
        };
        let previous_provider_key = existing
            .as_ref()
            .filter(|previous| previous.configuration().enabled())
            .and_then(|previous| {
                provider_key_for_account(identity_ops, cascade.accounts(), previous.id())
            });
        if cascade.persist_account(account.clone()).is_err() {
            return ProviderAccountsMutation::unknown(ProviderAccountMutationKind::Stored);
        }
        let retired = existing
            .as_ref()
            .filter(|previous| {
                account_replace_retires_existing_projection(
                    identity_ops,
                    previous,
                    &account,
                    previous_provider_key.as_deref(),
                    cascade.accounts(),
                )
            })
            .cloned()
            .into_iter()
            .collect::<Vec<_>>();
        let (private, auth_state_refresh_required) = match account.configuration().auth_mode() {
            ProviderAccountAuthMode::Local | ProviderAccountAuthMode::CliReuse => {
                let previous = existing.as_ref().and_then(|previous| {
                    previous
                        .configuration()
                        .credential()
                        .map(|reference| (previous, reference))
                });
                match previous {
                    Some((previous, reference)) => {
                        let private = match private_profile_provider_key_for_account(identity_ops, previous) {
                            Ok(profile_provider) => self.private_resolver
                                .discard(reference.as_str(), &profile_provider, account.revision().get(), account.id().as_str(), transaction.map(|transaction| transaction.id.as_str()))
                                .await
                                .map_err(PrivateProfileProjectionError::resolver),
                            Err(_) => Err(PrivateProfileProjectionError::InvalidProviderKey),
                        };
                        (private, true)
                    },
                    None => (Ok(()), false),
                }
            }
            ProviderAccountAuthMode::ApiKey
            | ProviderAccountAuthMode::Token
            | ProviderAccountAuthMode::OAuthBrowser
            | ProviderAccountAuthMode::OAuthDevice => {
                if account.configuration().enabled() {
                    let identities = provider_runtime_identities(identity_ops, cascade.accounts())
                        .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey);
                    let private = match identities {
                        Ok(identities) => self.apply_private_profile(identity_ops, &identities, &account, transaction.map(|transaction| transaction.id.as_str())).await,
                        Err(error) => Err(error),
                    };
                    (private, true)
                } else {
                    match account.configuration().credential() {
                        Some(reference) => {
                            let private = match private_profile_provider_key_for_account(identity_ops, &account) {
                                Ok(profile_provider) => self.private_resolver
                                    .discard(reference.as_str(), &profile_provider, account.revision().get(), account.id().as_str(), transaction.map(|transaction| transaction.id.as_str()))
                                    .await
                                    .map_err(PrivateProfileProjectionError::resolver),
                                Err(_) => Err(PrivateProfileProjectionError::InvalidProviderKey),
                            };
                            (private, true)
                        },
                        None => (Ok(()), false),
                    }
                }
            }
        };
        let required_auth_accounts =
            required_auth_accounts_after_account_replace(cascade, &account);
        let account = cascade.account(account.id()).cloned();
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

    pub(super) async fn delete(
        &mut self,
        cascade: &mut ProviderCascade,
        identity_ops: &dyn ProviderRuntimeIdentityOps,
        id: ProviderAccountId,
        revision: ProviderAccountRevision,
        transaction: Option<&crate::api::ProviderAccountPrivateTransaction>,
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
        let private = match account.configuration().credential() {
            Some(credential) => match private_profile_provider_key_for_account(identity_ops, &account) {
                Ok(profile_provider) => self.private_resolver
                    .delete(credential.as_str(), &profile_provider, revision.get(), account.id().as_str(), transaction.map(|transaction| transaction.id.as_str()))
                    .await
                    .map_err(PrivateProfileProjectionError::resolver),
                Err(_) => Err(PrivateProfileProjectionError::InvalidProviderKey),
            },
            None => Ok(()),
        };
        let required_auth_accounts = cascade
            .routing()
            .map(provider_routing_account_ids)
            .unwrap_or_default();
        let auth_state_refresh_required = account_has_private_auth_profile(&account);
        ProviderAccountsMutation {
            desired: if private.is_err() {
                ProviderAccountsDesiredOutcome::Unknown
            } else {
                ProviderAccountsDesiredOutcome::Deleted
            },
            kind: Some(ProviderAccountMutationKind::Deleted),
            account: None,
            retired: vec![account],
            required_auth_accounts,
            persisted: ProviderPersistedOutcome::Confirmed,
            commit: ProviderCommitOutcome::Committed,
            private,
            auth_state_refresh_required,
        }
    }

    pub(super) async fn apply_private_profiles_for_provider_config(
        &self,
        identity_ops: &dyn ProviderRuntimeIdentityOps,
        accounts: &[ProviderAccount],
        required_account_ids: &BTreeSet<ProviderAccountId>,
        deadline: Instant,
    ) -> Result<bool, PrivateProfileProjectionError> {
        if required_account_ids.is_empty() {
            return Ok(false);
        }
        let identities = provider_runtime_identities(identity_ops, accounts)
            .map_err(|_| PrivateProfileProjectionError::InvalidProviderKey)?;
        let mut applied = false;
        for account in accounts
            .iter()
            .filter(|account| required_account_ids.contains(account.id()))
            .filter(|account| account.configuration().enabled())
            .filter(|account| account_uses_private_auth_mode(account))
        {
            tokio::time::timeout_at(
                deadline,
                self.apply_private_profile(identity_ops, &identities, account, None),
            )
            .await
            .map_err(|_| PrivateProfileProjectionError::Deadline)??;
            applied = true;
        }
        Ok(applied)
    }

    async fn apply_private_profile(
        &self,
        _identity_ops: &dyn ProviderRuntimeIdentityOps,
        identities: &BTreeMap<String, String>,
        account: &ProviderAccount,
        transaction_id: Option<&str>,
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
                        account.id().as_str(),
                        transaction_id,
                    )
                    .await
                    .map_err(PrivateProfileProjectionError::resolver)
            }
        }
    }
}

pub(super) enum PrivateProfileProjectionError {
    Deadline,
    CredentialMissing,
    InvalidProviderKey,
    Resolver(crate::ResolverFailure),
}

impl PrivateProfileProjectionError {
    fn resolver(error: crate::ResolverFailure) -> Self {
        Self::Resolver(error)
    }

    pub(super) fn diagnostic(
        &self,
    ) -> (
        crate::call::ProviderCallDiagnosticReason,
        Option<crate::call::ProviderCallPrivateResolverCode>,
    ) {
        use crate::call::ProviderCallDiagnosticReason as Reason;
        match self {
            Self::Deadline => (Reason::PrivateProfileDeadline, None),
            Self::CredentialMissing => (Reason::PrivateProfileCredentialMissing, None),
            Self::InvalidProviderKey => (Reason::PrivateProfileInvalidProviderKey, None),
            Self::Resolver(error) => (Reason::PrivateResolverUnavailable, Some(error.safe_code())),
        }
    }
}

pub(super) fn provider_runtime_identities(
    identity_ops: &dyn ProviderRuntimeIdentityOps,
    accounts: &[ProviderAccount],
) -> Result<BTreeMap<String, String>, ()> {
    identity_ops.runtime_identities(accounts).map(|identities| {
        identities
            .into_iter()
            .map(|identity| {
                (
                    identity.account_id().to_owned(),
                    identity.provider_key().to_owned(),
                )
            })
            .collect()
    })
}

fn credential_provider_name(account: &ProviderAccount) -> Option<&str> {
    account.provider().as_str().strip_prefix("provider:")
}

fn required_auth_accounts_after_account_replace(
    cascade: &ProviderCascade,
    account: &ProviderAccount,
) -> BTreeSet<ProviderAccountId> {
    let mut required = cascade
        .routing()
        .map(provider_routing_account_ids)
        .unwrap_or_default();
    if account.configuration().enabled() && account_uses_private_auth_mode(account) {
        required.insert(account.id().clone());
    }
    required
}

fn account_replace_retires_existing_projection(
    identity_ops: &dyn ProviderRuntimeIdentityOps,
    previous: &ProviderAccount,
    account: &ProviderAccount,
    previous_provider_key: Option<&str>,
    accounts: &[ProviderAccount],
) -> bool {
    if !previous.configuration().enabled() {
        return false;
    }
    if !account.configuration().enabled() {
        return true;
    }
    if previous.configuration().kind() != account.configuration().kind() {
        return true;
    }
    provider_key_for_account(identity_ops, accounts, account.id()).as_deref()
        != previous_provider_key
}

fn provider_key_for_account(
    identity_ops: &dyn ProviderRuntimeIdentityOps,
    accounts: &[ProviderAccount],
    account_id: &ProviderAccountId,
) -> Option<String> {
    provider_runtime_identities(identity_ops, accounts)
        .ok()
        .and_then(|identities| identities.get(account_id.as_str()).cloned())
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

fn private_profile_provider_key_for_account(
    identity_ops: &dyn ProviderRuntimeIdentityOps,
    account: &ProviderAccount,
) -> Result<String, ()> {
    identity_ops
        .runtime_identity(account)
        .map(|identity| identity.provider_key().to_owned())
}

fn private_profile_provider_key<'a>(
    identities: &'a BTreeMap<String, String>,
    account: &ProviderAccount,
) -> Result<&'a str, ()> {
    identities
        .get(account.id().as_str())
        .map(String::as_str)
        .ok_or(())
}

fn current_timestamp() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix:{millis}")
}
