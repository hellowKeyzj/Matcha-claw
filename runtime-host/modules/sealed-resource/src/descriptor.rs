mod frontmatter;

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

    pub fn parse_skill_manifest(content: &str, directory_name: &str) -> Result<Self, ()> {
        let fields = frontmatter::parse(content)?;
        let name = fields
            .get("name")
            .map(|value| frontmatter::trim(value))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| frontmatter::trim(directory_name));
        Self::try_new(
            name,
            fields.get("description").ok_or(())?.as_str(),
            Some(frontmatter::boolean(fields.get("user-invocable"), true)),
            Some(frontmatter::boolean(fields.get("disable-model-invocation"), false)),
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

fn clean_text(value: Option<String>, max_bytes: usize) -> Option<String> {
    let value = frontmatter::trim(&value?).to_owned();
    (!value.is_empty() && value.len() <= max_bytes && !value.contains('\0')).then_some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_yaml_block_scalar_description() {
        let descriptor = SealedSkillDescriptor::parse_skill_manifest(
            "---\nname: llm-wiki\ndescription: |\n  line one\n  line two\n---\n",
            "llm-wiki",
        )
        .unwrap();

        assert_eq!(descriptor.name(), "llm-wiki");
        assert_eq!(descriptor.description(), "line one\nline two");
    }

    #[test]
    fn parses_yaml_folded_scalar_description() {
        let descriptor = SealedSkillDescriptor::parse_skill_manifest(
            "---\nname: folded\ndescription: >\n  line one\n  line two\n---\n",
            "folded",
        )
        .unwrap();

        assert_eq!(descriptor.description(), "line one line two");
    }
}
