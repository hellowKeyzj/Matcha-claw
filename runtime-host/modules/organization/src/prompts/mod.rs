mod preview;

use std::{collections::BTreeMap, sync::OnceLock};

pub use preview::preview;

pub const MAX_FIELD_BYTES: usize = 64 * 1024;
pub const MAX_TOTAL_BYTES: usize = 512 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamPromptSettings {
    pub revision: u64,
    pub values: BTreeMap<String, String>,
}

impl Default for TeamPromptSettings {
    fn default() -> Self {
        Self {
            revision: 0,
            values: defaults().clone(),
        }
    }
}

impl TeamPromptSettings {
    pub(crate) fn text(&self, key: &str) -> &str {
        self.values.get(key).expect("validated team prompt key")
    }

    pub(crate) fn render(&self, key: &str, slots: &[(&str, &str)]) -> String {
        let mut remaining = self.text(key);
        let mut rendered = String::with_capacity(remaining.len());
        while let Some((before, after)) = remaining.split_once("{{") {
            rendered.push_str(before);
            let (name, after) = after.split_once("}}").expect("validated team prompt slot");
            let (_, value) = slots
                .iter()
                .find(|(slot, _)| *slot == name)
                .expect("team prompt slot supplied by composer");
            rendered.push_str(value);
            remaining = after;
        }
        rendered.push_str(remaining);
        rendered
    }
}

pub fn defaults() -> &'static BTreeMap<String, String> {
    static DEFAULTS: OnceLock<BTreeMap<String, String>> = OnceLock::new();
    DEFAULTS.get_or_init(|| {
        serde_json::from_str(include_str!("defaults.json")).expect("team prompt defaults catalog")
    })
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptValidationError {
    pub key: String,
    pub code: String,
}

impl PromptValidationError {
    fn new(key: &str, code: &str) -> Self {
        Self {
            key: key.to_owned(),
            code: code.to_owned(),
        }
    }
}

pub fn validate_values(values: &BTreeMap<String, String>) -> Result<(), PromptValidationError> {
    for key in values.keys() {
        if !defaults().contains_key(key) {
            return Err(PromptValidationError::new(key, "unknown_key"));
        }
    }
    let mut total = 0;
    for (key, default) in defaults() {
        let value = values
            .get(key)
            .ok_or_else(|| PromptValidationError::new(key, "missing_key"))?;
        if value.trim().is_empty() {
            return Err(PromptValidationError::new(key, "empty"));
        }
        if value.len() > MAX_FIELD_BYTES {
            return Err(PromptValidationError::new(key, "field_too_large"));
        }
        total += value.len();
        if total > MAX_TOTAL_BYTES {
            return Err(PromptValidationError::new("", "total_too_large"));
        }
        if slot_counts(value)
            .is_none_or(|slots| slots != slot_counts(default).expect("catalog slots"))
        {
            return Err(PromptValidationError::new(key, "invalid_slots"));
        }
    }
    Ok(())
}

fn slot_counts(mut text: &str) -> Option<BTreeMap<&str, usize>> {
    let mut counts = BTreeMap::new();
    while let Some((before, after)) = text.split_once("{{") {
        if before.contains("}}") {
            return None;
        }
        let (name, after) = after.split_once("}}")?;
        if name.is_empty() || name.contains(['{', '}']) {
            return None;
        }
        *counts.entry(name).or_default() += 1;
        text = after;
    }
    (!text.contains("}}")).then_some(counts)
}
