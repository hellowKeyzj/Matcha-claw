use environment::{
    CredentialReference, ProviderAccount, ProviderAccountAuthMode, ProviderAccountConfiguration,
    ProviderAccountConfigurationInput, ProviderAccountId, ProviderAccountKind,
    ProviderAccountRevision, ProviderApiProtocol, ProviderEndpoint, ProviderMediaApiProtocol,
    ProviderReference,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ProviderAccountDraft {
    id: String,
    provider: String,
    label: String,
    enabled: bool,
    kind: String,
    endpoint: Option<String>,
    protocol: Option<String>,
    media_protocol: Option<String>,
    auth_mode: String,
    revision: u64,
}

impl ProviderAccountDraft {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        id: impl Into<String>,
        provider: impl Into<String>,
        label: impl Into<String>,
        enabled: bool,
        kind: impl Into<String>,
        endpoint: Option<String>,
        protocol: Option<String>,
        media_protocol: Option<String>,
        auth_mode: impl Into<String>,
        revision: u64,
    ) -> Self {
        Self {
            id: id.into(),
            provider: provider.into(),
            label: label.into(),
            enabled,
            kind: kind.into(),
            endpoint,
            protocol,
            media_protocol,
            auth_mode: auth_mode.into(),
            revision,
        }
    }

    pub(crate) fn validate(&self) -> Result<(), InvalidProviderAccountDraft> {
        let auth_mode = self.account_auth_mode()?;
        let provider = provider_reference_value(&self.provider)?;
        self.account_id()?;
        ProviderReference::try_new(provider.clone()).map_err(|_| InvalidProviderAccountDraft)?;
        self.revision()?;
        match auth_mode {
            ProviderAccountAuthMode::CliReuse
                if provider != "provider:anthropic" || self.kind != "chat" =>
            {
                return Err(InvalidProviderAccountDraft);
            }
            ProviderAccountAuthMode::Token
                if !matches!(
                    provider.as_str(),
                    "provider:anthropic" | "provider:github-copilot"
                ) || self.kind != "chat" =>
            {
                return Err(InvalidProviderAccountDraft);
            }
            _ => {}
        }
        ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
            label: self.label.clone(),
            enabled: self.enabled,
            kind: self.account_kind()?,
            endpoint: self
                .endpoint
                .clone()
                .map(ProviderEndpoint::try_new)
                .transpose()
                .map_err(|_| InvalidProviderAccountDraft)?,
            protocol: self.api_protocol()?,
            media_protocol: self.media_api_protocol()?,
            auth_mode,
            credential: self.credential()?,
            created_at: "1970-01-01T00:00:00Z".to_owned(),
            updated_at: "1970-01-01T00:00:00Z".to_owned(),
        })
        .map_err(|_| InvalidProviderAccountDraft)?;
        Ok(())
    }

    pub(crate) fn existing_account<'a>(
        &self,
        accounts: &'a [ProviderAccount],
    ) -> Result<Option<&'a ProviderAccount>, InvalidProviderAccountDraft> {
        let id = self.account_id()?;
        Ok(accounts.iter().find(|account| account.id() == &id))
    }

    pub(crate) fn materialize(
        &self,
        existing: Option<&ProviderAccount>,
        updated_at: impl Into<String>,
    ) -> Result<ProviderAccount, InvalidProviderAccountDraft> {
        let updated_at = updated_at.into();
        let created_at = existing
            .map(|account| account.configuration().created_at().to_owned())
            .unwrap_or_else(|| updated_at.clone());
        let configuration =
            ProviderAccountConfiguration::try_new(ProviderAccountConfigurationInput {
                label: self.label.clone(),
                enabled: self.enabled,
                kind: self.account_kind()?,
                endpoint: self
                    .endpoint
                    .clone()
                    .map(ProviderEndpoint::try_new)
                    .transpose()
                    .map_err(|_| InvalidProviderAccountDraft)?,
                protocol: self.api_protocol()?,
                media_protocol: self.media_api_protocol()?,
                auth_mode: self.account_auth_mode()?,
                credential: self.credential()?,
                created_at,
                updated_at,
            })
            .map_err(|_| InvalidProviderAccountDraft)?;
        Ok(ProviderAccount::new(
            self.account_id()?,
            self.provider_reference()?,
            self.revision()?,
            configuration,
        ))
    }

    pub(crate) fn same_public_facts(&self, account: &ProviderAccount) -> bool {
        let configuration = account.configuration();
        self.provider_reference()
            .is_ok_and(|provider| account.provider() == &provider)
            && configuration.label() == self.label
            && configuration.enabled() == self.enabled
            && provider_account_kind_name(configuration.kind()) == self.kind
            && configuration.endpoint().map(ProviderEndpoint::as_str) == self.endpoint.as_deref()
            && configuration.protocol().map(provider_api_protocol_name) == self.protocol.as_deref()
            && configuration
                .media_protocol()
                .map(provider_media_api_protocol_name)
                == self.media_protocol.as_deref()
            && provider_account_auth_mode_name(configuration.auth_mode()) == self.auth_mode
            && configuration.credential().map(CredentialReference::as_str)
                == self
                    .credential()
                    .ok()
                    .flatten()
                    .as_ref()
                    .map(CredentialReference::as_str)
    }

    pub(crate) fn account_id(&self) -> Result<ProviderAccountId, InvalidProviderAccountDraft> {
        ProviderAccountId::try_new(self.id.clone()).map_err(|_| InvalidProviderAccountDraft)
    }

    pub(crate) fn revision(&self) -> Result<ProviderAccountRevision, InvalidProviderAccountDraft> {
        ProviderAccountRevision::try_new(self.revision).map_err(|_| InvalidProviderAccountDraft)
    }

    pub(crate) const fn revision_value(&self) -> u64 {
        self.revision
    }

    pub(crate) fn provider(&self) -> &str {
        &self.provider
    }

    pub(crate) fn auth_mode(&self) -> &str {
        &self.auth_mode
    }

    pub(crate) fn kind(&self) -> &str {
        &self.kind
    }

    pub(crate) const fn enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn has_endpoint(&self) -> bool {
        self.endpoint
            .as_ref()
            .is_some_and(|value| !value.is_empty())
    }

    pub(crate) fn protocol(&self) -> Option<&str> {
        self.protocol.as_deref()
    }

    pub(crate) fn media_protocol(&self) -> Option<&str> {
        self.media_protocol.as_deref()
    }

    fn provider_reference(&self) -> Result<ProviderReference, InvalidProviderAccountDraft> {
        ProviderReference::try_new(provider_reference_value(&self.provider)?)
            .map_err(|_| InvalidProviderAccountDraft)
    }

    fn credential(&self) -> Result<Option<CredentialReference>, InvalidProviderAccountDraft> {
        if matches!(self.auth_mode.as_str(), "local" | "cliReuse") {
            return Ok(None);
        }
        CredentialReference::try_new(format!("credential:v1:{}", self.id))
            .map(Some)
            .map_err(|_| InvalidProviderAccountDraft)
    }

    fn account_kind(&self) -> Result<ProviderAccountKind, InvalidProviderAccountDraft> {
        provider_account_kind(&self.kind)
    }

    fn api_protocol(&self) -> Result<Option<ProviderApiProtocol>, InvalidProviderAccountDraft> {
        self.protocol
            .as_deref()
            .map(provider_api_protocol)
            .transpose()
    }

    fn media_api_protocol(
        &self,
    ) -> Result<Option<ProviderMediaApiProtocol>, InvalidProviderAccountDraft> {
        self.media_protocol
            .as_deref()
            .map(provider_media_api_protocol)
            .transpose()
    }

    fn account_auth_mode(&self) -> Result<ProviderAccountAuthMode, InvalidProviderAccountDraft> {
        provider_account_auth_mode(&self.auth_mode)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct InvalidProviderAccountDraft;

fn provider_reference_value(provider: &str) -> Result<String, InvalidProviderAccountDraft> {
    let provider = provider.strip_prefix("provider:").unwrap_or(provider);
    (!provider.is_empty()
        && provider
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.')))
    .then(|| format!("provider:{provider}"))
    .ok_or(InvalidProviderAccountDraft)
}

fn provider_account_kind(value: &str) -> Result<ProviderAccountKind, InvalidProviderAccountDraft> {
    match value {
        "chat" => Ok(ProviderAccountKind::Chat),
        "media" => Ok(ProviderAccountKind::Media),
        _ => Err(InvalidProviderAccountDraft),
    }
}

fn provider_account_kind_name(value: ProviderAccountKind) -> &'static str {
    match value {
        ProviderAccountKind::Chat => "chat",
        ProviderAccountKind::Media => "media",
    }
}

fn provider_api_protocol(value: &str) -> Result<ProviderApiProtocol, InvalidProviderAccountDraft> {
    match value {
        "anthropicMessages" => Ok(ProviderApiProtocol::AnthropicMessages),
        "googleGenerativeAi" => Ok(ProviderApiProtocol::GoogleGenerativeAi),
        "openAiCompletions" => Ok(ProviderApiProtocol::OpenAiCompletions),
        "openAiResponses" => Ok(ProviderApiProtocol::OpenAiResponses),
        _ => Err(InvalidProviderAccountDraft),
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

fn provider_media_api_protocol(
    value: &str,
) -> Result<ProviderMediaApiProtocol, InvalidProviderAccountDraft> {
    match value {
        "google" => Ok(ProviderMediaApiProtocol::Google),
        "openAi" => Ok(ProviderMediaApiProtocol::OpenAi),
        "openRouter" => Ok(ProviderMediaApiProtocol::OpenRouter),
        _ => Err(InvalidProviderAccountDraft),
    }
}

fn provider_media_api_protocol_name(value: ProviderMediaApiProtocol) -> &'static str {
    match value {
        ProviderMediaApiProtocol::Google => "google",
        ProviderMediaApiProtocol::OpenAi => "openAi",
        ProviderMediaApiProtocol::OpenRouter => "openRouter",
    }
}

fn provider_account_auth_mode(
    value: &str,
) -> Result<ProviderAccountAuthMode, InvalidProviderAccountDraft> {
    match value {
        "apiKey" => Ok(ProviderAccountAuthMode::ApiKey),
        "token" => Ok(ProviderAccountAuthMode::Token),
        "cliReuse" => Ok(ProviderAccountAuthMode::CliReuse),
        "oauthBrowser" => Ok(ProviderAccountAuthMode::OAuthBrowser),
        "oauthDevice" => Ok(ProviderAccountAuthMode::OAuthDevice),
        "local" => Ok(ProviderAccountAuthMode::Local),
        _ => Err(InvalidProviderAccountDraft),
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
