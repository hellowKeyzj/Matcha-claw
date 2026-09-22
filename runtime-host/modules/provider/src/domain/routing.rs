use std::{fmt, num::NonZeroU64};

use crate::ProviderAccountId;

const MAX_MODEL_ID_BYTES: usize = 512;

/// The capability whose provider model selection is desired by this Environment.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ProviderRoutingCapability {
    Chat,
    ImageUnderstand,
    ImageGenerate,
    VideoGenerate,
    MusicGenerate,
    Tts,
}

/// A monotonically increasing revision assigned to one desired provider routing.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ProviderRoutingRevision(NonZeroU64);

impl ProviderRoutingRevision {
    pub fn try_new(value: u64) -> Result<Self, InvalidProviderRoutingRevision> {
        NonZeroU64::new(value)
            .map(Self)
            .ok_or(InvalidProviderRoutingRevision)
    }

    pub const fn get(self) -> u64 {
        self.0.get()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidProviderRoutingRevision;

impl fmt::Display for InvalidProviderRoutingRevision {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider routing revision must be non-zero")
    }
}

impl std::error::Error for InvalidProviderRoutingRevision {}

/// A non-secret provider model reference selected through a public account identity.
#[derive(Clone, Eq, PartialEq)]
pub struct ProviderModelReference {
    account_id: ProviderAccountId,
    model_id: String,
}

impl ProviderModelReference {
    pub fn try_new(
        account_id: ProviderAccountId,
        model_id: impl Into<String>,
    ) -> Result<Self, InvalidProviderModelReference> {
        let model_id = normalized_model_id(model_id.into()).ok_or(InvalidProviderModelReference)?;
        Ok(Self {
            account_id,
            model_id,
        })
    }

    pub fn account_id(&self) -> &ProviderAccountId {
        &self.account_id
    }

    pub fn model_id(&self) -> &str {
        &self.model_id
    }
}

impl fmt::Debug for ProviderModelReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ProviderModelReference")
            .field("account_id", &self.account_id)
            .field("model_id", &self.model_id)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidProviderModelReference;

impl fmt::Display for InvalidProviderModelReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider routing model identifier is invalid")
    }
}

impl std::error::Error for InvalidProviderModelReference {}

/// Ordered desired routing for one provider capability.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRoute {
    primary: ProviderModelReference,
    fallbacks: Vec<ProviderModelReference>,
    timeout_ms: Option<u64>,
}

impl ProviderRoute {
    pub fn try_new(
        primary: ProviderModelReference,
        fallbacks: Vec<ProviderModelReference>,
        timeout_ms: Option<u64>,
    ) -> Result<Self, InvalidProviderRoute> {
        if timeout_ms == Some(0) {
            return Err(InvalidProviderRoute::Timeout);
        }
        if fallbacks.iter().any(|fallback| fallback == &primary) {
            return Err(InvalidProviderRoute::DuplicateModel);
        }
        for (index, fallback) in fallbacks.iter().enumerate() {
            if fallbacks[..index]
                .iter()
                .any(|previous| previous == fallback)
            {
                return Err(InvalidProviderRoute::DuplicateModel);
            }
        }
        Ok(Self {
            primary,
            fallbacks,
            timeout_ms,
        })
    }

    pub fn primary(&self) -> &ProviderModelReference {
        &self.primary
    }

    pub fn fallbacks(&self) -> &[ProviderModelReference] {
        &self.fallbacks
    }

    pub const fn timeout_ms(&self) -> Option<u64> {
        self.timeout_ms
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InvalidProviderRoute {
    DuplicateModel,
    Timeout,
}

impl fmt::Display for InvalidProviderRoute {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::DuplicateModel => "provider route model references must be distinct",
            Self::Timeout => "provider route timeout must be positive",
        })
    }
}

impl std::error::Error for InvalidProviderRoute {}

/// Revisioned, durable, non-secret desired provider routing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderRouting {
    revision: ProviderRoutingRevision,
    routes: Vec<(ProviderRoutingCapability, ProviderRoute)>,
}

impl ProviderRouting {
    pub fn try_new(
        revision: ProviderRoutingRevision,
        routes: Vec<(ProviderRoutingCapability, ProviderRoute)>,
    ) -> Result<Self, InvalidProviderRouting> {
        let mut routes = routes;
        routes.sort_by_key(|(capability, _)| *capability);
        if routes.windows(2).any(|pair| pair[0].0 == pair[1].0) {
            return Err(InvalidProviderRouting);
        }
        Ok(Self { revision, routes })
    }

    pub const fn revision(&self) -> ProviderRoutingRevision {
        self.revision
    }

    pub fn routes(&self) -> &[(ProviderRoutingCapability, ProviderRoute)] {
        &self.routes
    }

    pub fn route(&self, capability: ProviderRoutingCapability) -> Option<&ProviderRoute> {
        self.routes
            .iter()
            .find_map(|(current, route)| (*current == capability).then_some(route))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidProviderRouting;

impl fmt::Display for InvalidProviderRouting {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("provider routing must not define one capability more than once")
    }
}

impl std::error::Error for InvalidProviderRouting {}

fn normalized_model_id(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= MAX_MODEL_ID_BYTES && !value.chars().any(char::is_control))
        .then(|| value.to_owned())
}

#[cfg(test)]
#[path = "routing_tests.rs"]
mod tests;
