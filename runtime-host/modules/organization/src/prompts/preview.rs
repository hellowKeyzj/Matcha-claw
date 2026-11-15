use std::collections::BTreeMap;

use super::{PromptValidationError, TeamPromptSettings, validate_values};
use crate::{
    ActivityTarget, ExecutorPolicy, GraphDefinition, GraphRunId, GraphState, MemberProfile,
    NodeDefinition, NodeId, ReviewAssignment, RoleId, TeamId, WorkAssignment,
    application::{
        design_prompt, member_introduction,
        team_message::{self, TeamMessageRepairBasis},
    },
    run::scheduler::{self, UpstreamPromptContext},
};

pub fn preview(
    values: BTreeMap<String, String>,
    group: &str,
    variant: &str,
) -> Result<String, PromptValidationError> {
    validate_values(&values)?;
    let prompts = TeamPromptSettings {
        revision: 0,
        values,
    };
    let text = match (group, variant) {
        ("discussion", "work") => prompts.text("discussion.body.body").to_owned(),
        ("design", "work") => design_prompt::assemble(
            &serde_json::json!({
                "teamId": "team:preview",
                "runId": "run:preview",
                "designEpoch": "design:preview",
                "promptGeneration": "sgg-0000000000000000000000000000000000000000000000000000000000000000",
                "roles": [
                    {"roleId": "leader", "name": "示例协调员"},
                    {"roleId": "designer", "name": "示例设计师"},
                ],
            }),
            &prompts,
        ),
        ("execution", "work" | "review") => execution(&prompts, variant == "review"),
        ("repair", "missing" | "declared" | "unreadable") => repair(&prompts, variant),
        ("introduction", "work") => {
            let request = member_introduction::prepare(
                "示例设计师",
                RoleId::try_new("designer").expect("sample role"),
                MemberProfile {
                    description: Some("示例资料：负责活动视觉方案与画面交付。".to_owned()),
                    agents_markdown: Some(
                        "示例资料：根据已确认文案产出 1:1 和 3:4 活动画面，并检查尺寸。".to_owned(),
                    ),
                    soul_markdown: Some(
                        "示例资料：不负责活动定价；信息不足时明确标注待确认。".to_owned(),
                    ),
                },
                &prompts,
            );
            format!(
                "{}\n\n────────────────────\n\n{}",
                request.system_prompt, request.prompt
            )
        }
        ("discussion" | "design" | "execution" | "repair" | "introduction", _) => {
            return Err(PromptValidationError::new("", "invalid_variant"));
        }
        _ => return Err(PromptValidationError::new("", "invalid_group")),
    };
    Ok(text)
}

fn execution(prompts: &TeamPromptSettings, review: bool) -> String {
    let node_id = NodeId::new(if review {
        "review-preview"
    } else {
        "work-preview"
    });
    let node = if review {
        NodeDefinition::review(
            node_id.clone(),
            "示例审核节点",
            ReviewAssignment::new(
                "reviewer",
                "示例任务：审核上游活动方案及两种比例画面，缺失必要内容时指出返工要求。",
            ),
        )
    } else {
        NodeDefinition::work(
            node_id.clone(),
            "示例工作节点",
            WorkAssignment::typed(
                "task:preview",
                "示例任务：根据已确认活动文案制作 1:1 和 3:4 画面，交付到 outputs/，不编造价格和日期。",
                ExecutorPolicy::team_role("designer"),
                None,
            ),
        )
    };
    let source_id = NodeId::new("upstream-preview");
    let graph = GraphState::initialize(
        GraphDefinition::new(
            "graph:preview",
            "plan:preview",
            GraphRunId::new("run:preview"),
            "示例运行图",
            vec![
                node,
                NodeDefinition::work(
                    source_id.clone(),
                    "示例上游节点",
                    WorkAssignment::typed(
                        "task:upstream-preview",
                        "示例任务：整理活动文案。",
                        ExecutorPolicy::team_role("writer"),
                        None,
                    ),
                ),
            ],
            Vec::new(),
        )
        .expect("sample graph"),
        1,
    );
    let selected = scheduler::schedule_ready_nodes(&graph, 2, 0)
        .expect("sample schedule")
        .into_iter()
        .find(|item| item.node_id() == &node_id)
        .expect("sample ready node");
    let request = selected
        .bind_activity_target(ActivityTarget::new("rs0").expect("sample session"), 1, 1)
        .expect("sample activity");
    let files = vec!["outputs/campaign-copy.md".to_owned()];
    let upstream = [UpstreamPromptContext {
        source: graph.current_attempt(&source_id).expect("sample upstream"),
        summary: "示例上游摘要：活动文案已完成，价格、地址和日期待确认。",
        files: &files,
    }];
    scheduler::compose_agent_task_prompt_with_upstream_context(
        &TeamId::try_new("team:preview").expect("sample team"),
        graph.definition().node(&node_id).expect("sample node"),
        &request,
        &upstream,
        prompts,
    )
    .expect("sample agent task")
}

fn repair(prompts: &TeamPromptSettings, variant: &str) -> String {
    let (basis, original, error) = match variant {
        "missing" => (
            TeamMessageRepairBasis::MissingDeclaration,
            "示例输出：活动文案与画面方案已完成，价格、地址和日期尚待确认。".to_owned(),
            "missing <team_message>...</team_message> envelope",
        ),
        "declared" => (
            TeamMessageRepairBasis::Declared { decision: "rework".to_owned(), files: Vec::new() },
            r#"示例输出：缺少 3:4 构图。
<team_message>{"summary":"缺少 3:4 构图，需要返工","decision":"rework","files":[],}</team_message>"#.to_owned(),
            "invalid JSON",
        ),
        _ => (
            TeamMessageRepairBasis::UnreadableDeclaration,
            "示例输出：声明互相冲突。\n<team_message>{\"summary\":\"审核通过\",\"decision\":\"completed\",\"files\":[]}</team_message>\n<team_message>{\"summary\":\"缺少 3:4 构图，需要返工\",\"decision\":\"rework\",\"files\":[]}</team_message>".to_owned(),
            "exactly one <team_message> envelope must end the final reply",
        ),
    };
    let decisions = crate::NodeKind::Review
        .source_ports()
        .iter()
        .map(|port| port.as_str())
        .collect::<Vec<_>>()
        .join(" / ");
    team_message::compose_repair_prompt(&original, error, &decisions, &basis, prompts)
}
