use crate::{MemberIntroductionRequest, MemberProfile, RoleId, prompts::TeamPromptSettings};

pub(crate) fn prepare(
    name: &str,
    role_id: RoleId,
    profile: MemberProfile,
    prompts: &TeamPromptSettings,
) -> MemberIntroductionRequest {
    let mut materials = String::new();
    for (section, content) in [
        ("已有描述", profile.description),
        ("AGENTS.md", profile.agents_markdown),
        ("SOUL.md", profile.soul_markdown),
    ] {
        if let Some(content) = content {
            materials.push_str(&format!("\n\n【{section}】\n{content}"));
        }
    }
    let prompt = prompts.render(
        "introduction.input.body",
        &[
            ("成员名称", name),
            ("角色标识", role_id.as_str()),
            ("成员资料", &materials),
        ],
    );
    MemberIntroductionRequest {
        role_id,
        system_prompt: prompts.text("introduction.system.body").to_owned(),
        prompt,
        max_output_tokens: Some(512),
        temperature: Some(0.2),
    }
}
