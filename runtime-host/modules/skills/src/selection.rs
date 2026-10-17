use std::sync::Arc;

use platform::endpoint::runtime_address::{RuntimeEndpoint, RuntimeScope};
use tokio_util::sync::CancellationToken;

use crate::{bundle, install, management, ports::*, status};

pub(crate) fn is_openclaw_scope(scope: &RuntimeScope) -> bool {
    matches!(scope, RuntimeScope::RuntimeInstance(endpoint)
        if endpoint == &runtime_directory::RuntimeDriverIdentity::open_claw().endpoint())
}

fn endpoint(scope: &RuntimeScope) -> Option<&RuntimeEndpoint> {
    match scope {
        RuntimeScope::Agent { endpoint, .. } => Some(endpoint),
        _ => None,
    }
}

/// The legacy port remains the OpenClaw owner; explicit Agent scopes select a peer.
pub struct SelectedSkillsPort {
    legacy: Arc<dyn SkillsPort>,
    directory: Arc<dyn SkillsRuntimeDirectory>,
}

impl SelectedSkillsPort {
    pub fn new(legacy: Arc<dyn SkillsPort>, directory: Arc<dyn SkillsRuntimeDirectory>) -> Self {
        Self { legacy, directory }
    }

    fn ops(&self, scope: &RuntimeScope) -> Option<&dyn SkillRuntimeOps> {
        self.directory.skill_ops(endpoint(scope)?)
    }
}

impl SkillsPort for SelectedSkillsPort {
    fn skill_source_for_scope<'a>(&'a self, scope: &'a RuntimeScope, skill_key: &'a str) -> SkillsFuture<'a, Result<SkillSource, SealedSkillError>> {
        Box::pin(async move {
            self.ops(scope).ok_or(SealedSkillError::Rejected)?.skill_source_for_scope(scope, skill_key).await
        })
    }

    fn remove_skill_source_for_scope<'a>(&'a self, scope: &'a RuntimeScope, skill_key: &'a str, expected_sha256: &'a str) -> SkillsFuture<'a, Result<(), SealedSkillError>> {
        Box::pin(async move {
            self.ops(scope).ok_or(SealedSkillError::Rejected)?.remove_skill_source_for_scope(scope, skill_key, expected_sha256).await
        })
    }

    fn install_clawhub_skill<'a>(&'a self, command: install::Command) -> SkillsFuture<'a, Result<install::Outcome, ()>> {
        self.legacy.install_clawhub_skill(command)
    }

    fn install_clawhub_skill_cancellable<'a>(&'a self, command: install::Command, cancellation: CancellationToken) -> SkillsFuture<'a, Result<install::Outcome, ()>> {
        self.legacy.install_clawhub_skill_cancellable(command, cancellation)
    }

    fn skill_status<'a>(&'a self) -> SkillsFuture<'a, Result<status::Outcome, ()>> {
        self.legacy.skill_status()
    }

    fn manage_skills<'a>(&'a self, command: management::Command) -> SkillsFuture<'a, Result<management::Outcome, ()>> {
        self.legacy.manage_skills(command)
    }

    fn manage_skills_cancellable<'a>(&'a self, command: management::Command, cancellation: CancellationToken) -> SkillsFuture<'a, Result<management::Outcome, ()>> {
        self.legacy.manage_skills_cancellable(command, cancellation)
    }

    fn skill_bundles<'a>(&'a self, command: bundle::Command) -> SkillsFuture<'a, Result<bundle::Outcome, ()>> {
        self.legacy.skill_bundles(command)
    }

    fn skill_status_for_scope<'a>(&'a self, scope: &'a RuntimeScope) -> SkillsFuture<'a, Result<status::Outcome, ()>> {
        if is_openclaw_scope(scope) {
            return self.legacy.skill_status();
        }
        Box::pin(async move {
            Ok(match self.ops(scope) {
                Some(ops) => ops.skill_status_for_scope(scope).await,
                None => status::Outcome::Unavailable,
            })
        })
    }

    fn install_clawhub_skill_for_scope<'a>(&'a self, scope: &'a RuntimeScope, command: install::Command, cancellation: CancellationToken) -> SkillsFuture<'a, Result<install::Outcome, ()>> {
        if is_openclaw_scope(scope) {
            return self.legacy.install_clawhub_skill_cancellable(command, cancellation);
        }
        Box::pin(async move {
            Ok(match self.ops(scope) {
                Some(ops) => ops.install_clawhub_skill_for_scope(scope, command, cancellation).await,
                None => install::Outcome::Rejected,
            })
        })
    }

    fn manage_skills_for_scope<'a>(&'a self, scope: &'a RuntimeScope, command: management::Command, cancellation: CancellationToken) -> SkillsFuture<'a, Result<management::Outcome, ()>> {
        if is_openclaw_scope(scope) {
            return self.legacy.manage_skills_cancellable(command, cancellation);
        }
        Box::pin(async move {
            Ok(match self.ops(scope) {
                Some(ops) => ops.manage_skills_for_scope(scope, command, cancellation).await,
                None => management::Outcome::Unavailable,
            })
        })
    }

    fn skill_bundles_for_scope<'a>(&'a self, scope: &'a RuntimeScope, command: bundle::Command) -> SkillsFuture<'a, Result<bundle::Outcome, ()>> {
        if is_openclaw_scope(scope) {
            return self.legacy.skill_bundles(command);
        }
        Box::pin(async move {
            Ok(match self.ops(scope) {
                Some(ops) => ops.skill_bundles_for_scope(scope, command).await,
                None => bundle::Outcome::Rejected,
            })
        })
    }
}
