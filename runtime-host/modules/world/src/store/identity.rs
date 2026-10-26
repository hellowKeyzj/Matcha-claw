/// Trusted private configuration intent. Existing never initializes an unmarked database.
pub enum StorageIdentity {
    Initialize {
        storage_id: String,
        configuration_token: String,
    },
    Existing {
        storage_id: String,
        configuration_token: String,
    },
}

impl StorageIdentity {
    pub(super) fn values(&self) -> (&str, &str) {
        match self {
            Self::Initialize {
                storage_id,
                configuration_token,
            }
            | Self::Existing {
                storage_id,
                configuration_token,
            } => (storage_id, configuration_token),
        }
    }
}

/// Only a successfully connected store can attest a Host configuration candidate.
#[derive(Clone)]
pub struct StorageIdentityReceipt {
    storage_id: String,
    configuration_token: String,
}
impl StorageIdentityReceipt {
    pub(super) fn verified(identity: &StorageIdentity) -> Self {
        let (storage_id, configuration_token) = identity.values();
        Self {
            storage_id: storage_id.into(),
            configuration_token: configuration_token.into(),
        }
    }
    pub fn storage_id(&self) -> &str {
        &self.storage_id
    }
    pub fn configuration_token(&self) -> &str {
        &self.configuration_token
    }
}
