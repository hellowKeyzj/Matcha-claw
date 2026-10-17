use skills_module::bundle::{self, BundleFile};
use tokio_util::sync::CancellationToken;

use super::{Resource, ResourceError, Skills};

impl Skills {
    pub(super) async fn import_bundle(&self, agent: &str, bundle: bundle::Bundle, cancellation: &CancellationToken) -> Result<(), ResourceError> {
        let manifest = bundle.files().iter().find(|file| file.path() == "SKILL.md").ok_or(ResourceError::Rejected)?;
        let resources = bundle.files().iter().filter(|file| file.path() != "SKILL.md").map(|file| Resource {path:file.path().to_owned(),bytes:file.content().as_bytes().to_vec()}).collect();
        self.install(agent,bundle.skill_key(),manifest.content().to_owned(),resources,cancellation).await?;
        Ok(())
    }

    pub(super) async fn bundles(&self, agent: &str, command: bundle::Command) -> bundle::Outcome {
        match command {
            bundle::Command::Export {skill_keys} => {
                let mut bundles = Vec::new();
                for name in skill_keys {
                    let native = match self.get(agent,&name).await {Ok(bundle)=>bundle,Err(_)=>return bundle::Outcome::Rejected};
                    let mut files = Vec::new();
                    let manifest = match BundleFile::try_new("SKILL.md".into(),native.skill_md) {Ok(file)=>file,Err(_)=>return bundle::Outcome::Rejected};
                    files.push(manifest);
                    for resource in native.resources {
                        let content = match String::from_utf8(resource.bytes) {Ok(content)=>content,Err(_)=>return bundle::Outcome::Rejected};
                        match BundleFile::try_new(resource.path,content) {Ok(file)=>files.push(file),Err(_)=>return bundle::Outcome::Rejected}
                    }
                    match bundle::Bundle::try_new(name,files) {Ok(bundle)=>bundles.push(bundle),Err(_)=>return bundle::Outcome::Rejected}
                }
                if bundle::validate_batch(&bundles).is_err() {return bundle::Outcome::Rejected;}
                bundle::Outcome::Exported(bundles)
            }
            bundle::Command::Import {bundles} => {
                if bundle::validate_batch(&bundles).is_err() {return bundle::Outcome::Rejected;}
                let mut installed = false;
                for bundle in bundles {
                    match self.import_bundle(agent,bundle,&CancellationToken::new()).await {
                        Ok(()) => installed = true,
                        Err(ResourceError::Unknown) => return bundle::Outcome::Unknown,
                        Err(_) if installed => return bundle::Outcome::Unknown,
                        Err(_) => return bundle::Outcome::Rejected,
                    }
                }
                bundle::Outcome::Accepted
            }
        }
    }
}
