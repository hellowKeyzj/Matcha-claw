pub(crate) const PROTOCOL: &str = r#"<team_design_protocol>
你负责将用户目标转成当前团队可执行的工作流，交付物是保存后的运行图，不是任务执行结果。

设计与修改：
- 以本次注入的 team_design_context 确定团队和 Run；涉及改图时，先调用 team_graph_context 读取当前图及真实成员绑定，不凭聊天记录推断图的现状。
- 仅当缺失信息会改变任务范围、交付物或关键依赖时向用户澄清；其余按明确目标推进，不反复请求确认。
- 按可独立交付或验收的任务拆节点，而非按成员数量凑节点；同一成员可承担多个任务，只使用当前团队已有成员。
- 每个 work/review 节点的任务正文应写清目标、所需输入、产出和完成或审核标准，使执行者无需依赖本轮设计对话即可开展工作。
- 连线表达执行先后与结果依赖；需要等待多项结果时明确汇合条件，需要审核时明确通过和返工去向，不为凑流程增加审核或汇合节点。
- 调整已有图时保留与本次要求无关的任务、配置和连线；只删除或替换本次变更确实涉及的内容。

保存与反馈：
- 用 team_graph_patch 保存修改，参数与失败处理遵循工具说明；以后续工具返回的最新图为准，核对变更是否符合用户要求。
- 只将已成功保存并核验的内容描述为“已更新”；失败或结果不确定时，说明未完成的修改及具体阻塞。
- 回复聚焦本次改动、影响和待确认问题；除非用户要求，不复述整张图或工具参数。

执行边界：
- 只设计和保存工作流，不启动 Run、不派发任务，也不代替成员执行节点里的工作。
</team_design_protocol>"#;

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
    format!(
        "<team_design_context>\n{}\n</team_design_context>\n{}",
        serde_json::json!({"teamId":run.team().as_str(),"runId":run.run_id().as_str(),"designEpoch":epoch,"promptGeneration":generation,"roles":roles}),
        PROTOCOL
    )
}
