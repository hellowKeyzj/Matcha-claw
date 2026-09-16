use std::{collections::BTreeMap, path::Path, path::PathBuf};

use serde::Deserialize;

use crate::{
    CredentialReference, ProviderAccount, ProviderAccountAuthMode, ProviderAccountConfiguration,
    ProviderAccountConfigurationInput, ProviderAccountId, ProviderAccountKind,
    ProviderAccountRevision, ProviderApiProtocol, ProviderEndpoint, ProviderMediaApiProtocol,
    ProviderReference,
};

use super::{ProviderMigrationFault, legacy_source, write_atomic};

const LEGACY_VERSION: u8 = 2;

pub(super) fn migrate<Sources, Source>(
    path: &Path,
    sources: Sources,
) -> Result<(), ProviderMigrationFault>
where
    Sources: IntoIterator<Item = Source>,
    Source: Into<PathBuf>,
{
    let Some(legacy) = legacy_source::<_, _, LegacyAccounts>(sources, path)? else {
        return Ok(());
    };
    if legacy.schema_version != LEGACY_VERSION {
        return Err(ProviderMigrationFault::Decode);
    }
    let mut accounts = Vec::with_capacity(legacy.accounts.len());
    for (id, account) in legacy.accounts {
        accounts.push(account.into_account(id)?);
    }
    accounts.sort_by(|left, right| left.id().as_str().cmp(right.id().as_str()));
    let bytes = crate::provider::account_store::migration_bytes(&accounts)
        .map_err(|_| ProviderMigrationFault::Encode)?;
    write_atomic(path, &bytes)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAccounts {
    schema_version: u8,
    accounts: BTreeMap<String, LegacyAccount>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyAccount {
    id: Option<String>,
    vendor_id: Option<String>,
    label: Option<String>,
    auth_mode: Option<String>,
    enabled: Option<bool>,
    provider_kind: Option<String>,
    base_url: Option<String>,
    api_protocol: Option<String>,
    media_api_protocol: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

impl LegacyAccount {
    fn into_account(self, id: String) -> Result<ProviderAccount, ProviderMigrationFault> {
        let id = id.trim().to_owned();
        if id.is_empty() || self.id.filter(|value| !value.trim().is_empty()).is_none() {
            return Err(ProviderMigrationFault::Decode);
        }
        let vendor_id = self
            .vendor_id
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
            .ok_or(ProviderMigrationFault::Decode)?;
        let kind = match self.provider_kind.as_deref().unwrap_or("chat") {
            "chat" => ProviderAccountKind::Chat,
            "media" if vendor_id == "custom" => ProviderAccountKind::Media,
            "media" => ProviderAccountKind::Chat,
            _ => return Err(ProviderMigrationFault::Decode),
        };
        let auth_mode = match self.auth_mode.as_deref() {
            Some("api_key") => ProviderAccountAuthMode::ApiKey,
            Some("oauth_browser") => ProviderAccountAuthMode::OAuthBrowser,
            Some("oauth_device") => ProviderAccountAuthMode::OAuthDevice,
            Some("local") => ProviderAccountAuthMode::Local,
            _ => return Err(ProviderMigrationFault::Decode),
        };
        let protocol = (kind == ProviderAccountKind::Chat)
            .then(|| self.api_protocol.as_deref().map(api_protocol).transpose())
            .transpose()?
            .flatten();
        let media_protocol = (kind == ProviderAccountKind::Media)
            .then(|| {
                self.media_api_protocol
                    .as_deref()
                    .map(media_protocol)
                    .transpose()
            })
            .transpose()?
            .flatten();
        let credential = (auth_mode != ProviderAccountAuthMode::Local)
            .then(|| CredentialReference::try_new(format!("credential:v1:{id}")))
            .transpose()
            .map_err(|_| ProviderMigrationFault::Decode)?;
        let configuration =
            ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
                label: self.label.ok_or(ProviderMigrationFault::Decode)?,
                enabled: self.enabled.ok_or(ProviderMigrationFault::Decode)?,
                kind,
                endpoint: self
                    .base_url
                    .map(ProviderEndpoint::try_new)
                    .transpose()
                    .map_err(|_| ProviderMigrationFault::Decode)?,
                protocol,
                media_protocol,
                auth_mode,
                credential,
                created_at: self.created_at.ok_or(ProviderMigrationFault::Decode)?,
                updated_at: self.updated_at.ok_or(ProviderMigrationFault::Decode)?,
            })
            .map_err(|_| ProviderMigrationFault::Decode)?;
        Ok(ProviderAccount::new(
            ProviderAccountId::try_new(id).map_err(|_| ProviderMigrationFault::Decode)?,
            ProviderReference::try_new(format!("provider:{vendor_id}"))
                .map_err(|_| ProviderMigrationFault::Decode)?,
            ProviderAccountRevision::try_new(1).expect("one is valid"),
            configuration,
        ))
    }
}

fn api_protocol(value: &str) -> Result<ProviderApiProtocol, ProviderMigrationFault> {
    match value {
        "anthropic-messages" => Ok(ProviderApiProtocol::AnthropicMessages),
        "google-generative-ai" => Ok(ProviderApiProtocol::GoogleGenerativeAi),
        "openai-completions" | "openrouter" => Ok(ProviderApiProtocol::OpenAiCompletions),
        "openai-responses" => Ok(ProviderApiProtocol::OpenAiResponses),
        _ => Err(ProviderMigrationFault::Decode),
    }
}

fn media_protocol(value: &str) -> Result<ProviderMediaApiProtocol, ProviderMigrationFault> {
    match value {
        "google" => Ok(ProviderMediaApiProtocol::Google),
        "openai" => Ok(ProviderMediaApiProtocol::OpenAi),
        "openrouter" => Ok(ProviderMediaApiProtocol::OpenRouter),
        _ => Err(ProviderMigrationFault::Decode),
    }
}
