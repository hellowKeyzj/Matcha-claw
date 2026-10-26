use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;
use world_protocol::{
    api::WorldStatus, authorization::{Actor, AccessScope}, commit::{CommitReceipt, WriteFence},
    compiler::{CompileRequest, CompileTarget}, definitions::Scope, failure::FailureStage, ids::*,
    package::TrustPolicy, releases::ReleaseHeadCas, time::Timestamp,
};

use crate::{
    authorization::{AccessGrant, AuthorityRoot, PrincipalRecord}, compiler::CompilationCache,
    content::Content, definitions::{self, DefinitionError},
    extensions::{bindings::{bootstrap_graph, genesis_graph}, package::initialize_trust_policy},
    releases::{self, PreparedArtifact}, store::{CommitRequest, TransactionError, WorldStore},
};
use super::{Error, head::{self, WorldHead}};

/// Trusted provisioning input. No serde/public route can manufacture root principals or grants.
pub struct Provision {
    pub world: WorldRef,
    pub commit_id: CommitId,
    pub storage_id: String,
    pub management_scope: Scope,
    pub principals: Vec<PrincipalRecord>,
    pub grants: Vec<InitialGrant>,
    pub genesis: Genesis,
    pub trust_policy: TrustPolicy,
    pub policies: Vec<crate::authorization::InitialPolicy>,
    pub retention_policies: Vec<crate::authorization::InitialRetention>,
    pub evaluation: Option<crate::authorization::InitialEvaluation>,
    pub maintenance: Option<crate::authorization::InitialMaintenance>,
}

#[derive(Serialize)]
pub struct Genesis {
    pub activation_lock_id: ActivationLockId,
    pub artifact_id: ArtifactId,
    pub release_id: ReleaseId,
    pub channel: ChannelId,
    pub config_digest: Digest,
}

#[derive(Serialize)]
pub struct InitialGrant {
    pub id: GrantId,
    pub actor: ActorId,
    pub access: Vec<AccessScope>,
    pub labels: Vec<String>,
    pub effects: Vec<world_protocol::expression::Effect>,
    pub expires_at: Option<Timestamp>,
}

#[derive(Serialize, Deserialize)]
pub struct Provisioned {
    pub head: WorldHead,
    pub commit: CommitReceipt,
}

pub(crate) struct PendingProvision {
    pub world: WorldRef,
    pub commit_id: CommitId,
    pub content: Arc<Content>,
    pub artifact: Arc<PreparedArtifact>,
}

pub(crate) struct ProvisionAttempt {
    pub result: Result<Provisioned, Error>,
    pub pending: Option<PendingProvision>,
}

pub(crate) async fn provision(
    store: &WorldStore, authority: Arc<AuthorityRoot>, content: Arc<Content>, input: Provision,
) -> ProvisionAttempt {
    match prepare(&authority, &content, &input) {
        Ok((batch, artifact)) => {
            let artifact = Arc::new(artifact);
            let pending = PendingProvision { world: input.world.clone(), commit_id: input.commit_id.clone(), content: content.clone(), artifact: artifact.clone() };
            let result = store.transact(batch, move |tx| Box::pin(async move {
                tx.require_provision()?;
                definitions::bootstrap_scope(tx, &authority, &input.management_scope).await.map_err(definition_error)?;
                for policy in &input.policies { authority.initialize_policy(tx, policy).await?; }
                for policy in &input.retention_policies { authority.initialize_retention(tx, policy).await?; }
                initialize_trust_policy(tx, &authority, &input.trust_policy).await?;
                let graph = bootstrap_graph(tx, &authority, input.genesis.activation_lock_id).await?;
                if graph.lock() != &artifact.request().activation_lock { return Err(Error::internal(FailureStage::Prepare)); }
                let release_head = ReleaseHeadCas { world: input.world.clone(), channel: input.genesis.channel,
                    expected: None, next: input.genesis.release_id };
                releases::bootstrap_release(tx, &authority, &content, &artifact, &release_head).await?;
                let world = tx.world();
                tx.execute("INSERT INTO world_runtime_head(tenant_id,world_id,generation,revision,status,management_scope_id,active_release_channel) VALUES($1,$2,1,1,'ready',$3,$4)",
                    &[&world.tenant_id.as_str(), &world.world_id.as_str(), &input.management_scope.id.as_str(), &release_head.channel.as_str()]).await?;
                for principal in &input.principals { authority.principal(tx, principal).await?; }
                for grant in &input.grants {
                    authority.grant(tx, &grant.id, &grant.actor, &AccessGrant {
                        access: grant.access.clone(), labels: grant.labels.clone(), effects: grant.effects.clone(),
                    }, grant.expires_at.as_ref()).await?;
                }
                let now = tx.now().await?;
                if let Some(evaluation) = &input.evaluation {
                    authority.initialize_evaluation(tx, evaluation, &now).await?;
                    let digest = crate::authorization::installation_digest(&input.world, evaluation,
                        &input.principals, &input.grants, &input.policies, &input.retention_policies)?;
                    crate::authorization::reserve_evaluation(tx, evaluation, &digest).await?;
                }
                if let Some(maintenance) = &input.maintenance { authority.initialize_maintenance(tx, maintenance, &now).await?; }
                let head = head::read(tx).await?;
                if head.status != WorldStatus::Ready || head.generation != Generation(1) || head.revision != Revision(1) {
                    return Err(Error::internal(FailureStage::Commit));
                }
                Ok::<_, Error>(head)
            })).await;
            match result {
                Ok(committed) => ProvisionAttempt { result: Ok(Provisioned { head: committed.value, commit: committed.receipt }), pending: None },
                Err(error @ TransactionError::NotCommitted { .. }) => {
                    let mut error = Error::from(error);
                    if let Err(cleanup) = releases::discard_artifact(&pending.content, &pending.artifact) {
                        error = error.with_related(cleanup.into());
                    }
                    ProvisionAttempt { result: Err(error), pending: None }
                }
                Err(TransactionError::Indeterminate(error)) => ProvisionAttempt { result: Err(error.into()), pending: Some(pending) },
            }
        }
        Err(error) => ProvisionAttempt { result: Err(error), pending: None },
    }
}

