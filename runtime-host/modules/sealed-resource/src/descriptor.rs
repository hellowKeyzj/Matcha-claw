use serde::Deserialize;

const MAX_DESCRIPTOR_NAME_BYTES: usize = 256;
const MAX_DESCRIPTOR_DESCRIPTION_BYTES: usize = 8 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SealedSkillDescriptor {
    name: String,
    description: String,
    user_invocable: Option<bool>,
    disable_model_invocation: Option<bool>,
}

impl SealedSkillDescriptor {
    pub(crate) fn try_new(
        name: impl Into<String>,
        description: impl Into<String>,
        user_invocable: Option<bool>,
        disable_model_invocation: Option<bool>,
    ) -> Result<Self, ()> {
        let name = clean_text(Some(name.into()), MAX_DESCRIPTOR_NAME_BYTES).ok_or(())?;
        let description =
            clean_text(Some(description.into()), MAX_DESCRIPTOR_DESCRIPTION_BYTES).ok_or(())?;
        Ok(Self {
            name,
            description,
            user_invocable,
            disable_model_invocation,
        })
    }

    pub fn parse_skill_manifest(content: &str) -> Result<Self, ()> {
        let frontmatter = manifest_frontmatter(content).ok_or(())?;
        let wire: DescriptorFrontmatter = serde_yaml::from_str(frontmatter).map_err(|_| ())?;
        Self::try_new(
            wire.name.ok_or(())?,
            wire.description.ok_or(())?,
            wire.user_invocable,
            wire.disable_model_invocation,
        )
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
    #[serde(rename = "user-invocable")]
    user_invocable: Option<bool>,
    #[serde(rename = "disable-model-invocation")]
    disable_model_invocation: Option<bool>,
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

fn clean_text(value: Option<String>, max_bytes: usize) -> Option<String> {
    let value = value?.trim().to_owned();
    (!value.is_empty() && value.len() <= max_bytes && !value.contains('\0')).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_yaml_block_scalar_description() {
        let descriptor = SealedSkillDescriptor::parse_skill_manifest(
            "---\nname: llm-wiki\ndescription: |\n  line one\n  line two\n---\n",
        )
        .unwrap();

        assert_eq!(descriptor.name(), "llm-wiki");
        assert_eq!(descriptor.description(), "line one\nline two");
    }

    #[test]
    fn parses_yaml_folded_scalar_description() {
        let descriptor = SealedSkillDescriptor::parse_skill_manifest(
            "---\nname: folded\ndescription: >\n  line one\n  line two\n---\n",
        )
        .unwrap();

        assert_eq!(descriptor.description(), "line one line two");
    }
}
