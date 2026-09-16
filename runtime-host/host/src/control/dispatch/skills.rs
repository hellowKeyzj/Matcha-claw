use std::path::Path;

use serde_json::{Value, json};

use crate::facade::SkillsHandle;

use super::{
    CapabilityExecuteRequest, CommandInput, CommandOutcome, CommandResult, RejectionCode, decode,
    internal_error, invalid_input, is_native_runtime_scope, unavailable,
};

pub(super) async fn openclaw_skills_execute(
    skills: &SkillsHandle,
    input: CommandInput,
) -> CommandOutcome {
    let request = match decode::<CapabilityExecuteRequest>(input) {
        Ok(request) if request.id == "skill.management" => request,
        _ => return invalid_input(),
    };
    if !is_native_runtime_scope(&request.scope)
        || !is_skill_capability_request(&request.operation_id, &request.target, &request.input)
    {
        return invalid_input();
    }
    dispatch_skill_operation(skills, request.operation_id, request.target, request.input).await
}

pub(super) fn is_skill_capability_request(operation: &str, target: &Value, input: &Value) -> bool {
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

struct SkillTarget<'a> {
    id: &'a str,
    slug: Option<&'a str>,
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

async fn dispatch_skill_operation(
    skills: &SkillsHandle,
    operation_id: String,
    target: Value,
    input: Value,
) -> CommandOutcome {
    match operation_id.as_str() {
        "skills.updateConfig" => {
            let Some(skill_key) = input.get("skillKey").and_then(Value::as_str) else {
                return invalid_input();
            };
            let command = match crate::skills::management::Command::config(
                skill_key.to_owned(),
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
                        .collect()
                }),
            ) {
                Ok(command) => command,
                Err(_) => return invalid_input(),
            };
            skill_management_outcome(skills.manage_skills(command).await)
        }
        "skills.updateState" => {
            let Some(skill_key) = input.get("skillKey").and_then(Value::as_str) else {
                return invalid_input();
            };
            let Some(enabled) = input.get("enabled").and_then(Value::as_bool) else {
                return invalid_input();
            };
            let command = match crate::skills::management::Command::config(
                skill_key.to_owned(),
                Some(enabled),
                None,
                None,
            ) {
                Ok(command) => command,
                Err(_) => return invalid_input(),
            };
            skill_management_outcome(skills.manage_skills(command).await)
        }
        "skills.updateBatchState" => {
            let Some(skill_keys) = input
                .get("skillKeys")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
            else {
                return invalid_input();
            };
            let Some(enabled) = input.get("enabled").and_then(Value::as_bool) else {
                return invalid_input();
            };
            if skill_keys.is_empty() || skill_keys.iter().any(|key| key.trim().is_empty()) {
                return invalid_input();
            }
            let mut outcome = CommandOutcome::succeeded(CommandResult::private(
                json!({ "success": true, "updated": skill_keys, "enabled": enabled }),
            ));
            for skill_key in skill_keys {
                let command = match crate::skills::management::Command::config(
                    skill_key,
                    Some(enabled),
                    None,
                    None,
                ) {
                    Ok(command) => command,
                    Err(_) => return invalid_input(),
                };
                outcome = skill_management_outcome(skills.manage_skills(command).await);
                if !matches!(outcome, CommandOutcome::Succeeded { .. }) {
                    return outcome;
                }
            }
            outcome
        }
        "skills.refreshStatus" => skill_status_outcome(skills.skill_status().await),
        "skills.exportBundles" => {
            let Some(skill_keys) = input
                .get("skillKeys")
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
            else {
                return invalid_input();
            };
            match skills
                .skill_bundles(crate::skills::bundle::Command::Export { skill_keys })
                .await
            {
                Ok(crate::skills::bundle::Outcome::Exported(bundles)) => {
                    CommandOutcome::succeeded(CommandResult::private(
                        json!({ "skillBundles": bundles.iter().map(|bundle| json!({ "skillKey": bundle.skill_key(), "files": bundle.files().iter().map(|file| json!({ "path": file.path(), "content": file.content() })).collect::<Vec<_>>() })).collect::<Vec<_>>() }),
                    ))
                }
                Ok(crate::skills::bundle::Outcome::Rejected) => CommandOutcome::rejected(
                    RejectionCode::Failed,
                    "Skill bundle export was rejected.",
                ),
                Ok(crate::skills::bundle::Outcome::Unknown)
                | Ok(crate::skills::bundle::Outcome::Accepted) => CommandOutcome::rejected(
                    RejectionCode::Failed,
                    "Skill bundle export outcome is unknown.",
                ),
                Err(_) => unavailable(),
            }
        }
        "skills.importBundles" => {
            let Some(bundles) = decode_skill_bundles(&input) else {
                return invalid_input();
            };
            match skills
                .skill_bundles(crate::skills::bundle::Command::Import { bundles })
                .await
            {
                Ok(crate::skills::bundle::Outcome::Accepted) => {
                    CommandOutcome::succeeded(CommandResult::private(json!({ "ok": true })))
                }
                Ok(crate::skills::bundle::Outcome::Rejected) => CommandOutcome::rejected(
                    RejectionCode::Failed,
                    "Skill bundle import was rejected.",
                ),
                Ok(crate::skills::bundle::Outcome::Unknown) => {
                    CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "unknown" })))
                }
                Ok(crate::skills::bundle::Outcome::Exported(_)) => internal_error(),
                Err(_) => unavailable(),
            }
        }
        "clawhub.openReadme" => {
            let Some(skill_key) = input.get("skillKey").and_then(Value::as_str) else {
                return invalid_input();
            };
            let command = match crate::skills::management::Command::open_readme(
                skill_key.to_owned(),
                input.get("slug").and_then(Value::as_str).map(str::to_owned),
                input
                    .get("filePath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                input
                    .get("baseDir")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ) {
                Ok(command) => command,
                Err(_) => return invalid_input(),
            };
            match skills.manage_skills(command).await {
                Ok(crate::skills::management::Outcome::Readme(Ok(receipt))) => {
                    CommandOutcome::succeeded(CommandResult::private(json!({
                        "success": true,
                        "content": receipt.content,
                        "filePath": receipt.file_path,
                    })))
                }
                Ok(crate::skills::management::Outcome::Readme(Err(_)))
                | Ok(crate::skills::management::Outcome::Rejected) => CommandOutcome::rejected(
                    RejectionCode::Failed,
                    "Skill path receipt was rejected.",
                ),
                Ok(crate::skills::management::Outcome::Unavailable) | Err(_) => unavailable(),
                _ => internal_error(),
            }
        }
        "clawhub.openPath" => {
            let Some(skill_key) = input.get("skillKey").and_then(Value::as_str) else {
                return invalid_input();
            };
            let command = match crate::skills::management::Command::open_path(
                skill_key.to_owned(),
                input.get("slug").and_then(Value::as_str).map(str::to_owned),
                input
                    .get("filePath")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
                input
                    .get("baseDir")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            ) {
                Ok(command) => command,
                Err(_) => return invalid_input(),
            };
            match skills.manage_skills(command).await {
                Ok(crate::skills::management::Outcome::OpenPath(Ok(_))) => {
                    CommandOutcome::succeeded(CommandResult::private(json!({ "success": true })))
                }
                Ok(crate::skills::management::Outcome::OpenPath(Err(_)))
                | Ok(crate::skills::management::Outcome::Rejected) => CommandOutcome::rejected(
                    RejectionCode::Failed,
                    "Skill path receipt was rejected.",
                ),
                Ok(crate::skills::management::Outcome::Unavailable) | Err(_) => unavailable(),
                _ => internal_error(),
            }
        }
        _ => {
            let _ = target;
            invalid_input()
        }
    }
}