fn prepare(authority: &AuthorityRoot, content: &Content, input: &Provision) -> Result<(crate::store::PreparedBatch, PreparedArtifact), Error> {
    if input.world != input.management_scope.world || content.world() != &input.world || input.principals.is_empty() {
        return Err(world_protocol::authorization::AuthorizationFailure::InvalidPrincipal.into());
    }
    let principals: Vec<_> = input.principals.iter().map(|record| {
        let (kind, id) = match &record.actor { Actor::Human { id } => ("human", id), Actor::Service { id } => ("service", id) };
        (&record.issuer, &record.subject, kind, id, &record.expires_at)
    }).collect();
    let grants: Vec<_> = input.grants.iter().map(|grant| (&grant.id, &grant.actor, &grant.access, &grant.labels, &grant.effects, &grant.expires_at)).collect();
    let digest = definitions::canonical_digest(&(&input.world, &input.storage_id, &input.management_scope, principals, grants, &input.genesis, &input.trust_policy, &input.policies, &input.retention_policies, &input.evaluation, &input.maintenance))?;
    const DOMAINS: &[&str] = &["operation", "identity", "definitions", "facts", "content", "authorization", "packages", "bindings", "sources", "evaluation", "releases", "compiler", "query", "state", "abstraction", "generation", "learning"];
    let batch = CommitRequest {
        world: input.world.clone(), commit_id: input.commit_id.clone(), input_digest: digest,
        storage_epoch: WriterEpoch(1), fences: DOMAINS.iter().map(|domain| WriteFence {
            world: input.world.clone(), domain: WriterDomain::try_new(*domain).expect("fixed writer domain"), epoch: WriterEpoch(1),
        }).collect(), watch_basis: Vec::new(),
    }.prepare_provision(authority, input.storage_id.clone())?;
    let graph = genesis_graph(&input.world, input.genesis.activation_lock_id.clone())?;
    let request = CompileRequest {
        world: input.world.clone(), base_release: input.genesis.release_id.clone(), activation_lock: graph.lock().clone(),
        definitions: Vec::new(), scopes: vec![input.management_scope.clone()],
        targets: vec![CompileTarget::QueryPlan, CompileTarget::Validator, CompileTarget::ActionManifest, CompileTarget::ToolCatalog, CompileTarget::TypeScriptSdk, CompileTarget::RustSdk],
        external_contracts: Vec::new(), config_digest: input.genesis.config_digest.clone(),
    };
    let artifact = releases::prepare_artifact(content, &mut CompilationCache::default(), &request,
        input.genesis.artifact_id.clone(), input.genesis.release_id.clone(), &CancellationToken::new())?;
    Ok((batch, artifact))
}

fn definition_error(error: DefinitionError) -> Error {
    match error {
        DefinitionError::Store(error) => error.into(),
        DefinitionError::Codec(cause) => Error::internal(FailureStage::Prepare).caused(cause),
        DefinitionError::Compile(failure) => Error::new("world.provision.compile_rejected", FailureStage::Compile,
            "世界初始定义编译失败。", world_protocol::api::ApiFailure::Operation(world_protocol::operation::OperationFailure::Compile(failure)), world_protocol::failure::Recovery::None),
        DefinitionError::Rejected(failure) => failure.into(),
    }
}
