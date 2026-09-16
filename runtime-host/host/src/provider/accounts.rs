use std::collections::{BTreeMap, BTreeSet};

use crate::provider::{
    account_draft::ProviderAccountDraft,
    auth::Resolver,
    native::ProviderNativeConfigurationView,
    runtime_identity::{
        ProviderRuntimeIdentity, provider_runtime_identities, provider_runtime_identity,
    },
};
use environment::{
    ProviderAccount, ProviderAccountAuthMode, ProviderAccountId, ProviderAccountKind,
    ProviderAccountRevision, ProviderApiProtocol, ProviderCascade, ProviderMediaApiProtocol,
    provider_routing_account_ids,
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderAccountView {
    pub(crate) id: String,
    pub(crate) provider: String,
    pub(crate) label: String,
    pub(crate) enabled: bool,
    pub(crate) kind: &'static str,
    pub(crate) endpoint: Option<String>,
    pub(crate) protocol: Option<&'static str>,
    pub(crate) media_protocol: Option<&'static str>,
    pub(crate) auth_mode: &'static str,
    pub(crate) revision: u64,
}

impl ProviderAccountView {
    pub(crate) fn from_account(account: &ProviderAccount) -> Self {
        let configuration = account.configuration();
        Self {
            id: account.id().as_str().to_owned(),
            provider: account
                .provider()
                .as_str()
                .strip_prefix("provider:")
                .expect("ProviderAccount provider references are canonical")
                .to_owned(),
            label: configuration.label().to_owned(),
            enabled: configuration.enabled(),
            kind: provider_account_kind_name(configuration.kind()),
            endpoint: configuration
                .endpoint()
                .map(|endpoint| endpoint.as_str().to_owned()),
            protocol: configuration.protocol().map(provider_api_protocol_name),
            media_protocol: configuration
                .media_protocol()
                .map(provider_media_api_protocol_name),
            auth_mode: provider_account_auth_mode_name(configuration.auth_mode()),
            revision: account.revision().get(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum ProviderAccountsDesiredOutcome {
    Stored,
    Deleted,
    Rejected,
    Unknown,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ProviderAccountsDelivery {
    List(Vec<ProviderAccountView>),
    Account(ProviderAccountView),
    Stored {
        account: ProviderAccountView,
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
        commit: ProviderCommitOutcome,
    },
    Deleted {
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
        commit: ProviderCommitOutcome,
    },
    Rejected,
    Missing,
    Unknown {
        desired: ProviderAccountMutationKind,
        persisted: ProviderPersistedOutcome,
        native: ProviderNativeConfigurationView,
        commit: ProviderCommitOutcome,
    },
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

    pub(super) fn replace(
        &mut self,
        cascade: &mut ProviderCascade,
        draft: ProviderAccountDraft,
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
        let Ok(account) = draft.materialize(existing.as_ref(), current_timestamp()) else {
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
                                    .map_err(PrivateProfileProjectionError::resolver)
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
                    let identities = provider_runtime_identities(cascade.accounts())
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
                                        .map_err(PrivateProfileProjectionError::resolver)
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
            .map(provider_routing_account_ids)
            .unwrap_or_default();
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

    pub(super) fn apply_private_profiles_for_provider_config(
        &self,
        accounts: &[ProviderAccount],
        required_account_ids: &BTreeSet<ProviderAccountId>,
    ) -> Result<bool, PrivateProfileProjectionError> {
        if required_account_ids.is_empty() {
            return Ok(false);
        }
        let identities = provider_runtime_identities(accounts)
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
        identities: &BTreeMap<String, ProviderRuntimeIdentity>,
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
                    .map_err(PrivateProfileProjectionError::resolver)
            }
        }
    }
}

pub(super) enum PrivateProfileProjectionError {
    CredentialMissing,
    InvalidProviderKey,
    Resolver,
}

impl PrivateProfileProjectionError {
    fn resolver(_error: crate::provider::auth::ResolverFailure) -> Self {
        Self::Resolver
    }
}

fn credential_provider_name(account: &ProviderAccount) -> Option<&str> {
    account.provider().as_str().strip_prefix("provider:")
}

fn provider_account_kind_name(value: ProviderAccountKind) -> &'static str {
    match value {
        ProviderAccountKind::Chat => "chat",
        ProviderAccountKind::Media => "media",
    }
}

fn provider_api_protocol_name(value: ProviderApiProtocol) -> &'static str {
    match value {
        ProviderApiProtocol::AnthropicMessages => "anthropicMessages",
        ProviderApiProtocol::GoogleGenerativeAi => "googleGenerativeAi",
        ProviderApiProtocol::OpenAiCompletions => "openAiCompletions",
        ProviderApiProtocol::OpenAiResponses => "openAiResponses",
    }
}

fn provider_media_api_protocol_name(value: ProviderMediaApiProtocol) -> &'static str {
    match value {
        ProviderMediaApiProtocol::Google => "google",
        ProviderMediaApiProtocol::OpenAi => "openAi",
        ProviderMediaApiProtocol::OpenRouter => "openRouter",
    }
}

fn provider_account_auth_mode_name(value: ProviderAccountAuthMode) -> &'static str {
    match value {
        ProviderAccountAuthMode::ApiKey => "apiKey",
        ProviderAccountAuthMode::Token => "token",
        ProviderAccountAuthMode::CliReuse => "cliReuse",
        ProviderAccountAuthMode::OAuthBrowser => "oauthBrowser",
        ProviderAccountAuthMode::OAuthDevice => "oauthDevice",
        ProviderAccountAuthMode::Local => "local",
    }
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
    provider_runtime_identity(account)
        .map(|identity| identity.provider_key().to_owned())
        .map_err(|_| ())
}

fn private_profile_provider_key<'a>(
    identities: &'a BTreeMap<String, ProviderRuntimeIdentity>,
    account: &ProviderAccount,
) -> Result<&'a str, ()> {
    identities
        .get(account.id().as_str())
        .map(ProviderRuntimeIdentity::provider_key)
        .ok_or(())
}

fn current_timestamp() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("unix:{millis}")
}
