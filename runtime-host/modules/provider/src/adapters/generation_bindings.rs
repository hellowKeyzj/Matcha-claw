use std::{fs, io, path::PathBuf};

use platform::state_dir::CanonicalStateDir;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::{
    ProviderAccountId, ProviderApiProtocol, ProviderRoutingCapability,
    ProviderTextGenerationModelLimits,
    generation::{Binding, BindingDescriptor, Failure, FailureKind, Stage},
    llm_client::LlmGenerationOptions,
};

const PREFIX: &str = "provider-generation-record:v1:";
const MAX_RECORD_BYTES: usize = 64 * 1024;

/// Provider-owned issued records are the seal authority, not a caller-supplied digest alone.
/// These records contain no credential reference, credential material, or endpoint secrets.
#[derive(Clone)]
pub(crate) struct GenerationBindings {
    directory: PathBuf,
}

impl GenerationBindings {
    pub fn path_for_journal(journal: &std::path::Path) -> PathBuf {
        let mut path = journal.as_os_str().to_owned();
        path.push(".generation-bindings");
        path.into()
    }

    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }

    pub fn issue(&self, binding: &Binding) -> Result<BindingDescriptor, Failure> {
        let bytes = serde_json::to_vec(&Record::from_binding(binding)).map_err(|_| invalid())?;
        if bytes.len() > MAX_RECORD_BYTES {
            return Err(invalid());
        }
        let digest = format!("{:x}", Sha256::digest(&bytes));
        let descriptor = BindingDescriptor(format!("{PREFIX}{digest}"));
        let directory = CanonicalStateDir::provision_private(&self.directory)
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Directory))?;
        let handle = directory
            .open()
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Directory))?;
        let _writer = handle
            .lock_regular_file("issue.lock")
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Lock))?;
        let name = format!("{digest}.json");
        match handle
            .read_regular_file_bounded(&name, MAX_RECORD_BYTES)
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Read))?
        {
            Some(existing) if existing != bytes => return Err(invalid()),
            Some(_) => {}
            None => handle
                .replace_regular_file_bounded_detailed(&name, &bytes, MAX_RECORD_BYTES)
                .map_err(|error| {
                    unavailable(crate::generation::BindingStoreCause::Write {
                        commit_unknown: error.commit_unknown(),
                        cleanup_failed: error.cleanup_failed(),
                    })
                })?,
        }
        Ok(descriptor)
    }

    pub(super) fn backup_to(&self, destination: &std::path::Path) -> Result<bool, Failure> {
        match fs::symlink_metadata(&self.directory) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(unavailable(crate::generation::BindingStoreCause::Directory)),
        }
        let source = CanonicalStateDir::provision_private(&self.directory)
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Directory))?;
        let handle = source
            .open()
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Directory))?;
        let _writer = handle
            .lock_regular_file("issue.lock")
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Lock))?;
        let target = CanonicalStateDir::provision_private(destination)
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Directory))?;
        for entry in fs::read_dir(source.as_path())
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Read))?
        {
            let entry =
                entry.map_err(|_| unavailable(crate::generation::BindingStoreCause::Read))?;
            let name = entry.file_name().into_string().map_err(|_| invalid())?;
            if name == "issue.lock" {
                continue;
            }
            let digest = name
                .strip_suffix(".json")
                .filter(|digest| valid_digest(digest))
                .ok_or_else(invalid)?;
            let bytes = handle
                .read_regular_file_bounded(&name, MAX_RECORD_BYTES)
                .map_err(|_| unavailable(crate::generation::BindingStoreCause::Read))?
                .ok_or_else(invalid)?;
            if format!("{:x}", Sha256::digest(&bytes)) != digest {
                return Err(invalid());
            }
            target
                .open()
                .map_err(|_| unavailable(crate::generation::BindingStoreCause::Directory))?
                .replace_regular_file_bounded_detailed(&name, &bytes, MAX_RECORD_BYTES)
                .map_err(|error| {
                    unavailable(crate::generation::BindingStoreCause::Write {
                        commit_unknown: error.commit_unknown(),
                        cleanup_failed: error.cleanup_failed(),
                    })
                })?;
        }
        Ok(true)
    }

    pub fn restore(&self, descriptor: BindingDescriptor) -> Result<Binding, Failure> {
        let digest = descriptor
            .0
            .strip_prefix(PREFIX)
            .filter(|digest| valid_digest(digest))
            .ok_or_else(invalid)?;
        // An absent inventory is not recreated and cannot recover a detached descriptor.
        match fs::symlink_metadata(&self.directory) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Err(invalid()),
            Err(_) => return Err(unavailable(crate::generation::BindingStoreCause::Directory)),
        }
        let directory = CanonicalStateDir::provision_private(&self.directory)
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Directory))?;
        let bytes = directory
            .read_regular_file_bounded(&format!("{digest}.json"), MAX_RECORD_BYTES)
            .map_err(|_| unavailable(crate::generation::BindingStoreCause::Read))?
            .ok_or_else(invalid)?;
        if format!("{:x}", Sha256::digest(&bytes)) != digest {
            return Err(invalid());
        }
        let record: Record = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
        record.into_binding(descriptor)
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u8,
    account_id: String,
    model_id: String,
    selection_id: String,
    account_revision: u64,
    fingerprint: String,
    capability: u8,
    protocol: u8,
    context_window: Option<u64>,
    max_tokens: Option<u64>,
    timeout_ms: Option<u64>,
    max_output_tokens: Option<u32>,
    temperature_bits: Option<u32>,
    top_p_bits: Option<u32>,
    top_k: Option<u32>,
    stop: Vec<String>,
}

