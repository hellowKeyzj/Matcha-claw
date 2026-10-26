use std::{path::Path, sync::Arc};

use platform::state_dir::CanonicalStateDir;
use world::{AuthorityRoot, NativeVerificationError, NativeVerifier};
use world_protocol::authorization::AuthorizationFailure;
use zeroize::Zeroizing;

pub(crate) type Verifiers = Vec<Result<Arc<dyn NativeVerifier>, NativeVerificationError>>;

pub(crate) fn prepare(
    root: &Path,
    endpoint: Option<String>,
    authority: &Arc<AuthorityRoot>,
    open_claw: &mut openclaw::driver::OpenClawInput,
    matcha: &mut matcha_agent::driver::MatchaAgentInput,
) -> Verifiers {
    let Some(endpoint) = endpoint else {
        return Vec::new();
    };
    vec![
        prepare_open_claw(root, &endpoint, authority, open_claw),
        prepare_matcha(root, &endpoint, authority, matcha),
    ]
}

fn prepare_open_claw(
    root: &Path,
    endpoint: &str,
    authority: &Arc<AuthorityRoot>,
    input: &mut openclaw::driver::OpenClawInput,
) -> Result<Arc<dyn NativeVerifier>, NativeVerificationError> {
    let directory =
        CanonicalStateDir::provision_private(root.join("world-native")).map_err(failed)?;
    let instance = uuid::Uuid::new_v4().to_string();
    let mut key = Zeroizing::new(vec![0; 32]);
    getrandom::fill(&mut key).map_err(failed)?;
    let issuer = authority.native_proof_issuer(
        "openclaw".into(),
        instance.clone(),
        "matcha.world.openclaw.v1".into(),
    )?;
    let verifier =
        openclaw::world::Verifier::new(key.clone(), instance.clone(), issuer).map_err(failed)?;
    let projection =
        openclaw::world::WorldRuntimeHost::new(directory, endpoint.into(), instance, key)
            .map_err(failed)?;
    input.world_runtime_host = Some(projection);
    Ok(Arc::new(verifier))
}

fn prepare_matcha(
    root: &Path,
    endpoint: &str,
    authority: &Arc<AuthorityRoot>,
    input: &mut matcha_agent::driver::MatchaAgentInput,
) -> Result<Arc<dyn NativeVerifier>, NativeVerificationError> {
    let directory =
        CanonicalStateDir::provision_private(root.join("world-native")).map_err(failed)?;
    let instance = uuid::Uuid::new_v4().to_string();
    let mut key = Zeroizing::new(vec![0; 32]);
    getrandom::fill(&mut key).map_err(failed)?;
    let issuer = authority.native_proof_issuer(
        "matcha-agent".into(),
        instance.clone(),
        "matcha.world.matcha-agent.v1".into(),
    )?;
    let verifier = matcha_agent::world::Verifier::new(key.clone(), instance.clone(), issuer)
        .map_err(failed)?;
    let projection =
        matcha_agent::world::WorldRuntimeHost::new(directory, endpoint.into(), instance, key)
            .map_err(failed)?;
    input.world_runtime_host = Some(projection);
    Ok(Arc::new(verifier))
}

fn failed(cause: impl std::error::Error + Send + Sync + 'static) -> NativeVerificationError {
    NativeVerificationError::new(AuthorizationFailure::InternalFault, cause)
}
