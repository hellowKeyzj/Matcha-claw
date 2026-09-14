use std::{collections::BTreeMap, fmt};

use crate::skill_bundle::{Bundle, BundleFile};

#[derive(Clone, Eq, PartialEq)]
pub(crate) enum Command {
    Detail {
        slug: String,
    },
    Config {
        skill_key: String,
        enabled: Option<bool>,
        api_key: Option<String>,
        env: Option<BTreeMap<String, String>>,
    },
    ClawHubInstall {
        slug: String,
        version: Option<String>,
        force: bool,
    },
    ClawHubUpdate {
        slug: Option<String>,
        all: bool,
    },
    UploadBegin {
        slug: String,
        size: u64,
        sha256: String,
        force: bool,
        idempotency_key: Option<String>,
    },
    UploadChunk {
        upload_id: String,
        offset: u64,
        bytes: Vec<u8>,
    },
    UploadCommit {
        upload_id: String,
        sha256: Option<String>,
    },
    Uninstall {
        skill_key: String,
        slug: Option<String>,
    },
    ImportMarkdown {
        content: String,
    },
    ImportBundle {
        bundle: Bundle,
    },
    Readme {
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    },
    OpenReadme {
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    },
    OpenPath {
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Outcome {
    Detail(Result<Detail, ReadError>),
    Mutation(MutationOutcome),
    Upload(UploadOutcome),
    Uninstall(RemoveOutcome),
    Import(ImportOutcome),
    Readme(Result<ReadmeReceipt, ReadmeError>),
    OpenPath(Result<OpenPathReceipt, ReadmeError>),
    Unavailable,
    Rejected,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Detail {
    pub(crate) skill: Option<DetailSkill>,
    pub(crate) latest_version: Option<DetailVersion>,
    pub(crate) metadata: Option<DetailMetadata>,
    pub(crate) owner: Option<DetailOwner>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DetailSkill {
    pub(crate) slug: String,
    pub(crate) display_name: String,
    pub(crate) summary: Option<String>,
    pub(crate) tags: BTreeMap<String, String>,
    pub(crate) created_at: u64,
    pub(crate) updated_at: u64,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DetailVersion {
    pub(crate) version: String,
    pub(crate) created_at: u64,
    pub(crate) changelog: Option<String>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DetailMetadata {
    pub(crate) os: Option<Vec<String>>,
    pub(crate) systems: Option<Vec<String>>,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DetailOwner {
    pub(crate) handle: Option<String>,
    pub(crate) display_name: Option<String>,
    pub(crate) image: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReadError {
    Unavailable,
    Rejected,
    Protocol,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MutationOutcome {
    Accepted,
    Rejected,
    Unknown,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum UploadOutcome {
    Accepted(UploadReceipt),
    Rejected,
    Unknown,
}
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UploadReceipt {
    pub(crate) upload_id: String,
    pub(crate) received_bytes: u64,
    pub(crate) expires_at: u64,
    pub(crate) sha256: Option<String>,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RemoveOutcome {
    Removed,
    NotFound,
    Rejected,
    Unknown,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ImportOutcome {
    Accepted,
    Rejected,
    Unknown,
}
#[derive(Clone, Eq, PartialEq)]
pub(crate) struct ReadmeReceipt {
    pub(crate) skill_key: String,
    pub(crate) content: String,
    pub(crate) file_path: String,
}

#[derive(Clone, Eq, PartialEq)]
pub(crate) struct OpenPathReceipt;

impl fmt::Debug for ReadmeReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ReadmeReceipt([REDACTED])")
    }
}

impl fmt::Debug for OpenPathReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("OpenPathReceipt([REDACTED])")
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ReadmeError {
    Rejected,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum BundleError {
    Rejected,
    Unknown,
}

impl Command {
    pub(crate) fn detail(slug: String) -> Result<Self, ()> {
        valid_slug(&slug)
            .then_some(Self::Detail {
                slug: slug.trim().to_owned(),
            })
            .ok_or(())
    }
    pub(crate) fn config(
        skill_key: String,
        enabled: Option<bool>,
        api_key: Option<String>,
        env: Option<BTreeMap<String, String>>,
    ) -> Result<Self, ()> {
        if enabled.is_none() && api_key.is_none() && env.is_none()
            || !valid_openclaw_skill_key(&skill_key)
        {
            return Err(());
        }
        Ok(Self::Config {
            skill_key: skill_key.trim().to_owned(),
            enabled,
            api_key,
            env,
        })
    }
    pub(crate) fn clawhub_install(
        slug: String,
        version: Option<String>,
        force: bool,
    ) -> Result<Self, ()> {
        valid_slug(&slug)
            .then_some(Self::ClawHubInstall {
                slug: slug.trim().to_owned(),
                version: version.map(|v| v.trim().to_owned()),
                force,
            })
            .ok_or(())
    }
    pub(crate) fn clawhub_update(slug: Option<String>, all: bool) -> Result<Self, ()> {
        (all || slug.as_deref().is_some_and(valid_slug))
            .then_some(Self::ClawHubUpdate {
                slug: slug.map(|v| v.trim().to_owned()),
                all,
            })
            .ok_or(())
    }
    pub(crate) fn upload_begin(
        slug: String,
        size: u64,
        sha256: String,
        force: bool,
        idempotency_key: Option<String>,
    ) -> Result<Self, ()> {
        (valid_slug(&slug) && size > 0 && valid_sha256(&sha256))
            .then_some(Self::UploadBegin {
                slug: slug.trim().to_owned(),
                size,
                sha256,
                force,
                idempotency_key,
            })
            .ok_or(())
    }
    pub(crate) fn upload_chunk(upload_id: String, offset: u64, bytes: Vec<u8>) -> Result<Self, ()> {
        (!upload_id.trim().is_empty() && !bytes.is_empty())
            .then_some(Self::UploadChunk {
                upload_id,
                offset,
                bytes,
            })
            .ok_or(())
    }
    pub(crate) fn upload_commit(upload_id: String, sha256: Option<String>) -> Result<Self, ()> {
        (!upload_id.trim().is_empty() && sha256.as_deref().is_none_or(valid_sha256))
            .then_some(Self::UploadCommit { upload_id, sha256 })
            .ok_or(())
    }
    pub(crate) fn uninstall(skill_key: String, slug: Option<String>) -> Result<Self, ()> {
        if !valid_openclaw_skill_key(&skill_key)
            || slug.as_deref().is_some_and(|value| !valid_slug(value))
        {
            return Err(());
        }
        Ok(Self::Uninstall {
            skill_key: skill_key.trim().to_owned(),
            slug: slug.map(|value| value.trim().to_owned()),
        })
    }
    pub(crate) fn import_markdown(content: String) -> Result<Self, ()> {
        (!content.is_empty())
            .then_some(Self::ImportMarkdown { content })
            .ok_or(())
    }
    pub(crate) fn import_bundle(bundle: Bundle) -> Result<Self, ()> {
        Ok(Self::ImportBundle { bundle })
    }
    pub(crate) fn readme(
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<Self, ()> {
        if !valid_openclaw_skill_key(&skill_key)
            || slug
                .as_deref()
                .is_some_and(|value| !valid_openclaw_skill_key(value))
        {
            return Err(());
        }
        Ok(Self::Readme {
            skill_key: skill_key.trim().to_owned(),
            slug: slug.map(|value| value.trim().to_owned()),
            file_path,
            base_dir,
        })
    }

    pub(crate) fn open_readme(
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<Self, ()> {
        if !valid_openclaw_skill_key(&skill_key)
            || slug
                .as_deref()
                .is_some_and(|value| !valid_openclaw_skill_key(value))
        {
            return Err(());
        }
        Ok(Self::OpenReadme {
            skill_key: skill_key.trim().to_owned(),
            slug: slug.map(|value| value.trim().to_owned()),
            file_path,
            base_dir,
        })
    }

    pub(crate) fn open_path(
        skill_key: String,
        slug: Option<String>,
        file_path: Option<String>,
        base_dir: Option<String>,
    ) -> Result<Self, ()> {
        if !valid_openclaw_skill_key(&skill_key)
            || slug
                .as_deref()
                .is_some_and(|value| !valid_openclaw_skill_key(value))
        {
            return Err(());
        }
        Ok(Self::OpenPath {
            skill_key: skill_key.trim().to_owned(),
            slug: slug.map(|value| value.trim().to_owned()),
            file_path,
            base_dir,
        })
    }
}

fn valid_slug(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        && value
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && value
            .bytes()
            .last()
            .is_some_and(|b| b.is_ascii_alphanumeric())
}
fn valid_openclaw_skill_key(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
}
fn valid_name(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'/'))
        && !value.contains("..")
        && !value.starts_with('/')
        && !value.ends_with('/')
}
fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

#[allow(dead_code)]
fn _bundle_types_are_semantic(_: Bundle, _: BundleFile) {}
