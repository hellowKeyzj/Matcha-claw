use sha2::{Digest, Sha256};

const LEADER_ROLE_ID: &str = "leader";

const TEAM_CONTROL_PROTOCOL: &str = r#"<team_control_protocol>
正常回复用户；在整段回复最后追加且只能追加一个控制块：

<team_control mode="pending" />
或
<team_control mode="propose_run">任务摘要</team_control>

仅当用户明确要求现在执行，且任务目标、范围、约束已足够清楚，无需再澄清时，才可使用 propose_run。

用户仍在咨询、讨论、比较方案、补充信息、修改目标、等待建议，或你不确定是否该执行时，必须使用 pending。

任务摘要用一句话写清要执行什么、范围和关键约束。

控制块必须位于回复最后；不得省略、重复、嵌套，不得使用 JSON、Markdown 或额外字段。
</team_control_protocol>"#;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartGateRuntimeBindingLookup {
    pub(crate) endpoint: organization::RuntimeEndpointReference,
    pub(crate) agent: organization::ManagedAgentReference,
    pub(crate) endpoint_session_id: organization::EndpointSessionId,
}

impl StartGateRuntimeBindingLookup {
    pub fn new(
        endpoint: organization::RuntimeEndpointReference,
        agent: organization::ManagedAgentReference,
        endpoint_session_id: organization::EndpointSessionId,
    ) -> Self {
        Self {
            endpoint,
            agent,
            endpoint_session_id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StartGateBinding {
    pub(crate) team_id: organization::TeamId,
    pub(crate) run_id: organization::GraphRunId,
    pub(crate) role_id: organization::RoleId,
    pub(crate) session_ref: organization::RoleSessionRef,
    pub(crate) agent: organization::ManagedAgentReference,
    pub(crate) endpoint_session_id: organization::EndpointSessionId,
    pub(crate) start_gate: organization::RunStartGate,
}

impl StartGateBinding {
    fn run_id(&self) -> &organization::GraphRunId {
        &self.run_id
    }

    fn is_leader_intake(&self) -> bool {
        self.role_id.as_str() == LEADER_ROLE_ID
            && matches!(
                self.start_gate,
                organization::RunStartGate::Intake
                    | organization::RunStartGate::ProposalPending { .. }
            )
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartGatePromptPlan {
    run_id: organization::GraphRunId,
    proposal_id: String,
}

impl StartGatePromptPlan {
    pub fn run_id(&self) -> &organization::GraphRunId {
        &self.run_id
    }

    pub fn proposal_id(&self) -> &str {
        &self.proposal_id
    }

    pub fn system_provenance_receipt(&self) -> &'static str {
        TEAM_CONTROL_PROTOCOL
    }

    pub fn into_registry_parts(self) -> (organization::GraphRunId, String) {
        (self.run_id, self.proposal_id)
    }
}

enum TeamControl {
    Pending,
    ProposeRun(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StartGateTerminalProposal {
    run_id: organization::GraphRunId,
    proposal_id: String,
    summary: String,
    source_delivery_id: String,
}

impl StartGateTerminalProposal {
    pub fn into_store_parts(self) -> (organization::GraphRunId, String, String, String) {
        (
            self.run_id,
            self.proposal_id,
            self.summary,
            self.source_delivery_id,
        )
    }
}

pub(crate) fn resolve_runtime_binding(
    facts: &organization::OrganizationFacts,
    lookup: &StartGateRuntimeBindingLookup,
) -> Option<StartGateBinding> {
    let mut matches = facts
        .runs()
        .filter_map(|run| {
            let receipt = run.runtime()?;
            let binding = receipt.bindings().iter().find(|binding| {
                binding.endpoint() == &lookup.endpoint
                    && binding.agent() == &lookup.agent
                    && binding.endpoint_session_id() == &lookup.endpoint_session_id
                    && binding.team() == run.team()
                    && binding.team_run() == run.run_id()
            })?;
            Some(StartGateBinding {
                team_id: binding.team().clone(),
                run_id: binding.team_run().clone(),
                role_id: binding.role().clone(),
                session_ref: binding.session_ref().clone(),
                agent: binding.agent().clone(),
                endpoint_session_id: binding.endpoint_session_id().clone(),
                start_gate: run.start_gate().clone(),
            })
        })
        .collect::<Vec<_>>();
    (matches.len() == 1).then(|| matches.remove(0))
}

pub(crate) fn prompt_plan(
    binding: &StartGateBinding,
    proposal_id_seed: Option<&str>,
    requested_at: u64,
) -> Option<StartGatePromptPlan> {
    binding.is_leader_intake().then(|| StartGatePromptPlan {
        run_id: binding.run_id().clone(),
        proposal_id: proposal_id(binding, proposal_id_seed, requested_at),
    })
}

fn proposal_id(
    binding: &StartGateBinding,
    idempotency_key: Option<&str>,
    requested_at: u64,
) -> String {
    let mut digest = Sha256::new();
    digest.update(binding.run_id.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(binding.role_id.as_str().as_bytes());
    digest.update(b"\0");
    digest.update(binding.session_ref.as_str().as_bytes());
    digest.update(b"\0");
    match idempotency_key {
        Some(value) => digest.update(value.as_bytes()),
        None => digest.update(requested_at.to_string().as_bytes()),
    }
    format!("sgp-{:x}", digest.finalize())
}

pub fn terminal_proposal(
    run_id: organization::GraphRunId,
    proposal_id: String,
    source_delivery_id: String,
    final_assistant_text: &str,
) -> Option<StartGateTerminalProposal> {
    match parse_control(final_assistant_text) {
        TeamControl::ProposeRun(summary) => Some(StartGateTerminalProposal {
            run_id,
            proposal_id,
            summary,
            source_delivery_id,
        }),
        TeamControl::Pending => None,
    }
}

fn parse_control(text: &str) -> TeamControl {
    let trimmed = text.trim_end();
    let pending = "<team_control mode=\"pending\" />";
    if trimmed.strip_suffix(pending).is_some() {
        return TeamControl::Pending;
    }
    let close = "</team_control>";
    let Some(without_close) = trimmed.strip_suffix(close) else {
        return TeamControl::Pending;
    };
    let open = "<team_control mode=\"propose_run\">";
    let Some(open_index) = without_close.rfind(open) else {
        return TeamControl::Pending;
    };
    let prefix = &without_close[..open_index];
    if prefix.contains("<team_control") {
        return TeamControl::Pending;
    }
    let summary = without_close[open_index + open.len()..].trim();
    if summary.is_empty()
        || summary.contains('<')
        || summary.contains('>')
        || summary.lines().count() > 1
    {
        return TeamControl::Pending;
    }
    TeamControl::ProposeRun(summary.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(role_id: &str, start_gate: organization::RunStartGate) -> StartGateBinding {
        StartGateBinding {
            team_id: organization::TeamId::try_new("team:one").unwrap(),
            run_id: organization::GraphRunId::new("run:one"),
            role_id: organization::RoleId::try_new(role_id).unwrap(),
            session_ref: organization::RoleSessionRef::initial(),
            agent: organization::ManagedAgentReference::try_new("agent:leader").unwrap(),
            endpoint_session_id: organization::EndpointSessionId::try_new("native:leader").unwrap(),
            start_gate,
        }
    }

    #[test]
    fn prompt_plan_only_allows_leader_intake_or_pending() {
        assert!(
            prompt_plan(
                &binding("leader", organization::RunStartGate::Intake),
                None,
                1
            )
            .is_some()
        );
        assert!(
            prompt_plan(
                &binding(
                    "leader",
                    organization::RunStartGate::ProposalPending {
                        proposal_id: "proposal:one".into(),
                        summary: "Do it".into(),
                        source_delivery_id: "native:old".into(),
                    },
                ),
                None,
                1,
            )
            .is_some()
        );
        assert!(
            prompt_plan(
                &binding("reviewer", organization::RunStartGate::Intake),
                None,
                1
            )
            .is_none()
        );
        assert!(
            prompt_plan(
                &binding("leader", organization::RunStartGate::Started),
                None,
                1
            )
            .is_none()
        );
    }

    #[test]
    fn prompt_plan_uses_stable_proposal_id_seed_and_protocol() {
        let binding = binding("leader", organization::RunStartGate::Intake);
        let first = prompt_plan(&binding, Some("seed:one"), 1).unwrap();
        let second = prompt_plan(&binding, Some("seed:one"), 999).unwrap();
        let third = prompt_plan(&binding, Some("seed:two"), 1).unwrap();

        assert_eq!(first.proposal_id(), second.proposal_id());
        assert_ne!(first.proposal_id(), third.proposal_id());
        assert!(first.proposal_id().starts_with("sgp-"));
        assert_eq!(first.system_provenance_receipt(), TEAM_CONTROL_PROTOCOL);
        assert_eq!(first.run_id().as_str(), "run:one");
    }

    #[test]
    fn parses_only_trailing_single_proposal_block() {
        match parse_control("ok\n<team_control mode=\"propose_run\">执行 A</team_control>") {
            TeamControl::ProposeRun(summary) => assert_eq!(summary, "执行 A"),
            TeamControl::Pending => panic!("expected proposal"),
        }
        assert!(matches!(
            parse_control("<team_control mode=\"propose_run\">A</team_control> extra"),
            TeamControl::Pending
        ));
        assert!(matches!(
            parse_control(
                "<team_control mode=\"pending\" /><team_control mode=\"propose_run\">A</team_control>"
            ),
            TeamControl::Pending
        ));
    }
}
