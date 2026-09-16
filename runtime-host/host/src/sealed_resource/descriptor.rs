use serde::Deserialize;

const MAX_DESCRIPTOR_NAME_BYTES: usize = 256;
const MAX_DESCRIPTOR_DESCRIPTION_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SealedSkillDescriptor {
    name: String,
    description: String,
    user_invocable: Option<bool>,
    disable_model_invocation: Option<bool>,
}

impl SealedSkillDescriptor {
    pub fn parse_skill_manifest(content: &str) -> Result<Self, ()> {
        let frontmatter = manifest_frontmatter(content).ok_or(())?;
        let wire = DescriptorFrontmatter::parse(frontmatter);
        let name = clean_text(wire.name, MAX_DESCRIPTOR_NAME_BYTES).ok_or(())?;
        let description =
            clean_text(wire.description, MAX_DESCRIPTOR_DESCRIPTION_BYTES).ok_or(())?;
        Ok(Self {
            name,
            description,
            user_invocable: wire.user_invocable,
            disable_model_invocation: wire.disable_model_invocation,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn description(&self) -> &str {
        &self.description
    }

    pub fn user_invocable(&self) -> Option<bool> {
        self.user_invocable
    }

    pub fn disable_model_invocation(&self) -> Option<bool> {
        self.disable_model_invocation
    }
}

#[derive(Deserialize)]
struct DescriptorFrontmatter {
    name: Option<String>,
    description: Option<String>,
    user_invocable: Option<bool>,
    disable_model_invocation: Option<bool>,
}

impl DescriptorFrontmatter {
    fn parse(frontmatter: &str) -> Self {
        let mut name = None;
        let mut description = None;
        let mut user_invocable = None;
        let mut disable_model_invocation = None;
        for line in frontmatter.lines() {
            if name.is_none() {
                name = field_value(line, "name");
            }
            if description.is_none() {
                description = field_value(line, "description");
            }
            if user_invocable.is_none() {
                user_invocable = field_value(line, "user-invocable").and_then(parse_bool);
            }
            if disable_model_invocation.is_none() {
                disable_model_invocation =
                    field_value(line, "disable-model-invocation").and_then(parse_bool);
            }
        }
        Self {
            name,
            description,
            user_invocable,
            disable_model_invocation,
        }
    }
}

fn manifest_frontmatter(content: &str) -> Option<&str> {
    content
        .strip_prefix("---\n")
        .or_else(|| content.strip_prefix("---\r\n"))
        .and_then(|content| {
            content
                .split_once("\n---")
                .or_else(|| content.split_once("\r\n---"))
        })
        .map(|(frontmatter, _)| frontmatter)
}

fn field_value(line: &str, field: &str) -> Option<String> {
    line.strip_prefix(field)
        .and_then(|rest| rest.strip_prefix(':'))
        .map(|value| value.trim().trim_matches(['\'', '"']).to_owned())
}

fn clean_text(value: Option<String>, max_bytes: usize) -> Option<String> {
    let value = value?.trim().to_owned();
    (!value.is_empty() && value.len() <= max_bytes && !value.contains('\0')).then_some(value)
}

fn parse_bool(value: String) -> Option<bool> {
    match value.trim() {
        "true" => Some(true),
        "false" => Some(false),
        _ => None,
    }
}
