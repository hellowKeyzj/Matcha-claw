use serde_json::{Value, json};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Outcome {
    Available(Catalog),
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Catalog {
    pub(crate) entries: Vec<Entry>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct Entry {
    pub(crate) key: String,
    pub(crate) slug: Option<String>,
    pub(crate) name: String,
    pub(crate) description: String,
    pub(crate) enabled: bool,
    pub(crate) selectable: bool,
    pub(crate) eligible: bool,
    pub(crate) blocked_by_allowlist: bool,
    pub(crate) bundled: Option<bool>,
    pub(crate) always: Option<bool>,
    pub(crate) emoji: Option<String>,
    pub(crate) source: Option<String>,
    pub(crate) base_dir: Option<String>,
    pub(crate) file_path: Option<String>,
    pub(crate) missing_categories: Vec<RequirementCategory>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequirementCategory {
    Binaries,
    AnyBinaries,
    Environment,
    Configuration,
    OperatingSystem,
}

pub(crate) fn project(catalog: &Catalog) -> Value {
    json!({
        "skills": catalog.entries.iter().filter(|entry| is_displayable_skill(entry)).map(project_entry).collect::<Vec<_>>(),
    })
}

fn is_displayable_skill(entry: &Entry) -> bool {
    !entry.blocked_by_allowlist && !(entry.bundled == Some(true) && !entry.eligible)
}

fn project_entry(entry: &Entry) -> Value {
    let mut value = json!({
        "key": entry.key,
        "name": entry.name,
        "description": entry.description,
        "enabled": entry.enabled,
        "selectable": entry.selectable,
        "unavailableReason": unavailable_reason(entry),
        "missingCategories": project_missing_categories(&entry.missing_categories),
        "eligible": entry.eligible,
    });
    if let Some(bundled) = entry.bundled {
        value["bundled"] = json!(bundled);
    }
    if let Some(always) = entry.always {
        value["always"] = json!(always);
    }
    if let Some(emoji) = &entry.emoji {
        value["emoji"] = json!(emoji);
    }
    if let Some(source) = &entry.source {
        value["source"] = json!(source);
    }
    if let Some(slug) = &entry.slug {
        value["slug"] = json!(slug);
    }
    if let Some(base_dir) = &entry.base_dir {
        value["baseDir"] = json!(base_dir);
    }
    if let Some(file_path) = &entry.file_path {
        value["filePath"] = json!(file_path);
    }
    value
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

fn project_missing_categories(categories: &[RequirementCategory]) -> Vec<&'static str> {
    categories
        .iter()
        .map(|category| match category {
            RequirementCategory::Binaries => "binaries",
            RequirementCategory::AnyBinaries => "anyBinaries",
            RequirementCategory::Environment => "environment",
            RequirementCategory::Configuration => "configuration",
            RequirementCategory::OperatingSystem => "operatingSystem",
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_preserves_raw_key_and_native_transport_status_fields() {
        assert_eq!(
            project(&Catalog {
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
                    source: Some("openclaw-bundled".into()),
                    base_dir: Some("C:\\skills\\Excel XLSX".into()),
                    file_path: Some("C:\\skills\\Excel XLSX\\SKILL.md".into()),
                    missing_categories: vec![
                        RequirementCategory::Environment,
                        RequirementCategory::Configuration,
                    ],
                }],
            }),
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
                    "source": "openclaw-bundled",
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
