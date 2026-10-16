use std::collections::BTreeSet;

use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::rpc::{self, Error};

pub(super) const MAX_FILE_BYTES: usize = 1024 * 1024;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Catalog {
    pub agent_id: String,
    pub skills: Vec<Skill>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Skill {
    pub skill_key: String,
    pub package_sha256: String,
    pub descriptor: Descriptor,
    pub files: Vec<File>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Descriptor {
    name: String,
    description: String,
    user_invocable: bool,
    disable_model_invocation: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct File {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

// Content is transient HTTP data, never a diagnostic or durable record.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Read {
    content_base64: String,
    package_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    metering_binding: Option<String>,
}

impl Catalog {
    pub fn validate(&self, agent_id: &str) -> rpc::Result<()> {
        let mut keys = BTreeSet::new();
        if self.agent_id != agent_id
            || self.skills.iter().any(|skill| {
                !skill_key(&skill.skill_key)
                    || !keys.insert(&skill.skill_key)
                    || !sha256(&skill.package_sha256)
                    || !skill.descriptor.valid()
                    || skill.files.is_empty()
                    || skill.files.len() > 512
                    || !skill.files.iter().any(|file| file.path == "SKILL.md")
                    || skill
                        .files
                        .iter()
                        .map(|file| file.size_bytes)
                        .try_fold(0_u64, u64::checked_add)
                        .is_none_or(|total| total > 5 * 1024 * 1024)
                    || {
                        let mut paths = BTreeSet::new();
                        skill.files.iter().any(|file| {
                            !relative_path(&file.path)
                                || !paths.insert(&file.path)
                                || file.size_bytes > MAX_FILE_BYTES as u64
                                || !sha256(&file.sha256)
                        })
                    }
            })
        {
            return Err(invalid_readback());
        }
        Ok(())
    }
}

impl Descriptor {
    fn valid(&self) -> bool {
        text(&self.name, 256) && text(&self.description, 8 * 1024)
    }
}

impl Read {
    pub fn validate(&self, skill: &Skill, file: &File, expected: &str) -> rpc::Result<()> {
        if self.package_sha256 != expected || self.package_sha256 != skill.package_sha256 {
            return Err(Error::conflict(
                "sealed_package_changed",
                "The sealed package has changed",
            ));
        }
        let content = STANDARD
            .decode(&self.content_base64)
            .map_err(|source| invalid_readback().with_source(source))?;
        if content.len() != file.size_bytes as usize
            || content.len() > MAX_FILE_BYTES
            || format!("{:x}", Sha256::digest(&content)) != file.sha256
        {
            return Err(invalid_readback());
        }
        if let Some(binding) = &self.metering_binding {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase", deny_unknown_fields)]
            struct Binding {
                v: u8,
                kind: String,
                runtime: String,
                package_sha256: String,
                key: String,
                #[serde(rename = "use")]
                usage: String,
            }
            let bytes = binding
                .strip_prefix("m1.")
                .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
                .ok_or_else(invalid_readback)?;
            let binding: Binding = serde_json::from_slice(&bytes)
                .map_err(|source| invalid_readback().with_source(source))?;
            if binding.v != 1
                || binding.kind != "skill"
                || binding.runtime != "matcha-agent"
                || binding.package_sha256 != expected
                || binding.key != skill.skill_key
                || binding.usage != "turn"
            {
                return Err(invalid_readback());
            }
        }
        Ok(())
    }
}

pub(super) fn sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

pub(super) fn skill_key(value: &str) -> bool {
    !value.is_empty()
        && value == value.trim()
        && !matches!(value, "." | "..")
        && value.len() <= 4096
        && !value.contains('\0')
}

pub(super) fn relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && !value.contains(['\\', '\0'])
        && value.split('/').all(|part| {
            !part.is_empty()
                && part != "."
                && part != ".."
                && !(part.as_bytes().get(1) == Some(&b':')
                    && part.as_bytes()[0].is_ascii_alphabetic())
        })
}

fn text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}

pub(super) fn invalid_readback() -> Error {
    Error::new(
        -32004,
        "sealed_invalid_readback",
        "The sealed reader returned an invalid response",
    )
}
