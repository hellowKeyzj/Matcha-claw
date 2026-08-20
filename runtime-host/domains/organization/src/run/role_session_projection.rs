use serde::Serialize;

use crate::{
    OrganizationFacts, TeamId,
    run::query::{TeamRunQuery, TeamRunQueryOutcome, query_team_run},
};

/// Fixed renderer-safe Team role-session index. The opaque reference identifies only the local
/// session record; provider session IDs, endpoints, agents, workspaces, receipts, and payloads
/// never cross this boundary.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRoleSessionProjection {
    team_id: String,
    run_id: String,
    role_id: String,
    session_ref: String,
    status: TeamRoleSessionStatus,
}

impl TeamRoleSessionProjection {
    fn new(team_id: String, run_id: String, role_id: String, session_ref: String) -> Self {
        Self {
            team_id,
            run_id,
            role_id,
            session_ref,
            status: TeamRoleSessionStatus::Available,
        }
    }

    pub fn team_id(&self) -> &str {
        &self.team_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn role_id(&self) -> &str {
        &self.role_id
    }

    pub fn session_ref(&self) -> &str {
        &self.session_ref
    }

    pub const fn status(&self) -> TeamRoleSessionStatus {
        self.status
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamRoleSessionStatus {
    Available,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TeamRoleSessionQueryOutcome {
    Available(Vec<TeamRoleSessionProjection>),
    Unavailable,
    OutcomeUnknown,
}

/// Lists only sessions from proven, available TeamRuns. Tombstoned, cancelling, and recovery-
/// unknown runs deliberately yield no session references so stale renderer selections cannot
/// survive a durable lifecycle transition.
pub fn query_team_role_sessions(
    facts: &OrganizationFacts,
    team: &TeamId,
) -> TeamRoleSessionQueryOutcome {
    let Some(team_facts) = facts.team(team) else {
        return TeamRoleSessionQueryOutcome::Unavailable;
    };
    if team_facts.tombstoned() || facts.materialization(team).is_none() {
        return TeamRoleSessionQueryOutcome::Unavailable;
    }

    let mut projections = Vec::new();
    let mut unknown = false;
    for run in facts.runs().filter(|run| run.team() == team) {
        match query_team_run(
            facts,
            &TeamRunQuery::get(team.clone(), run.run_id().clone()),
        ) {
            TeamRunQueryOutcome::Available(_) => {
                let Some(runtime) = run.runtime() else {
                    unknown = true;
                    continue;
                };
                projections.extend(runtime.bindings().iter().map(|binding| {
                    TeamRoleSessionProjection::new(
                        team.as_str().to_owned(),
                        binding.team_run().as_str().to_owned(),
                        binding.role().as_str().to_owned(),
                        binding.local_session().as_str().to_owned(),
                    )
                }));
            }
            TeamRunQueryOutcome::OutcomeUnknown => unknown = true,
            TeamRunQueryOutcome::Unavailable => {}
        }
    }
    projections.sort_by(|left, right| {
        (&left.run_id, &left.role_id, &left.session_ref).cmp(&(
            &right.run_id,
            &right.role_id,
            &right.session_ref,
        ))
    });

    if projections.is_empty() && unknown {
        TeamRoleSessionQueryOutcome::OutcomeUnknown
    } else {
        TeamRoleSessionQueryOutcome::Available(projections)
    }
}
