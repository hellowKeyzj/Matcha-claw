use std::{
    collections::BTreeMap,
    fs,
    sync::{Arc, Mutex},
};

use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use platform::state_dir::CanonicalStateDir;
use serde::Serialize;
use zeroize::Zeroizing;

use crate::{
    AgentKey, SealedPackageAuthorizationKeyring, SealedResourceError, SealedSkillStore,
    ports::SealedSkillStoreAdapter,
};

/// Host-to-Server credentials. Never serialize, log, or forward these to a CLI.
#[derive(Clone)]
pub struct NativeSealedReaderCredentials {
    token: Arc<Zeroizing<String>>,
}

impl NativeSealedReaderCredentials {
    pub fn token(&self) -> &str {
        self.token.as_str()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSealedCatalog {
    pub agent_id: String,
    pub skills: Vec<NativeSealedSkill>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSealedSkill {
    pub skill_key: String,
    pub package_sha256: String,
    pub descriptor: NativeSealedDescriptor,
    pub files: Vec<NativeSealedFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSealedDescriptor {
    pub name: String,
    pub description: String,
    pub user_invocable: bool,
    pub disable_model_invocation: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSealedFile {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NativeReadError {
    InvalidRequest,
    Unauthorized,
    NotFound,
    Disabled,
    PackageChanged,
    Unavailable,
}

impl From<SealedResourceError> for NativeReadError {
    fn from(error: SealedResourceError) -> Self {
        match error {
            SealedResourceError::NotFound => Self::NotFound,
            SealedResourceError::Unknown => Self::Unavailable,
            _ => Self::Disabled,
        }
    }
}

pub(crate) struct NativeSealedSkills {
    root: CanonicalStateDir,
    keyring: Arc<SealedPackageAuthorizationKeyring>,
    credentials: NativeSealedReaderCredentials,
    stores: Mutex<BTreeMap<AgentKey, Arc<SealedSkillStore>>>,
}

impl NativeSealedSkills {
    pub(crate) fn new(
        root: CanonicalStateDir,
        keyring: Arc<SealedPackageAuthorizationKeyring>,
    ) -> Result<Self, SealedResourceError> {
        root.open().map_err(|_| SealedResourceError::Rejected)?;
        let mut bytes = Zeroizing::new([0_u8; 32]);
        getrandom::fill(&mut *bytes).map_err(|_| SealedResourceError::Unknown)?;
        let token = Arc::new(Zeroizing::new(URL_SAFE_NO_PAD.encode(*bytes)));
        Ok(Self {
            root,
            keyring,
            credentials: NativeSealedReaderCredentials { token },
            stores: Mutex::new(BTreeMap::new()),
        })
    }

    pub(crate) fn credentials(&self) -> NativeSealedReaderCredentials {
        self.credentials.clone()
    }

    pub(crate) fn authorized(&self, token: &str) -> bool {
        let expected = self.credentials.token().as_bytes();
        let actual = token.as_bytes();
        actual.len() == expected.len()
            && actual
                .iter()
                .zip(expected)
                .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
                == 0
    }

    pub(crate) fn store(
        &self,
        agent: &str,
        create: bool,
    ) -> Result<Arc<SealedSkillStore>, SealedResourceError> {
        if !valid_agent(agent) {
            return Err(SealedResourceError::Rejected);
        }
        self.root.open().map_err(|_| SealedResourceError::Unknown)?;
        let key = AgentKey::parse(agent).map_err(|_| SealedResourceError::Rejected)?;
        let mut stores = self
            .stores
            .lock()
            .map_err(|_| SealedResourceError::Unknown)?;
        if let Some(store) = stores.get(&key) {
            return Ok(Arc::clone(store));
        }
        let path = self.root.as_path().join(agent).join("sealed-skills");
        if !create {
            match fs::symlink_metadata(&path) {
                Ok(_) => (),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Err(SealedResourceError::NotFound);
                }
                Err(_) => return Err(SealedResourceError::Unknown),
            }
        }
        CanonicalStateDir::provision(self.root.as_path().join(agent))
            .map_err(|_| SealedResourceError::Rejected)?;
        let root =
            CanonicalStateDir::provision(&path).map_err(|_| SealedResourceError::Rejected)?;
        let store = Arc::new(SealedSkillStore::matcha_with_keyring(
            root,
            Arc::clone(&self.keyring),
        )?);
        stores.insert(key, Arc::clone(&store));
        Ok(store)
    }

    pub(crate) fn cloud_packages(
        &self,
    ) -> Result<Vec<crate::SealedCloudPackageEntry>, SealedResourceError> {
        self.root.open().map_err(|_| SealedResourceError::Unknown)?;
        let mut packages = Vec::new();
        for entry in fs::read_dir(self.root.as_path()).map_err(|_| SealedResourceError::Unknown)? {
            let entry = entry.map_err(|_| SealedResourceError::Unknown)?;
            let Some(agent) = entry
                .file_name()
                .to_str()
                .filter(|agent| valid_agent(agent))
                .map(str::to_owned)
            else {
                continue;
            };
            match self.store(&agent, false) {
                Ok(store) => packages.extend(store.cloud_packages()?),
                Err(SealedResourceError::NotFound) => (),
                Err(error) => return Err(error),
            }
        }
        Ok(packages)
    }
}

impl skills_module::SealedSkillStoreFactoryPort for NativeSealedSkills {
    fn for_agent(
        &self,
        agent_id: &str,
    ) -> Result<Arc<dyn skills_module::SealedSkillStorePort>, skills_module::SealedSkillError> {
        let store = self
            .store(agent_id, true)
            .map_err(super::ports::project_skill_error)?;
        // Native content is available only through the separately authenticated private reader.
        Ok(Arc::new(SealedSkillStoreAdapter::new(store, None)))
    }
}

pub(crate) fn valid_agent(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(crate) fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}