pub(super) fn decode_skill_bundles(input: &Value) -> Option<Vec<crate::skills::bundle::Bundle>> {
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
                crate::skills::bundle::BundleFile::try_new(
                    file.get("path")?.as_str()?.to_owned(),
                    file.get("content")?.as_str()?.to_owned(),
                )
                .ok()?,
            );
        }
        decoded.push(crate::skills::bundle::Bundle::try_new(skill_key, decoded_files).ok()?);
    }
    crate::skills::bundle::validate_batch(&decoded).ok()?;
    Some(decoded)
}

fn skill_management_outcome(
    result: Result<crate::skills::management::Outcome, ()>,
) -> CommandOutcome {
    match result {
        Ok(crate::skills::management::Outcome::Mutation(
            crate::skills::management::MutationOutcome::Accepted,
        ))
        | Ok(crate::skills::management::Outcome::Import(
            crate::skills::management::ImportOutcome::Accepted,
        )) => CommandOutcome::succeeded(CommandResult::private(json!({ "success": true }))),
        Ok(crate::skills::management::Outcome::Mutation(
            crate::skills::management::MutationOutcome::Rejected,
        ))
        | Ok(crate::skills::management::Outcome::Rejected) => {
            CommandOutcome::rejected(RejectionCode::Failed, "Skill mutation was rejected.")
        }
        Ok(crate::skills::management::Outcome::Mutation(
            crate::skills::management::MutationOutcome::Unknown,
        ))
        | Ok(crate::skills::management::Outcome::Import(
            crate::skills::management::ImportOutcome::Unknown,
        )) => CommandOutcome::unknown(CommandResult::private(json!({ "outcome": "unknown" }))),
        Ok(crate::skills::management::Outcome::Unavailable) | Err(_) => unavailable(),
        _ => internal_error(),
    }
}

