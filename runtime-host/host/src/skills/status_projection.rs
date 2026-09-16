use serde_json::{Map, Value};

use super::status::{Catalog, Entry, RequirementCategory};

pub(crate) fn project(catalog: &Catalog) -> Value {
    let skills = catalog
        .entries
        .iter()
        .filter(|entry| is_displayable_skill(entry))
        .map(project_entry)
        .collect();
    let mut value = Map::new();
    value.insert("skills".into(), Value::Array(skills));
    Value::Object(value)
}

fn is_displayable_skill(entry: &Entry) -> bool {
    !entry.blocked_by_allowlist && !(entry.bundled == Some(true) && !entry.eligible)
}

fn project_entry(entry: &Entry) -> Value {
    let mut value = Map::new();
    value.insert("key".into(), Value::String(entry.key.clone()));
    value.insert("name".into(), Value::String(entry.name.clone()));
    value.insert(
        "description".into(),
        Value::String(entry.description.clone()),
    );
    value.insert("enabled".into(), Value::Bool(entry.enabled));
    value.insert("selectable".into(), Value::Bool(entry.selectable));
    value.insert(
        "unavailableReason".into(),
        optional_str(unavailable_reason(entry)),
    );
    value.insert(
        "missingCategories".into(),
        Value::Array(
            entry
                .missing_categories
                .iter()
                .map(|category| Value::String(category_name(*category).into()))
                .collect(),
        ),
    );
    value.insert("eligible".into(), Value::Bool(entry.eligible));
    insert_optional_bool(&mut value, "bundled", entry.bundled);
    insert_optional_bool(&mut value, "always", entry.always);
    insert_optional_string(&mut value, "emoji", &entry.emoji);
    insert_optional_string(&mut value, "slug", &entry.slug);
    insert_optional_string(&mut value, "source", &entry.source);
    insert_optional_string(&mut value, "baseDir", &entry.base_dir);
    insert_optional_string(&mut value, "filePath", &entry.file_path);
    Value::Object(value)
}

fn unavailable_reason(entry: &Entry) -> Option<&'static str> {
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

fn optional_str(value: Option<&'static str>) -> Value {
    value.map_or(Value::Null, |value| Value::String(value.into()))
}

fn insert_optional_bool(value: &mut Map<String, Value>, field: &str, item: Option<bool>) {
    if let Some(item) = item {
        value.insert(field.into(), Value::Bool(item));
    }
}

fn insert_optional_string(value: &mut Map<String, Value>, field: &str, item: &Option<String>) {
    if let Some(item) = item {
        value.insert(field.into(), Value::String(item.clone()));
    }
}

fn category_name(category: RequirementCategory) -> &'static str {
    match category {
        RequirementCategory::Binaries => "binaries",
        RequirementCategory::AnyBinaries => "anyBinaries",
        RequirementCategory::Environment => "environment",
        RequirementCategory::Configuration => "configuration",
        RequirementCategory::OperatingSystem => "operatingSystem",
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn project_preserves_raw_key_and_native_transport_status_fields_with_paths() {
        let projected = project(&Catalog {
            entries: vec![Entry {
                key: "Excel XLSX".into(),
                slug: Some("excel-xlsx".into()),
                name: "Excel XLSX".into(),
                description: "Spreadsheet work".into(),
                enabled: true,
                selectable: false,
                eligible: true,
                blocked_by_allowlist: false,
                bundled: Some(false),
                always: Some(false),
                emoji: Some("📊".into()),
                source: Some("bundled".into()),
                base_dir: Some("C:\\skills\\Excel XLSX".into()),
                file_path: Some("C:\\skills\\Excel XLSX\\SKILL.md".into()),
                missing_categories: vec![
                    RequirementCategory::Environment,
                    RequirementCategory::Configuration,
                ],
            }],
        });
        assert_eq!(
            projected,
            json!({
                "skills": [{
                    "key": "Excel XLSX",
                    "slug": "excel-xlsx",
                    "name": "Excel XLSX",
                    "description": "Spreadsheet work",
                    "enabled": true,
                    "selectable": false,
                    "unavailableReason": "missingRequirements",
                    "missingCategories": ["environment", "configuration"],
                    "eligible": true,
                    "bundled": false,
                    "always": false,
                    "emoji": "📊",
                    "source": "bundled",
                    "baseDir": "C:\\skills\\Excel XLSX",
                    "filePath": "C:\\skills\\Excel XLSX\\SKILL.md"
                }]
            })
        );
    }

    #[test]
    fn project_keeps_unbundled_ineligible_entries() {
        assert_eq!(
            project(&Catalog {
                entries: vec![Entry {
                    key: "ineligible-extra".into(),
                    slug: None,
                    name: "Ineligible Extra".into(),
                    description: String::new(),
                    enabled: true,
                    selectable: false,
                    eligible: false,
                    blocked_by_allowlist: false,
                    bundled: Some(false),
                    always: None,
                    emoji: None,
                    source: None,
                    base_dir: None,
                    file_path: None,
                    missing_categories: Vec::new(),
                }],
            }),
            json!({"skills": [{
                "key": "ineligible-extra",
                "name": "Ineligible Extra",
                "description": "",
                "enabled": true,
                "selectable": false,
                "unavailableReason": "ineligible",
                "missingCategories": [],
                "eligible": false,
                "bundled": false
            }]})
        );
    }

    #[test]
    fn project_ignores_agent_filter_blocks_and_hides_allowlist_blocks() {
        assert_eq!(
            project(&Catalog {
                entries: vec![
                    Entry {
                        key: "allowlist-blocked".into(),
                        slug: None,
                        name: "Allowlist Blocked".into(),
                        description: String::new(),
                        enabled: true,
                        selectable: false,
                        eligible: true,
                        blocked_by_allowlist: true,
                        bundled: None,
                        always: None,
                        emoji: None,
                        source: None,
                        base_dir: None,
                        file_path: None,
                        missing_categories: Vec::new(),
                    },
                    Entry {
                        key: "agent-filtered".into(),
                        slug: None,
                        name: "Agent Filtered".into(),
                        description: String::new(),
                        enabled: true,
                        selectable: false,
                        eligible: true,
                        blocked_by_allowlist: false,
                        bundled: None,
                        always: None,
                        emoji: None,
                        source: None,
                        base_dir: None,
                        file_path: None,
                        missing_categories: vec![RequirementCategory::OperatingSystem],
                    },
                ],
            }),
            json!({
                "skills": [{
                    "key": "agent-filtered",
                    "name": "Agent Filtered",
                    "description": "",
                    "enabled": true,
                    "selectable": false,
                    "unavailableReason": "missingRequirements",
                    "missingCategories": ["operatingSystem"],
                    "eligible": true
                }]
            })
        );
    }
}