impl Record {
    fn from_binding(binding: &Binding) -> Self {
        Self {
            version: 1,
            account_id: binding.account_id.as_str().to_owned(),
            model_id: binding.model_id.clone(),
            selection_id: binding.selection_id.clone(),
            account_revision: binding.account_revision,
            fingerprint: binding.configuration_fingerprint.clone(),
            capability: match binding.capability {
                ProviderRoutingCapability::Chat => 1,
                ProviderRoutingCapability::ImageUnderstand => 2,
                _ => 0,
            },
            protocol: match binding.protocol {
                ProviderApiProtocol::AnthropicMessages => 1,
                ProviderApiProtocol::OpenAiCompletions => 2,
                ProviderApiProtocol::OpenAiResponses => 3,
                ProviderApiProtocol::GoogleGenerativeAi => 4,
            },
            context_window: binding.limits.context_window,
            max_tokens: binding.limits.max_tokens,
            timeout_ms: binding.limits.timeout_ms,
            max_output_tokens: binding.options.max_output_tokens,
            temperature_bits: binding.options.temperature.map(f32::to_bits),
            top_p_bits: binding.options.top_p.map(f32::to_bits),
            top_k: binding.options.top_k,
            stop: binding.options.stop.clone(),
        }
    }

    fn into_binding(self, descriptor: BindingDescriptor) -> Result<Binding, Failure> {
        if self.version != 1 {
            return Err(invalid());
        }
        let account_id = ProviderAccountId::try_new(self.account_id).map_err(|_| invalid())?;
        if self.selection_id != crate::provider_model_selection_id(&account_id, &self.model_id) {
            return Err(invalid());
        }
        Ok(Binding {
            account_id,
            model_id: self.model_id,
            selection_id: self.selection_id,
            account_revision: self.account_revision,
            configuration_fingerprint: self.fingerprint,
            capability: match self.capability {
                1 => ProviderRoutingCapability::Chat,
                2 => ProviderRoutingCapability::ImageUnderstand,
                _ => return Err(invalid()),
            },
            protocol: match self.protocol {
                1 => ProviderApiProtocol::AnthropicMessages,
                2 => ProviderApiProtocol::OpenAiCompletions,
                3 => ProviderApiProtocol::OpenAiResponses,
                _ => return Err(invalid()),
            },
            limits: ProviderTextGenerationModelLimits {
                context_window: self.context_window,
                max_tokens: self.max_tokens,
                timeout_ms: self.timeout_ms,
            },
            options: LlmGenerationOptions {
                max_output_tokens: self.max_output_tokens,
                temperature: self.temperature_bits.map(f32::from_bits),
                top_p: self.top_p_bits.map(f32::from_bits),
                top_k: self.top_k,
                stop: self.stop,
            },
            descriptor,
        })
    }
}

fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn invalid() -> Failure {
    Failure::new(Stage::Binding, FailureKind::BindingInvalid)
}
fn unavailable(cause: crate::generation::BindingStoreCause) -> Failure {
    Failure::new(
        Stage::Binding,
        FailureKind::BindingStoreUnavailable { cause },
    )
}
