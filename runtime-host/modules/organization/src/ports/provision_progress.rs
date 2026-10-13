use std::{collections::BTreeMap, future::Future, pin::Pin, sync::Arc};

use super::member_introduction::MemberIntroductionError;

use serde::Serialize;

/// Safe observation only; members follow the intent's non-leader order.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct TeamProvisionProgress {
    pub stage: TeamProvisionStage,
    pub members: Vec<TeamProvisionMemberStatus>,
    #[serde(rename = "memberErrors", skip_serializing_if = "BTreeMap::is_empty")]
    pub member_errors: BTreeMap<usize, MemberIntroductionError>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamProvisionStage {
    ReadingProfiles,
    GeneratingIntroductions,
    ConfiguringTeam,
    VerifyingTeam,
    SavingTeam,
    RollingBack,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TeamProvisionMemberStatus {
    Queued,
    Running,
    Completed,
    Failed,
}

pub enum TeamProvisionUpdate {
    Started(TeamProvisionProgress),
    Stage(TeamProvisionStage),
    Member {
        index: usize,
        status: TeamProvisionMemberStatus,
        error: Option<MemberIntroductionError>,
    },
}

pub trait TeamProvisionReporter: Send + Sync {
    fn report(&self, update: TeamProvisionUpdate) -> Pin<Box<dyn Future<Output = ()> + Send + '_>>;
}

pub type TeamProvisionObserver = Arc<dyn TeamProvisionReporter>;
