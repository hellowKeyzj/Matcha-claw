use skills_module::management::{self as host, Command, Outcome};
use tokio_util::sync::CancellationToken;

use super::{ResourceError, Skills};

impl Skills {
    pub(super) async fn manage(&self, agent: &str, command: Command, cancellation: &CancellationToken) -> Outcome {
        match command {
            Command::Detail {..} => Outcome::Detail(Err(host::ReadError::Unavailable)),
            // Native skill discovery has no OpenClaw per-skill enabled/env/apiKey configuration.
            Command::Config {..} => Outcome::Config {outcome:host::ConfigOutcome::Rejected,invalid_keys:Vec::new()},
            Command::ClawHubInstall {slug,version,force} => Outcome::Mutation(self.marketplace_install(agent,slug,version,force,cancellation).await),
            Command::ClawHubUpdate {slug,all} => {
                // Only bundles carrying the existing ClawHub origin receipt can be updated.
                let names = if all {
                    match self.list(agent).await {Ok(catalog)=>catalog.skills.into_iter().map(|skill|skill.name).collect(),Err(_)=>return Outcome::Unavailable}
                } else {slug.into_iter().collect::<Vec<_>>()};
                let mut changed = false;
                for name in names {
                    let bundle = match self.get(agent,&name).await {Ok(bundle)=>bundle,Err(_)=>return Outcome::Mutation(if changed{host::MutationOutcome::Unknown}else{host::MutationOutcome::Rejected})};
                    let managed = bundle.resources.iter().any(|resource| {
                        matches!(resource.path.as_str(),".clawhub/origin.json"|".clawdhub/origin.json")
                            && serde_json::from_slice::<serde_json::Value>(&resource.bytes).ok().is_some_and(|origin| origin.get("slug").and_then(serde_json::Value::as_str)==Some(name.as_str()))
                    });
                    if !managed {
                        if all {continue;}
                        return Outcome::Mutation(host::MutationOutcome::Rejected);
                    }
                    match self.marketplace_install(agent,name,None,true,cancellation).await {
                        host::MutationOutcome::Accepted=>changed=true,
                        host::MutationOutcome::Unknown=>return Outcome::Mutation(host::MutationOutcome::Unknown),
                        _=>return Outcome::Mutation(if changed{host::MutationOutcome::Unknown}else{host::MutationOutcome::Rejected}),
                    }
                }
                Outcome::Mutation(host::MutationOutcome::Accepted)
            }
            command @ (Command::UploadBegin {..}|Command::UploadChunk {..}|Command::UploadCommit {..}) => Outcome::Upload(self.upload(agent,command,cancellation).await),
            Command::Uninstall {skill_key,slug} => {
                if slug.as_deref().is_some_and(|slug|slug!=skill_key) {return Outcome::Uninstall(host::RemoveOutcome::Rejected);}
                Outcome::Uninstall(match self.remove(agent,&skill_key,cancellation).await {Ok(_)=>host::RemoveOutcome::Removed,Err(ResourceError::NotFound)=>host::RemoveOutcome::NotFound,Err(ResourceError::Unknown)=>host::RemoveOutcome::Unknown,Err(_)=>host::RemoveOutcome::Rejected})
            }
            Command::ImportMarkdown {content} => {
                let name = content.strip_prefix("---\n").or_else(||content.strip_prefix("---\r\n")).and_then(|text|text.split_once("\n---")).and_then(|(front,_)|front.lines().find_map(|line|line.strip_prefix("name:").map(|value|value.trim().trim_matches(['\'', '"']).to_owned())));
                let result = match name {Some(name)=>self.install(agent,&name,content,Vec::new(),cancellation).await.map(|_|()),None=>Err(ResourceError::Rejected)};
                Outcome::Import(import_outcome(result))
            }
            Command::ImportBundle {bundle} => Outcome::Import(import_outcome(self.import_bundle(agent,bundle,cancellation).await)),
            Command::Readme {skill_key,slug,..}|Command::OpenReadme {skill_key,slug,..} => {
                if slug.as_deref().is_some_and(|slug|slug!=skill_key) {return Outcome::Readme(Err(host::ReadmeError::Rejected));}
                Outcome::Readme(self.get(agent,&skill_key).await.map(|bundle|host::ReadmeReceipt {skill_key,content:bundle.skill_md,file_path:bundle.skill.path}).map_err(|error|if error==ResourceError::Unknown{host::ReadmeError::Unknown}else{host::ReadmeError::Rejected}))
            }
            Command::OpenPath {..} => Outcome::OpenPath(Err(host::ReadmeError::Rejected)),
        }
    }

    pub(super) async fn marketplace_install(&self, agent: &str, slug: String, version: Option<String>, replace: bool, cancellation: &CancellationToken) -> host::MutationOutcome {
        let Some(marketplace) = &self.marketplace else {return host::MutationOutcome::Rejected;};
        match marketplace.install(self,agent,slug,version,replace,cancellation).await {Ok(())=>host::MutationOutcome::Accepted,Err(ResourceError::Unknown)=>host::MutationOutcome::Unknown,Err(_)=>host::MutationOutcome::Rejected}
    }
}

fn import_outcome(result: Result<(), ResourceError>) -> host::ImportOutcome {
    match result {Ok(())=>host::ImportOutcome::Accepted,Err(ResourceError::Unknown)=>host::ImportOutcome::Unknown,Err(_)=>host::ImportOutcome::Rejected}
}
