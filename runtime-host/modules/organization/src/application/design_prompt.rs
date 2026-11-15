pub(crate) fn compose(
    facts: &crate::OrganizationFacts,
    run: &crate::GraphRunFacts,
    generation: &str,
) -> String {
    let epoch = match run.start_gate() {
        crate::RunStartGate::Designing { design_epoch, .. } => design_epoch.as_str(),
        _ => "",
    };
    let roles = facts
        .team(run.team())
        .map(|team| {
            team.definition()
                .roles()
                .iter()
                .map(
                    |role| serde_json::json!({"roleId":role.role_id().as_str(),"name":role.name()}),
                )
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    assemble(
        &serde_json::json!({"teamId":run.team().as_str(),"runId":run.run_id().as_str(),"designEpoch":epoch,"promptGeneration":generation,"roles":roles}),
        facts.team_prompts(),
    )
}

pub(crate) fn assemble(
    context: &serde_json::Value,
    prompts: &crate::prompts::TeamPromptSettings,
) -> String {
    format!(
        "<team_design_context>\n{context}\n</team_design_context>\n<team_design_protocol>\n{}\n</team_design_protocol>",
        prompts.text("design.body.body"),
    )
}
