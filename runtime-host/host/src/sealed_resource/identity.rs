use std::fmt;

const MAX_KEY_BYTES: usize = 4096;

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct SkillKey(String);

impl SkillKey {
    pub fn parse(value: impl Into<String>) -> Result<Self, ()> {
        parse_key(value).map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn safe_directory_component(&self) -> Option<&str> {
        safe_directory_component(&self.0)
    }
}

impl fmt::Debug for SkillKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("SkillKey").field(&self.0).finish()
    }
}

#[derive(Clone, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct AgentKey(String);

impl AgentKey {
    pub fn parse(value: impl Into<String>) -> Result<Self, ()> {
        parse_key(value).map(Self)
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn safe_directory_component(&self) -> Option<&str> {
        safe_directory_component(&self.0)
    }
}

impl fmt::Debug for AgentKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_tuple("AgentKey").field(&self.0).finish()
    }
}

fn parse_key(value: impl Into<String>) -> Result<String, ()> {
    let value = value.into().trim().to_owned();
    if value.is_empty() || value.len() > MAX_KEY_BYTES || value.contains('\0') {
        return Err(());
    }
    Ok(value)
}

fn safe_directory_component(value: &str) -> Option<&str> {
    if value.is_empty()
        || value.contains('/')
        || value.contains('\\')
        || value == "."
        || value == ".."
        || value.split_once(':').is_some_and(|(prefix, _)| {
            prefix.len() == 1 && prefix.as_bytes()[0].is_ascii_alphabetic()
        })
    {
        return None;
    }
    Some(value)
}
