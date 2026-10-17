use platform::endpoint::runtime_address::RuntimeScope;
use skills_module::{SkillRuntimeOps, bundle, install, management, ports::SkillsFuture, status};
use tokio_util::sync::CancellationToken;

use crate::driver::MatchaRuntimeDriver;

fn agent(scope: &RuntimeScope) -> Option<&str> {
    match scope {
        RuntimeScope::Agent {endpoint,agent_id} if endpoint == &runtime_directory::RuntimeDriverIdentity::matcha_agent().endpoint() => Some(agent_id),
        _ => None,
    }
}

fn sealed_error(error: super::ResourceError) -> skills_module::SealedSkillError {
    match error {
        super::ResourceError::NotFound => skills_module::SealedSkillError::NotFound,
        super::ResourceError::Rejected => skills_module::SealedSkillError::Rejected,
        _ => skills_module::SealedSkillError::Unknown,
    }
}

impl SkillRuntimeOps for MatchaRuntimeDriver {
    fn skill_source_for_scope<'a>(&'a self, scope: &'a RuntimeScope, skill_key: &'a str) -> SkillsFuture<'a, Result<skills_module::ports::SkillSource, skills_module::SealedSkillError>> {
        Box::pin(async move {
            let agent = agent(scope).ok_or(skills_module::SealedSkillError::Rejected)?;
            let bundle = self.native_skills().get(agent, skill_key).await.map_err(sealed_error)?;
            let mut files = vec![("SKILL.md".into(), bundle.skill_md.into_bytes())];
            files.extend(bundle.resources.into_iter().map(|resource| (resource.path, resource.bytes)));
            Ok(skills_module::ports::SkillSource { files, sha256: bundle.bundle_sha256 })
        })
    }

    fn remove_skill_source_for_scope<'a>(&'a self, scope: &'a RuntimeScope, skill_key: &'a str, expected_sha256: &'a str) -> SkillsFuture<'a, Result<(), skills_module::SealedSkillError>> {
        Box::pin(async move {
            let agent = agent(scope).ok_or(skills_module::SealedSkillError::Rejected)?;
            self.native_skills().remove_source(agent, skill_key, Some(expected_sha256), &CancellationToken::new()).await.map_err(sealed_error)?;
            Ok(())
        })
    }

    fn installed_skill_names<'a>(&'a self) -> SkillsFuture<'a, Option<Vec<String>>> {Box::pin(async {None})}
    fn install_clawhub_skill<'a>(&'a self, _command: install::Command) -> SkillsFuture<'a, install::Outcome> {Box::pin(async {install::Outcome::Rejected})}
    fn skill_status<'a>(&'a self) -> SkillsFuture<'a, status::Outcome> {Box::pin(async {status::Outcome::Unavailable})}
    fn manage_skills<'a>(&'a self, _command: management::Command) -> SkillsFuture<'a, management::Outcome> {Box::pin(async {management::Outcome::Unavailable})}
    fn skill_bundles<'a>(&'a self, _command: bundle::Command) -> SkillsFuture<'a, bundle::Outcome> {Box::pin(async {bundle::Outcome::Rejected})}

    fn skill_status_for_scope<'a>(&'a self, scope: &'a RuntimeScope) -> SkillsFuture<'a, status::Outcome> {
        Box::pin(async move {
            let Some(agent) = agent(scope) else {return status::Outcome::Unavailable;};
            let catalog = match self.native_skills().list(agent).await {Ok(catalog)=>catalog,Err(_)=>return status::Outcome::Unavailable};
            status::Outcome::Available(status::Catalog {entries:catalog.skills.into_iter().map(|skill| status::Entry {
                key:skill.name.clone(),slug:None,name:skill.name,description:String::new(),
                // Native discovery candidates are not an enabled/eligible or current-session ACK.
                enabled:false,selectable:false,eligible:false,blocked_by_allowlist:false,bundled:None,always:None,emoji:None,
                source:Some("native-agent-candidate".into()),uninstallable:true,base_dir:None,file_path:None,missing_categories:Vec::new(),
            }).collect()})
        })
    }

    fn install_clawhub_skill_for_scope<'a>(&'a self, scope: &'a RuntimeScope, command: install::Command, cancellation: CancellationToken) -> SkillsFuture<'a, install::Outcome> {
        Box::pin(async move {
            let Some(agent) = agent(scope) else {return install::Outcome::Rejected;};
            let (slug,version,force) = command.into_parts();
            match self.native_skills().marketplace_install(agent,slug.clone(),version.clone(),force,&cancellation).await {
                management::MutationOutcome::Accepted=>install::Outcome::accepted(slug,version),
                management::MutationOutcome::Unknown=>install::Outcome::Unknown,
                _=>install::Outcome::Rejected,
            }
        })
    }

    fn manage_skills_for_scope<'a>(&'a self, scope: &'a RuntimeScope, command: management::Command, cancellation: CancellationToken) -> SkillsFuture<'a, management::Outcome> {
        Box::pin(async move {
            let Some(agent) = agent(scope) else {return management::Outcome::Unavailable;};
            self.native_skills().manage(agent,command,&cancellation).await
        })
    }

    fn skill_bundles_for_scope<'a>(&'a self, scope: &'a RuntimeScope, command: bundle::Command) -> SkillsFuture<'a, bundle::Outcome> {
        Box::pin(async move {
            let Some(agent) = agent(scope) else {return bundle::Outcome::Rejected;};
            self.native_skills().bundles(agent,command).await
        })
    }
}
