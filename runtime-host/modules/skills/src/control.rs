use std::{collections::BTreeMap, path::Path};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::{bundle, management, status};

pub enum ManagementRequest {
    RefreshStatus,
    UpdateConfig(management::Command),
    UpdateState(management::Command),
    UpdateBatchState {
        commands: Vec<management::Command>,
        skill_keys: Vec<String>,
        enabled: bool,
    },
    ExportBundles(bundle::Command),
    ImportBundles(bundle::Command),
    OpenReadme(management::Command),
    OpenPath(management::Command),
}

pub enum ManagementOutcome {
    Succeeded(Value),
    Unknown(Value),
    InvalidInput,
    Rejected(&'static str),
    Unavailable,
    InternalError,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidControlInput;

impl From<()> for InvalidControlInput {
    fn from(_: ()) -> Self {
        Self
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CapabilityExecuteRequest {
    id: String,
    operation_id: String,
    scope: Value,
    target: Value,
    input: Value,
    #[serde(rename = "traceId", default)]
    _trace_id: Option<String>,
}

struct SkillTarget<'a> {
    id: &'a str,
    slug: Option<&'a str>,
}

pub async fn execute_management_request(
    skills: &crate::SkillsModule,
    input: Value,
) -> ManagementOutcome {
    let request = match decode_management_request(input) {
        Ok(request) => request,
        Err(_) => return ManagementOutcome::InvalidInput,
    };
    dispatch_management_request(skills, request).await
}

pub fn decode_management_request(input: Value) -> Result<ManagementRequest, InvalidControlInput> {
    let request: CapabilityExecuteRequest = decode(input)?;
    if request.id != "skill.management"
        || !is_openclaw_runtime_scope(&request.scope)
        || !is_skill_capability_request(&request.operation_id, &request.target, &request.input)
    {
        return Err(InvalidControlInput);
    }
    management_request(request.operation_id, request.input)
}

pub fn is_skill_capability_request(operation: &str, target: &Value, input: &Value) -> bool {
    let Some(target) = target.as_object() else {
        return false;
    };
    let Some(input) = input.as_object() else {
        return false;
    };
    match operation {
        "skills.refreshStatus" => {
            target.len() == 1 && target.get("kind") == Some(&json!("none")) && input.is_empty()
        }
        "skills.exportBundles" => {
            target.len() == 1
                && target.get("kind") == Some(&json!("skill-bundle"))
                && skill_keys_input(input)
        }
        "skills.importBundles" => {
            target.len() == 1
                && target.get("kind") == Some(&json!("skill-bundle"))
                && input.len() == 1
                && input
                    .get("skillBundles")
                    .is_some_and(|bundles| bundles.is_array())
        }
        "skills.updateBatchState" => {
            target.len() == 1
                && target.get("kind") == Some(&json!("skill"))
                && input
                    .get("skillKeys")
                    .and_then(Value::as_array)
                    .is_some_and(|keys| {
                        !keys.is_empty()
                            && keys
                                .iter()
                                .all(|key| key.as_str().is_some_and(valid_openclaw_skill_key))
                    })
                && input.get("enabled").is_some_and(Value::is_boolean)
                && input.len() == 2
        }
        "skills.updateConfig" => {
            skill_target_matches_input(target, input)
                && input.contains_key("apiKey")
                && input.contains_key("env")
                && input.len() == 3
        }
        "skills.updateState" => {
            skill_target_matches_input(target, input)
                && input.get("enabled").is_some_and(Value::is_boolean)
                && input.len() == 2
        }
        "clawhub.openReadme" | "clawhub.openPath" => {
            skill_target_matches_input(target, input)
                && input
                    .get("slug")
                    .is_none_or(|value| value.as_str().is_some_and(valid_openclaw_skill_key))
                && input
                    .get("filePath")
                    .is_none_or(|value| value.as_str().is_some_and(valid_skill_manifest_path))
                && input
                    .get("baseDir")
                    .is_none_or(|value| value.as_str().is_some_and(valid_skill_base_dir))
                && input
                    .keys()
                    .all(|key| matches!(key.as_str(), "skillKey" | "slug" | "filePath" | "baseDir"))
        }
        _ => false,
    }
}

pub fn decode_skill_bundles(input: &Value) -> Option<Vec<bundle::Bundle>> {
    let bundles = input.get("skillBundles")?.as_array()?;
    if bundles.is_empty() {
        return None;
    }
    let mut decoded = Vec::with_capacity(bundles.len());
    for bundle in bundles {
        let object = bundle.as_object()?;
        if object.len() != 2 {
            return None;
        }
        let skill_key = object.get("skillKey")?.as_str()?.to_owned();
        let files = object.get("files")?.as_array()?;
        let mut decoded_files = Vec::with_capacity(files.len());
        for file in files {
            let file = file.as_object()?;
            if file.len() != 2 {
                return None;
            }
            decoded_files.push(
                bundle::BundleFile::try_new(
                    file.get("path")?.as_str()?.to_owned(),
                    file.get("content")?.as_str()?.to_owned(),
                )
                .ok()?,
            );
        }
        decoded.push(bundle::Bundle::try_new(skill_key, decoded_files).ok()?);
    }
    bundle::validate_batch(&decoded).ok()?;
    Some(decoded)
}

async fn dispatch_management_request(
    skills: &crate::SkillsModule,
    request: ManagementRequest,
) -> ManagementOutcome {
    match request {
        ManagementRequest::UpdateConfig(command) | ManagementRequest::UpdateState(command) => {
            skill_management_outcome(skills.manage_skills(command).await)
        }
        ManagementRequest::UpdateBatchState {
            commands,
            skill_keys,
            enabled,
        } => {
            let mut outcome = ManagementOutcome::Succeeded(
                json!({ "success": true, "updated": skill_keys, "enabled": enabled }),
            );
            for command in commands {
                outcome = skill_management_outcome(skills.manage_skills(command).await);
                if !matches!(outcome, ManagementOutcome::Succeeded(_)) {
                    return outcome;
                }
            }
            outcome
        }
        ManagementRequest::RefreshStatus => skill_status_outcome(skills.skill_status().await),
        ManagementRequest::ExportBundles(command) => match skills.skill_bundles(command).await {
            Ok(bundle::Outcome::Exported(bundles)) => ManagementOutcome::Succeeded(json!({
                "skillBundles": bundles.iter().map(|bundle| json!({
                    "skillKey": bundle.skill_key(),
                    "files": bundle.files().iter().map(|file| json!({
                        "path": file.path(),
                        "content": file.content()
                    })).collect::<Vec<_>>()
                })).collect::<Vec<_>>()
            })),
            Ok(bundle::Outcome::Rejected) => {
                ManagementOutcome::Rejected("Skill bundle export was rejected.")
            }
            Ok(bundle::Outcome::Unknown) | Ok(bundle::Outcome::Accepted) => {
                ManagementOutcome::Rejected("Skill bundle export outcome is unknown.")
            }
            Err(_) => ManagementOutcome::Unavailable,
        },
        ManagementRequest::ImportBundles(command) => match skills.skill_bundles(command).await {
            Ok(bundle::Outcome::Accepted) => ManagementOutcome::Succeeded(json!({ "ok": true })),
            Ok(bundle::Outcome::Rejected) => {
                ManagementOutcome::Rejected("Skill bundle import was rejected.")
            }
            Ok(bundle::Outcome::Unknown) => {
                ManagementOutcome::Unknown(json!({ "outcome": "unknown" }))
            }
            Ok(bundle::Outcome::Exported(_)) => ManagementOutcome::InternalError,
            Err(_) => ManagementOutcome::Unavailable,
        },
        ManagementRequest::OpenReadme(command) => match skills.manage_skills(command).await {
            Ok(management::Outcome::Readme(Ok(receipt))) => ManagementOutcome::Succeeded(json!({
                "success": true,
                "content": receipt.content,
                "filePath": receipt.file_path,
            })),
            Ok(management::Outcome::Readme(Err(_))) | Ok(management::Outcome::Rejected) => {
                ManagementOutcome::Rejected("Skill path receipt was rejected.")
            }
            Ok(management::Outcome::Unavailable) | Err(_) => ManagementOutcome::Unavailable,
            _ => ManagementOutcome::InternalError,
        },
        ManagementRequest::OpenPath(command) => match skills.manage_skills(command).await {
            Ok(management::Outcome::OpenPath(Ok(_))) => {
                ManagementOutcome::Succeeded(json!({ "success": true }))
            }
            Ok(management::Outcome::OpenPath(Err(_))) | Ok(management::Outcome::Rejected) => {
                ManagementOutcome::Rejected("Skill path receipt was rejected.")
            }
            Ok(management::Outcome::Unavailable) | Err(_) => ManagementOutcome::Unavailable,
            _ => ManagementOutcome::InternalError,
        },
    }
}

fn skill_management_outcome(result: Result<management::Outcome, ()>) -> ManagementOutcome {
    match result {
        Ok(management::Outcome::Mutation(management::MutationOutcome::Accepted))
        | Ok(management::Outcome::Import(management::ImportOutcome::Accepted)) => {
            ManagementOutcome::Succeeded(json!({ "success": true }))
        }
        Ok(management::Outcome::Mutation(management::MutationOutcome::Rejected))
        | Ok(management::Outcome::Rejected) => {
            ManagementOutcome::Rejected("Skill mutation was rejected.")
        }
        Ok(management::Outcome::Mutation(management::MutationOutcome::Unknown))
        | Ok(management::Outcome::Import(management::ImportOutcome::Unknown)) => {
            ManagementOutcome::Unknown(json!({ "outcome": "unknown" }))
        }
        Ok(management::Outcome::Unavailable) | Err(_) => ManagementOutcome::Unavailable,
        _ => ManagementOutcome::InternalError,
    }
}

fn skill_status_outcome(result: Result<status::Outcome, ()>) -> ManagementOutcome {
    match result {
        Ok(status::Outcome::Available(catalog)) => {
            ManagementOutcome::Succeeded(status::project(&catalog))
        }
        Ok(status::Outcome::Unavailable) | Err(_) => ManagementOutcome::Unavailable,
    }
}

fn management_request(
    operation_id: String,
    input: Value,
) -> Result<ManagementRequest, InvalidControlInput> {
    match operation_id.as_str() {
        "skills.updateConfig" => Ok(ManagementRequest::UpdateConfig(
            management::Command::config(
                skill_key(&input)?.to_owned(),
                None,
                input
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                input.get("env").and_then(Value::as_object).map(|env| {
                    env.iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|value| (key.clone(), value.to_owned()))
                        })
                        .collect::<BTreeMap<_, _>>()
                }),
            )?,
        )),
        "skills.updateState" => Ok(ManagementRequest::UpdateState(management::Command::config(
            skill_key(&input)?.to_owned(),
            Some(
                input
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or(InvalidControlInput)?,
            ),
            None,
            None,
        )?)),
        "skills.updateBatchState" => {
            let skill_keys = input
                .get("skillKeys")
                .and_then(Value::as_array)
                .ok_or(InvalidControlInput)?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            let enabled = input
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or(InvalidControlInput)?;
            if skill_keys.is_empty() || skill_keys.iter().any(|key| key.trim().is_empty()) {
                return Err(InvalidControlInput);
            }
            let mut commands = Vec::with_capacity(skill_keys.len());
            for skill_key in &skill_keys {
                commands.push(management::Command::config(
                    skill_key.clone(),
                    Some(enabled),
                    None,
                    None,
                )?);
            }
            Ok(ManagementRequest::UpdateBatchState {
                commands,
                skill_keys,
                enabled,
            })
        }
        "skills.refreshStatus" => Ok(ManagementRequest::RefreshStatus),
        "skills.exportBundles" => Ok(ManagementRequest::ExportBundles(bundle::Command::Export {
            skill_keys: input
                .get("skillKeys")
                .and_then(Value::as_array)
                .ok_or(InvalidControlInput)?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        })),
        "skills.importBundles" => Ok(ManagementRequest::ImportBundles(bundle::Command::Import {
            bundles: decode_skill_bundles(&input).ok_or(InvalidControlInput)?,
        })),
        "clawhub.openReadme" => Ok(ManagementRequest::OpenReadme(
            management::Command::open_readme(
                skill_key(&input)?.to_owned(),
                input.get("slug").and_then(Value::as_str).map(str::to_owned),
                input
                    .get("filePath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                input
                    .get("baseDir")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            )?,
        )),
        "clawhub.openPath" => Ok(ManagementRequest::OpenPath(management::Command::open_path(
            skill_key(&input)?.to_owned(),
            input.get("slug").and_then(Value::as_str).map(str::to_owned),
            input
                .get("filePath")
                .and_then(Value::as_str)
                .map(str::to_owned),
            input
                .get("baseDir")
                .and_then(Value::as_str)
                .map(str::to_owned),
        )?)),
        _ => Err(InvalidControlInput),
    }
}

fn skill_key(input: &Value) -> Result<&str, InvalidControlInput> {
    input
        .get("skillKey")
        .and_then(Value::as_str)
        .ok_or(InvalidControlInput)
}

fn skill_target_matches_input(
    target: &serde_json::Map<String, Value>,
    input: &serde_json::Map<String, Value>,
) -> bool {
    let Some(target) = decode_skill_target(target) else {
        return false;
    };
    input.get("skillKey").and_then(Value::as_str) == Some(target.id)
        && input
            .get("slug")
            .is_none_or(|value| value.as_str().is_some_and(|slug| target.slug == Some(slug)))
}

fn decode_skill_target(target: &serde_json::Map<String, Value>) -> Option<SkillTarget<'_>> {
    if target
        .keys()
        .any(|key| !matches!(key.as_str(), "kind" | "skillId" | "slug"))
    {
        return None;
    }
    if target.get("kind").and_then(Value::as_str) != Some("skill") {
        return None;
    }
    let id = target.get("skillId").and_then(Value::as_str)?;
    if !valid_openclaw_skill_key(id) {
        return None;
    }
    let slug = match target.get("slug").and_then(Value::as_str) {
        Some(slug) if valid_openclaw_skill_key(slug) => Some(slug),
        Some(_) => return None,
        None => None,
    };
    Some(SkillTarget { id, slug })
}

