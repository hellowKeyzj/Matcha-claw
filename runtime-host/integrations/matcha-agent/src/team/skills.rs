use std::collections::BTreeMap;

use organization::{
    MaterializationSource, TeamCreationFailureReason as Reason, TeamMaterializationRequest,
};
use tokio_util::sync::CancellationToken;

use crate::{
    client::Client,
    skills::{Bundle, ResourceError, Skills},
};

pub(super) struct Source {
    bundle: Bundle,
    digest: [u8; 32],
}

pub(super) type Sources = BTreeMap<String, Source>;

fn reason(error: ResourceError) -> Reason {
    match error {
        ResourceError::Rejected => Reason::RpcRejected,
        ResourceError::NotFound => Reason::NativeReadbackMismatch,
        ResourceError::Unavailable => Reason::RpcUnavailable,
        ResourceError::Observation => Reason::NativeReadbackMismatch,
        ResourceError::Unknown => Reason::OutcomeUnknown,
    }
}

fn digest(bundle: &Bundle) -> Result<[u8; 32], Reason> {
    let mut hash = [0; 32];
    for (index, byte) in hash.iter_mut().enumerate() {
        let hex = bundle
            .bundle_sha256
            .get(index * 2..index * 2 + 2)
            .ok_or(Reason::NativeReadbackMismatch)?;
        *byte = u8::from_str_radix(hex, 16).map_err(|_| Reason::NativeReadbackMismatch)?;
    }
    Ok(hash)
}

async fn get(
    skills: &Skills,
    agent: &str,
    name: &str,
    cancellation: &CancellationToken,
) -> Result<Bundle, ResourceError> {
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err(ResourceError::Unknown),
        result = skills.get(agent, name) => result,
    }
}

pub(super) async fn sources(
    client: &Client,
    request: &TeamMaterializationRequest,
    cancellation: &CancellationToken,
) -> Result<Sources, Reason> {
    let mut sources = BTreeMap::new();
    let Some(source) = request.intent().source_agent() else {
        return if request.intent().source() == MaterializationSource::Manual
            && request
                .intent()
                .agents()
                .iter()
                .all(|role| role.skills().is_empty())
        {
            Ok(sources)
        } else {
            Err(Reason::InvalidInput)
        };
    };
    super::profiles::agent(client, source.as_str(), cancellation).await?;
    let skills = Skills::new(client.clone());
    for name in request
        .intent()
        .agents()
        .iter()
        .flat_map(|role| role.skills())
    {
        if sources.contains_key(name) {
            continue;
        }
        let bundle = get(&skills, source.as_str(), name, cancellation)
            .await
            .map_err(reason)?;
        let digest = digest(&bundle)?;
        sources.insert(name.clone(), Source { bundle, digest });
    }
    Ok(sources)
}

pub(super) async fn verify(
    client: &Client,
    agent: &str,
    names: &[String],
    sources: &Sources,
    cancellation: &CancellationToken,
) -> Result<Vec<(String, [u8; 32])>, Reason> {
    let skills = Skills::new(client.clone());
    let mut receipts = Vec::with_capacity(names.len());
    for name in names {
        let source = sources.get(name).ok_or(Reason::InvalidInput)?;
        let target = get(&skills, agent, name, cancellation)
            .await
            .map_err(reason)?;
        if digest(&target)? != source.digest {
            return Err(Reason::NativeReadbackMismatch);
        }
        receipts.push((name.clone(), source.digest));
    }
    Ok(receipts)
}

pub(super) async fn install(
    client: &Client,
    agent: &str,
    names: &[String],
    sources: &Sources,
    cancellation: &CancellationToken,
) -> Result<(), Reason> {
    let skills = Skills::new(client.clone());
    for name in names {
        let source = sources.get(name).ok_or(Reason::InvalidInput)?;
        match get(&skills, agent, name, cancellation).await {
            Ok(target) if digest(&target)? == source.digest => continue,
            Ok(_) => return Err(Reason::NativeReadbackMismatch),
            Err(ResourceError::NotFound) => {}
            Err(error) => return Err(reason(error)),
        }
        let resources = source
            .bundle
            .resources
            .iter()
            .map(|resource| crate::skills::Resource {
                path: resource.path.clone(),
                bytes: resource.bytes.clone(),
            })
            .collect();
        skills
            .install(
                agent,
                name,
                source.bundle.skill_md.clone(),
                resources,
                cancellation,
            )
            .await
            .map_err(reason)?;
        let target = get(&skills, agent, name, cancellation)
            .await
            .map_err(reason)?;
        if digest(&target)? != source.digest {
            return Err(Reason::NativeReadbackMismatch);
        }
    }
    Ok(())
}