fn skill_status_outcome(result: Result<crate::skills::status::Outcome, ()>) -> CommandOutcome {
    match result {
        Ok(crate::skills::status::Outcome::Available(catalog)) => {
            CommandOutcome::succeeded(CommandResult::private(skill_status_json(&catalog)))
        }
        Ok(crate::skills::status::Outcome::Unavailable) | Err(_) => unavailable(),
    }
}

pub(super) fn skill_status_json(catalog: &crate::skills::status::Catalog) -> Value {
    let skills = catalog
        .entries
        .iter()
        .filter(|entry| {
            !entry.blocked_by_allowlist && !(entry.bundled == Some(true) && !entry.eligible)
        })
        .map(skill_status_entry_json)
        .collect::<Vec<_>>();
    json!({ "skills": skills })
}

fn skill_status_entry_json(entry: &crate::skills::status::Entry) -> Value {
    let mut value = serde_json::Map::new();
    value.insert("key".into(), json!(&entry.key));
    value.insert("name".into(), json!(&entry.name));
    value.insert("description".into(), json!(&entry.description));
    value.insert("enabled".into(), json!(entry.enabled));
    value.insert("selectable".into(), json!(entry.selectable));
    value.insert(
        "unavailableReason".into(),
        skill_unavailable_reason(entry).map_or(Value::Null, |reason| json!(reason)),
    );
    value.insert(
        "missingCategories".into(),
        json!(
            entry
                .missing_categories
                .iter()
                .map(|category| skill_requirement_category_name(*category))
                .collect::<Vec<_>>()
        ),
    );
    value.insert("eligible".into(), json!(entry.eligible));
    if let Some(bundled) = entry.bundled {
        value.insert("bundled".into(), json!(bundled));
    }
    if let Some(always) = entry.always {
        value.insert("always".into(), json!(always));
    }
    if let Some(emoji) = &entry.emoji {
        value.insert("emoji".into(), json!(emoji));
    }
    if let Some(slug) = &entry.slug {
        value.insert("slug".into(), json!(slug));
    }
    if let Some(source) = &entry.source {
        value.insert("source".into(), json!(source));
    }
    if let Some(base_dir) = &entry.base_dir {
        value.insert("baseDir".into(), json!(base_dir));
    }
    if let Some(file_path) = &entry.file_path {
        value.insert("filePath".into(), json!(file_path));
    }
    Value::Object(value)
}

fn skill_unavailable_reason(entry: &crate::skills::status::Entry) -> Option<&'static str> {
    if !entry.enabled {
        Some("disabled")
    } else if !entry.missing_categories.is_empty() {
        Some("missingRequirements")
    } else if !entry.eligible {
        Some("ineligible")
    } else {
        None
    }
}

fn skill_requirement_category_name(
    category: crate::skills::status::RequirementCategory,
) -> &'static str {
    match category {
        crate::skills::status::RequirementCategory::Binaries => "binaries",
        crate::skills::status::RequirementCategory::AnyBinaries => "anyBinaries",
        crate::skills::status::RequirementCategory::Environment => "environment",
        crate::skills::status::RequirementCategory::Configuration => "configuration",
        crate::skills::status::RequirementCategory::OperatingSystem => "operatingSystem",
    }
}
