use serde::{Deserialize, Serialize};
use world_protocol::{
    api::ApiFailure,
    authorization::{AccessScope, Actor, AuthorizationFailure},
    expression::Effect,
    failure::{FailureStage, Recovery},
    ids::{ActorId, CommitId, GrantId, WorldRef, WriterDomain},
    time::Timestamp,
};

use super::{AccessGrant, AuthorityRoot, actor_id, decode, read::AuthorityRead};
use crate::{owner::Error, store::WorldTransaction};

/// Explicit root-only control input, never an ordinary World command or grant claim.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GrantRequest {
    pub world: WorldRef,
    pub commit_id: CommitId,
    pub id: GrantId,
    #[serde(deserialize_with = "deserialize_actor")]
    pub actor: Actor,
    pub access: Vec<AccessScope>,
    pub labels: Vec<String>,
    pub effects: Vec<Effect>,
    pub expires_at: Option<Timestamp>,
}

fn deserialize_actor<'de, D>(deserializer: D) -> Result<Actor, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
    enum Recipient {
        Human { id: ActorId },
        Service { id: ActorId },
    }
    Ok(match Recipient::deserialize(deserializer)? {
        Recipient::Human { id } => Actor::Human { id },
        Recipient::Service { id } => Actor::Service { id },
    })
}

pub(crate) async fn grant_access(
    tx: &WorldTransaction<'_>,
    root: &AuthorityRoot,
    request: &GrantRequest,
    now: &Timestamp,
) -> Result<(), Error> {
    tx.require_domain(&WriterDomain::try_new("authorization").expect("fixed domain"))?;
    if tx.world() != &request.world || tx.commit_id() != &request.commit_id {
        return Err(AuthorizationFailure::RequestDigestMismatch.into());
    }
    if request
        .access
        .iter()
        .any(|access| access.resources.is_empty())
    {
        return Err(AuthorizationFailure::InsufficientScope.into());
    }
    if request
        .expires_at
        .as_ref()
        .is_some_and(|expires| expires <= now)
    {
        return Err(AuthorizationFailure::DeadlineExpired.into());
    }
    let grant = AccessGrant {
        access: request.access.clone(),
        labels: request.labels.clone(),
        effects: request.effects.clone(),
    };
    super::authority::validate_grant(&grant, tx.world())?;
    for access in &grant.access {
        super::policies::require_scope(tx, &access.scope).await?;
    }
    super::authority::lock(tx).await?;
    let mut principal_expiry = now.clone();
    AuthorityRead::Transaction(tx)
        .represented(&request.actor, now, &mut principal_expiry)
        .await?;
    let world = tx.world();
    let current = tx.query_opt(
        "SELECT actor_id,\"grant\",active,expires_at IS NOT DISTINCT FROM $4::text::timestamptz AS same_expiry FROM world_auth_grant WHERE tenant_id=$1 AND world_id=$2 AND grant_id=$3 FOR UPDATE",
        &[&world.tenant_id.as_str(), &world.world_id.as_str(), &request.id.as_str(), &request.expires_at.as_ref().map(Timestamp::as_str)],
    ).await?;
    if let Some(current) = current {
        if current.get::<_, String>("actor_id") != actor_id(&request.actor).as_str()
            || decode::<AccessGrant>(current.get("grant"))? != grant
            || !current.get::<_, bool>("same_expiry")
        {
            return Err(Error::new(
                "world.grant_conflict",
                FailureStage::Commit,
                "授权标识已绑定其他内容，请核对原授权。",
                ApiFailure::RevisionConflict,
                Recovery::Refresh,
            ));
        }
        if !current.get::<_, bool>("active") {
            return Err(AuthorizationFailure::Revoked.into());
        }
        return Ok(());
    }
    root.grant(
        tx,
        &request.id,
        actor_id(&request.actor),
        &grant,
        request.expires_at.as_ref(),
    )
    .await?;
    Ok(())
}