fn skill_keys_input(input: &serde_json::Map<String, Value>) -> bool {
    input.len() == 1
        && input
            .get("skillKeys")
            .and_then(Value::as_array)
            .is_some_and(|keys| {
                !keys.is_empty()
                    && keys
                        .iter()
                        .all(|key| key.as_str().is_some_and(valid_bundle_skill_key))
            })
}

fn valid_openclaw_skill_key(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
}

fn valid_skill_base_dir(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 4096
        && !value.contains('\0')
        && Path::new(value).is_absolute()
}

fn valid_skill_manifest_path(value: &str) -> bool {
    valid_skill_base_dir(value)
        && Path::new(value)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("SKILL.md"))
}

fn valid_bundle_skill_key(value: &str) -> bool {
    let value = value.trim();
    !value.is_empty()
        && value.len() <= 96
        && value
            .bytes()
            .enumerate()
            .all(|(index, byte)| byte.is_ascii_alphanumeric() || (index > 0 && byte == b'-'))
        && !value.ends_with('-')
}

fn decode<T: for<'de> Deserialize<'de>>(input: Value) -> Result<T, InvalidControlInput> {
    serde_json::from_value(input).map_err(|_| InvalidControlInput)
}

fn is_openclaw_runtime_scope(value: &Value) -> bool {
    let identity = runtime_directory::RuntimeDriverIdentity::open_claw();
    value
        == &json!({
            "kind": "runtime-instance",
            "endpoint": {
                "kind": "native-runtime",
                "runtimeAdapterId": identity.runtime_adapter_id(),
                "runtimeInstanceId": identity.runtime_instance_id(),
            },
        })
}
